// @vitest-environment node
//
// The logger's own doctrine, tested where it used to break: nothing in the serializer throws
// (a BigInt, a cycle, a throwing getter or toJSON, a throwing `stack`), the pretty face is
// bounded and byte-clean (a cyclic error-shaped field, ANSI in a value), redaction reaches the
// keys applications actually log (nested, differently cased, inherited), a throwing sink cannot
// reach the caller, and log files are created for their owner only.

import { describe, it, expect } from 'vitest';
import { statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, ndjsonLine, prettySink } from '@azerothjs/logger';
import { fileStream } from '@azerothjs/logger/node';
import type { LogRecord, WritableLike } from '@azerothjs/logger';

const ESC = String.fromCharCode(27);

function capture(isTTY = false): { stream: WritableLike; lines: () => string[]; raw: () => string }
{
    let buffer = '';
    return {
        stream: {
            isTTY,
            write: (chunk: string): boolean =>
            {
                buffer += chunk;
                return true;
            }
        },
        lines: () => buffer.split('\n').filter((line) => line !== ''),
        raw: () => buffer
    };
}

/** One field through the fused NDJSON path - the one with no sink guard in front of it. */
function emitted(fields: Record<string, unknown>): { line: string; parsed: Record<string, unknown> }
{
    const out = capture();
    const log = createLogger({ level: 'info', stream: out.stream });
    log.info('event', fields);
    const line = out.lines()[0] ?? '';
    return { line, parsed: JSON.parse(line === '' ? '{}' : line) as Record<string, unknown> };
}

describe('nothing in the serializer throws', () =>
{
    it('a BigInt field logs its digits instead of throwing out of the log call', () =>
    {
        const out = capture();
        const log = createLogger({ level: 'info', stream: out.stream });
        expect(() => log.info('paid', { amount: 10n })).not.toThrow();
        expect(out.lines()).toHaveLength(1);
        expect((JSON.parse(out.lines()[0] ?? '{}') as { amount?: unknown }).amount).toBe('10');
    });

    it('a NESTED BigInt survives too', () =>
    {
        const { parsed } = emitted({ order: { amount: 10n, currency: 'IRR' } });
        expect(parsed.order).toEqual({ amount: '10', currency: 'IRR' });
    });

    it('a circular structure degrades to a marker', () =>
    {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        const { parsed } = emitted({ data: circular });
        expect(parsed.data).toBe('[unserializable]');
    });

    it('a throwing getter and a throwing toJSON degrade to a marker', () =>
    {
        const throwingGetter = {
            get boom(): string
            {
                throw new Error('getter down');
            }
        };
        const throwingToJson = {
            toJSON(): never
            {
                throw new Error('toJSON down');
            }
        };
        expect(emitted({ a: throwingGetter }).parsed.a).toBe('[unserializable]');
        expect(emitted({ b: throwingToJson }).parsed.b).toBe('[unserializable]');
    });

    it('an Error whose stack getter throws still logs its name and message', () =>
    {
        const error = new Error('boom');
        Object.defineProperty(error, 'stack', {
            get(): string
            {
                throw new Error('no stack for you');
            }
        });
        const { parsed } = emitted({ error });
        expect(parsed.error).toEqual({ name: 'Error', message: 'boom' });
    });

    it('an Error whose cause carries a BigInt still logs the cause', () =>
    {
        const { parsed } = emitted({ error: new Error('charge failed', { cause: { amount: 1n } }) });
        expect((parsed.error as { cause?: unknown }).cause).toBe('{"amount":"1"}');
    });
});

describe('the pretty face is bounded and byte-clean', () =>
{
    it('a cyclic error-shaped field is bounded instead of eating the heap', () =>
    {
        const shape: Record<string, unknown> = { name: 'Boom', message: 'cycle', stack: 'Boom: cycle\n    at x (/src/a.ts:1:1)' };
        shape.cause = shape; // a PLAIN object: errorShape's depth cap never saw it
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });

        const startedAt = performance.now();
        sink({ level: 'error', message: 'boom', time: 0, fields: { err: shape } });

        expect(performance.now() - startedAt).toBeLessThan(1000);
        expect(out.raw().length).toBeLessThan(4000);
        expect((out.raw().match(/caused by:/g) ?? []).length).toBeLessThanOrEqual(5);
    });

    it('a long cause chain stops at the serializer\'s depth', () =>
    {
        let shape: Record<string, unknown> = { name: 'Root', message: 'root', stack: 'Root: root' };
        for (let depth = 0; depth < 40; depth++)
        {
            shape = { name: `Wrap${ depth }`, message: 'wrap', stack: 'Wrap', cause: shape };
        }
        const out = capture(true);
        prettySink({ stream: out.stream, tier: 'none', unicode: true })(
            { level: 'error', message: 'deep', time: 0, fields: { err: shape } });
        expect((out.raw().match(/caused by:/g) ?? []).length).toBe(5);
    });

    it('strips terminal control bytes from field values', () =>
    {
        const out = capture(true);
        prettySink({ stream: out.stream, tier: 'none', unicode: true })(
            { level: 'info', message: 'note', time: 0, fields: { comment: `${ ESC }[2J${ ESC }[1;1Howned` } });
        expect(out.raw()).not.toContain(ESC);
        expect(out.raw()).toContain('[2J[1;1Howned');
    });

    it('strips them from the message and from the request sentence', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });
        sink({ level: 'error', message: `failed${ ESC }[2J`, time: 0, fields: {} });
        sink({
            level: 'info',
            message: 'request',
            time: 0,
            fields: { method: 'GET', path: `/x${ ESC }[2J`, status: 200, durationMs: 1 }
        });
        expect(out.raw()).not.toContain(ESC);
        expect(out.raw()).toContain('GET /x[2J');
    });

    it('strips them from an error block too', () =>
    {
        const out = capture(true);
        prettySink({ stream: out.stream, tier: 'none', unicode: true })({
            level: 'error',
            message: 'failed',
            time: 0,
            fields: { err: { name: 'Error', message: `bad${ ESC }[2J`, cause: `deeper${ ESC }[2J` } }
        });
        expect(out.raw()).not.toContain(ESC);
    });

    it('renders an unserializable structure instead of throwing', () =>
    {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });
        expect(() => sink({ level: 'info', message: 'x', time: 0, fields: { data: circular } })).not.toThrow();
        expect(out.raw()).toContain('data=[unserializable]');
    });
});

