// @vitest-environment node
//
// The file persistence layer: byte-exact NDJSON on disk, batch flushing on every
// trigger (size, timer, explicit, process exit), rename-free rotation (day + size),
// retention pruning, and the never-breaks-the-system failure policy - drops counted,
// announced in-band, one stderr notice, no throw ever reaching the application.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../src/logger.ts';
import { fileStream, fileSink, teeSink } from '../src/file.ts';
import type { LogRecord } from '../src/record.ts';

const roots: string[] = [];
function root(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'azeroth-log-'));
    roots.push(dir);
    return dir;
}
afterEach(() =>
{
    vi.restoreAllMocks();
    while (roots.length > 0)
    {
        rmSync(roots.pop() ?? '', { recursive: true, force: true });
    }
});

function lines(path: string): string[]
{
    return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
}

describe('single-file mode', () =>
{
    it('appends byte-exact lines on flush and keeps appending across flushes', () =>
    {
        const path = join(root(), 'out.ndjson');
        const stream = fileStream(path);
        stream.write('{"n":1}\n');
        stream.write('{"n":2}\n');
        stream.flush();
        stream.write('{"n":3}\n');
        stream.close();
        expect(readFileSync(path, 'utf8')).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    });

    it('flushes by itself when the buffer crosses maxBufferBytes', () =>
    {
        const path = join(root(), 'out.ndjson');
        const stream = fileStream(path, { maxBufferBytes: 16 });
        stream.write('{"first":true}\n');
        stream.write('x\n');
        expect(lines(path).length).toBeGreaterThan(0);
        stream.close();
    });

    it('flushes on the timer without any further writes', async () =>
    {
        const path = join(root(), 'out.ndjson');
        const stream = fileStream(path, { flushMs: 25 });
        stream.write('{"timed":true}\n');
        await sleep(150);
        expect(lines(path)).toEqual(['{"timed":true}']);
        stream.close();
    });

    it('never rotates - a plain file target appends forever', () =>
    {
        const path = join(root(), 'out.ndjson');
        const stream = fileStream(path, { maxFileBytes: 8 });
        stream.write('{"a":1}\n{"b":2}\n{"c":3}\n');
        stream.close();
        expect(lines(path)).toHaveLength(3);
        expect(readdirSync(join(path, '..'))).toHaveLength(1);
    });
});

describe('folder mode: rename-free rotation', () =>
{
    it('names files by UTC day and switches at the day boundary (injectable clock)', () =>
    {
        const dir = root();
        let now = Date.UTC(2026, 6, 21, 23, 59, 0);
        const stream = fileStream(dir, { clock: () => now });
        stream.write('{"day":1}\n');
        stream.flush();
        now = Date.UTC(2026, 6, 22, 0, 1, 0);
        stream.write('{"day":2}\n');
        stream.close();
        expect(lines(join(dir, 'app-2026-07-21.ndjson'))).toEqual(['{"day":1}']);
        expect(lines(join(dir, 'app-2026-07-22.ndjson'))).toEqual(['{"day":2}']);
    });

    it('rotates to a numbered sibling at the size cap - the full file is never renamed', () =>
    {
        const dir = root();
        const clock = (): number => Date.UTC(2026, 6, 21, 12, 0, 0);
        const stream = fileStream(dir, { clock, maxFileBytes: 24 });
        stream.write('{"batch":1,"pad":"xxxx"}\n');
        stream.flush();
        stream.write('{"batch":2,"pad":"xxxx"}\n');
        stream.close();
        expect(lines(join(dir, 'app-2026-07-21.ndjson'))).toEqual(['{"batch":1,"pad":"xxxx"}']);
        expect(lines(join(dir, 'app-2026-07-21.2.ndjson'))).toEqual(['{"batch":2,"pad":"xxxx"}']);
    });

    it('prunes oldest-first down to maxFiles', () =>
    {
        const dir = root();
        const clock = (): number => Date.UTC(2026, 6, 21, 12, 0, 0);
        const stream = fileStream(dir, { clock, maxFileBytes: 12, maxFiles: 2 });
        for (let i = 0; i < 4; i++)
        {
            stream.write(`{"n":${ String(i) },"pad":"xx"}\n`);
            stream.flush();
        }
        stream.close();
        const kept = readdirSync(dir).sort();
        expect(kept).toHaveLength(2);
        expect(kept).toContain('app-2026-07-21.4.ndjson');
        expect(kept).not.toContain('app-2026-07-21.ndjson');
    });

    it('respects a custom base name', () =>
    {
        const dir = root();
        const stream = fileStream(dir, { name: 'api', clock: () => Date.UTC(2026, 6, 21) });
        stream.write('{"named":true}\n');
        stream.close();
        expect(existsSync(join(dir, 'api-2026-07-21.ndjson'))).toBe(true);
    });
});