describe('redaction covers what applications actually log', () =>
{
    function record(options: { redact: string[]; fields: Record<string, unknown> }): Record<string, unknown>
    {
        const records: LogRecord[] = [];
        createLogger({ level: 'info', redact: options.redact, sink: (r) => records.push(r) }).info('req', options.fields);
        return records[0]?.fields ?? {};
    }

    it('matches the canonical HTTP casing', () =>
    {
        expect(record({ redact: ['authorization'], fields: { Authorization: 'Bearer secret' } }))
            .toEqual({ Authorization: '[redacted]' });
        expect(record({ redact: ['Cookie'], fields: { cookie: 'session=abc' } }))
            .toEqual({ cookie: '[redacted]' });
    });

    it('descends into a nested object for a bare name - `{ headers: req.headers }`', () =>
    {
        const fields = record({
            redact: ['authorization', 'cookie'],
            fields: { headers: { Authorization: 'Bearer secret', accept: 'application/json' }, path: '/x' }
        });
        expect(fields).toEqual({ headers: { Authorization: '[redacted]', accept: 'application/json' }, path: '/x' });
    });

    it('a dotted path matches that position only', () =>
    {
        const fields = record({
            redact: ['user.password'],
            fields: { user: { name: 'jaina', password: 'hunter2' }, password: 'top level stays' }
        });
        expect(fields).toEqual({ user: { name: 'jaina', password: '[redacted]' }, password: 'top level stays' });
    });

    it('an array is transparent to a path', () =>
    {
        const fields = record({
            redact: ['items.token'],
            fields: { items: [{ id: 1, token: 'a' }, { id: 2, token: 'b' }] }
        });
        expect(fields).toEqual({ items: [{ id: 1, token: '[redacted]' }, { id: 2, token: '[redacted]' }] });
    });

    it('never mutates the application\'s own object', () =>
    {
        const headers = { authorization: 'Bearer secret' };
        const fields = record({ redact: ['authorization'], fields: { headers } });
        expect(headers.authorization).toBe('Bearer secret');
        expect((fields.headers as { authorization: string }).authorization).toBe('[redacted]');
    });

    it('an INHERITED field key never reaches the line', () =>
    {
        const fields: Record<string, unknown> = Object.create({ authorization: 'Bearer inherited' }) as Record<string, unknown>;
        fields.path = '/x';
        const out = capture();
        createLogger({ level: 'info', redact: ['authorization'], stream: out.stream }).info('req', fields);
        expect(out.raw()).not.toContain('Bearer inherited');
        expect(JSON.parse(out.lines()[0] ?? '{}')).toMatchObject({ msg: 'req', path: '/x' });
    });

    it('a cyclic fields object does not hang the walk', () =>
    {
        const nested: Record<string, unknown> = { token: 'secret' };
        nested.self = nested;
        const fields = record({ redact: ['token'], fields: { nested } });
        expect((fields.nested as { token: string }).token).toBe('[redacted]');
    });

    it('a deep structure with nothing configured passes through untouched', () =>
    {
        const deep = { a: { b: { c: 1 } } };
        const records: LogRecord[] = [];
        createLogger({ level: 'info', sink: (r) => records.push(r) }).info('x', { deep });
        expect(records[0]?.fields.deep).toBe(deep);
    });
});

describe('a throwing sink', () =>
{
    it('cannot break the log call', () =>
    {
        const log = createLogger({
            level: 'info',
            sink: () =>
            {
                throw new Error('sink down');
            }
        });
        expect(() => log.info('still fine')).not.toThrow();
        expect(() => log.child({ requestId: 'r1' }).error('still fine')).not.toThrow();
    });

    it('the NDJSON line itself is unaffected by any of this', () =>
    {
        const line = ndjsonLine({ level: 'info', message: 'm', time: 1, fields: { a: 1, b: 'two' } });
        expect(JSON.parse(line)).toEqual({ level: 'info', time: 1, msg: 'm', a: 1, b: 'two' });
    });
});

describe('log file permissions', () =>
{
    // POSIX modes only: Windows has no equivalent bits, so the assertion is skipped there
    // rather than made meaningless.
    it.skipIf(process.platform === 'win32')('creates the folder for its owner only, and the file 0600', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'azeroth-log-mode-'));
        try
        {
            const stream = fileStream(join(dir, 'logs') + '/');
            stream.write('{"a":1}\n');
            stream.flush();
            const filePath = stream.path;
            stream.close();
            expect(statSync(join(dir, 'logs')).mode & 0o777).toBe(0o700);
            expect(statSync(filePath).mode & 0o777).toBe(0o600);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32')('honors an explicit mode', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'azeroth-log-mode-'));
        try
        {
            const stream = fileStream(join(dir, 'nested', 'out.ndjson'), { mode: 0o640, dirMode: 0o750 });
            stream.write('{"a":1}\n');
            stream.flush();
            stream.close();
            expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o750);
            expect(statSync(join(dir, 'nested', 'out.ndjson')).mode & 0o777).toBe(0o640);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