describe('failure policy: logging never breaks the system', () =>
{
    it('a jammed target drops the batch, counts it, warns stderr ONCE, and never throws', () =>
    {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const dir = root();
        // A FILE occupies the parent-directory slot, so the target can never be created.
        // (An existing directory at the target is not a jam - that selects folder mode.)
        writeFileSync(join(dir, 'occupied'), 'a file, not a directory');
        const stream = fileStream(join(dir, 'occupied', 'out.ndjson'));
        stream.write('{"a":1}\n');
        expect(() => stream.flush()).not.toThrow();
        stream.write('{"b":2}\n');
        expect(() => stream.flush()).not.toThrow();
        expect(stream.dropped).toBe(2);
        expect(stderr).toHaveBeenCalledTimes(1);
        stream.close();
    });

    it('the buffer cap drops new lines and a recovery flush announces the count in-band', () =>
    {
        const path = join(root(), 'out.ndjson');
        const stream = fileStream(path, { maxBufferBytes: 1 << 30, maxPendingBytes: 10 });
        stream.write('{"kept":1}\n');    // fills past the 10-byte cap
        stream.write('{"lost":1}\n');    // dropped
        stream.write('{"lost":2}\n');    // dropped
        expect(stream.dropped).toBe(2);
        stream.flush();
        stream.close();
        const content = lines(path);
        expect(content[0]).toBe('{"kept":1}');
        expect(content[1]).toContain('"msg":"log lines dropped by file sink"');
        expect(content[1]).toContain('"dropped":2');
    });

    it('writes after close are dropped, not thrown', () =>
    {
        const path = join(root(), 'out.ndjson');
        const stream = fileStream(path);
        stream.write('{"a":1}\n');
        stream.close();
        expect(stream.write('{"late":true}\n')).toBe(false);
        expect(lines(path)).toEqual(['{"a":1}']);
    });
});

describe('composition', () =>
{
    const record = (message: string): LogRecord => ({ level: 'info', message, time: 1_700_000_000_000, fields: {} });

    it('teeSink isolates a throwing sink - the others still receive the record', () =>
    {
        const seen: string[] = [];
        const tee = teeSink(
            () =>
            {
                throw new Error('broken destination');
            },
            (r) =>
            {
                seen.push(r.message);
            }
        );
        expect(() => tee(record('survives'))).not.toThrow();
        expect(seen).toEqual(['survives']);
    });

    it('fileSink writes NDJSON records and exposes flush/close/dropped', () =>
    {
        const path = join(root(), 'out.ndjson');
        const sink = fileSink(path);
        sink(record('hello'));
        sink.flush();
        const [line] = lines(path);
        expect(JSON.parse(line ?? '')).toMatchObject({ level: 'info', msg: 'hello' });
        sink.close();
        expect(sink.dropped).toBe(0);
    });

    it('fileSink.dropped is a LIVE getter mirroring the stream, not a snapshot copied at build time', () =>
    {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const dir = root();
        writeFileSync(join(dir, 'occupied'), 'a file blocking the parent slot');
        const sink = fileSink(join(dir, 'occupied', 'out.ndjson'));
        sink(record('will be dropped'));
        sink.flush(); // the write fails; the STREAM counts the drop
        expect(sink.stream.dropped).toBe(1);
        expect(sink.dropped).toBe(1);
        sink.close();
        expect(stderr).toHaveBeenCalled();
    });

    it('rides the fused fast path: createLogger({ stream }) + child yields clean NDJSON, zero ANSI', () =>
    {
        const path = join(root(), 'out.ndjson');
        const stream = fileStream(path);
        const log = createLogger({ stream, fields: { service: 'test' } });
        log.child({ requestId: 'r-1' }).info('served', { status: 200 });
        stream.close();
        const [line] = lines(path);
        const parsed = JSON.parse(line ?? '') as Record<string, unknown>;
        expect(parsed).toMatchObject({ level: 'info', msg: 'served', service: 'test', requestId: 'r-1', status: 200 });
        expect(line).not.toContain(String.fromCharCode(27));
    });
});

describe('crash safety', () =>
{
    // Spawns a real node child compiling the src natively (~1s solo); under the fully
    // parallel suite the 5s default can flake on a loaded machine - same class and same
    // medicine as language-server's tsc.spec.
    it('buffered lines land on process exit without an explicit flush (the exit tail-write)', { timeout: 30_000 }, () =>
    {
        const path = join(root(), 'exit.ndjson');
        const entry = pathToFileURL(join(import.meta.dirname, '..', 'src', 'index.ts')).href;
        const script = `
            const { createLogger, fileStream } = await import(${ JSON.stringify(entry) });
            const log = createLogger({ stream: fileStream(${ JSON.stringify(path) }) });
            log.info('one'); log.info('two'); log.info('three');
            process.exit(0); // no flush, no close - the exit hook must save these
        `;
        execFileSync(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'pipe' });
        expect(lines(path)).toHaveLength(3);
    });
});
