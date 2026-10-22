// @vitest-environment node
//
// Redaction reads each value a rule reaches as JSON writes it, and a field it cannot finish is
// written as [unserializable]; an error field keeps its shape, and no field makes a log call throw.
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { inspect } from 'node:util';
import { createLogger, createRedactor, errorShape, ndjsonLine, shapeFields } from '@azerothjs/logger';
import type { ErrorShape, Logger, LoggerOptions, LogRecord, Redactor, WritableLike } from '@azerothjs/logger';

/** The faces a line is written on: a sink via ndjsonLine, the fused stream and the pretty face. */
const FACES = ['sink', 'fused', 'pretty'] as const;

type Face = typeof FACES[number];

/** The text one face writes for `act`, time stamps removed. */
function written(face: Face, options: LoggerOptions, act: (log: Logger) => void): string
{
    let buffer = '';
    const stream: WritableLike = {
        isTTY: false,
        write: (chunk: string): boolean =>
        {
            buffer += chunk;
            return true;
        }
    };
    const log = face === 'sink'
        ? createLogger({ ...options, sink: (record) => stream.write(ndjsonLine(record)) })
        : createLogger({ ...options, face: face === 'fused' ? 'ndjson' : 'pretty', stream });
    act(log);
    return buffer.replace(/"time":\d+,/g, '');
}

/** The NDJSON line `log.info('m', value)` writes under `redact`, without its time. */
function line(redact: string[] | undefined, value: Record<string, unknown>): string
{
    return written('sink', { redact }, (log) => log.info('m', value)).trimEnd();
}

/** What that line should be: JSON.stringify of `expected` behind the record's own keys. */
function lineOf(expected: Record<string, unknown>): string
{
    return '{"level":"info","msg":"m",' + JSON.stringify(expected).slice(1);
}

/** The fields of the one record a sink received. */
function recorded(options: LoggerOptions, act: (log: Logger) => void): Record<string, unknown>
{
    const records: LogRecord[] = [];
    act(createLogger({ ...options, sink: (record) => records.push(record) }));
    return records[0]?.fields ?? {};
}

/** The logger's source as a module specifier, for a script run in a fresh Node process. */
const SOURCE = JSON.stringify(new URL('../src/index.ts', import.meta.url).href);

/** What `script` prints when run as a module in a fresh Node process started with `flags`. */
function inNode(flags: string[], script: string[]): string
{
    return execFileSync(process.execPath, [...flags, '--input-type=module', '-e', script.join('\n')], { encoding: 'utf8' });
}

/** Throws, as a getter, a toJSON or a trap over a closed resource does. */
function boom(): never
{
    throw new Error('boom');
}

/** `base` with an enumerable `key` whose getter throws. */
function throwingGetter<T extends object>(base: T, key: string): T
{
    return Object.defineProperty(base, key, { enumerable: true, get: boom });
}

/** A toJSON that returns the object it is called on. */
function returnsItself(this: unknown): unknown
{
    return this;
}

/** The first of `size` chained nodes whose toJSON writes a parent as a stub naming its own. */
function stubChain(size: number): Record<string, unknown>
{
    const nodes = Array.from({ length: size }, (_, id): Record<string, unknown> => ({ id }));
    for (const [id, node] of nodes.entries())
    {
        Object.assign(node, { parent: nodes[id - 1], child: nodes[id + 1] });
        node.toJSON = function (this: Record<string, unknown>, key: string): unknown
        {
            return key === 'parent' ? { id: this.id, parent: this.parent } : { id: this.id, parent: this.parent, child: this.child };
        };
    }
    return nodes[0] as Record<string, unknown>;
}

class Account
{
    public user = 'ada';

    public password = 'SECRET-CLASS';
}

/** An error as a client library builds one: data beside its message, and a toJSON of its own. */
function clientError(): Error
{
    const error = new Error('Request failed with status code 402');
    return Object.assign(error, {
        config: { url: 'https://pay.example/charge', headers: { authorization: 'Bearer SECRET-AUTH' }, data: '{"card":"SECRET-CARD"}' },
        code: 'ERR_BAD_REQUEST',
        toJSON(): Record<string, unknown>
        {
            return { message: error.message, name: error.name, stack: error.stack, config: (error as { config?: unknown }).config, code: 'ERR_BAD_REQUEST' };
        }
    });
}

describe('a fields object is read as JSON reads it', () =>
{
    const carrier = (): Record<string, unknown> => ({ id: 1, secret: 'SECRET-OWN', toJSON: () => ({ id: 1 }) });

    it('a toJSON on the call fields, the bindings or createLogger fields is honoured on every face, with no rule', () =>
    {
        for (const face of FACES)
        {
            const call = written(face, {}, (log) => log.info('m', carrier()));
            const bound = written(face, {}, (log) => log.child(carrier()).info('m'));
            const created = written(face, { fields: carrier() }, (log) => log.info('m'));
            for (const text of [call, bound, created])
            {
                expect(text, face).not.toContain('SECRET-OWN');
                expect(text, face).toMatch(/id/);
            }
        }
    });

    it('asks the bindings toJSON once per child(), not per line', () =>
    {
        const toJSON = vi.fn(() => ({ id: 1 }));
        for (const face of ['sink', 'fused'] as const)
        {
            toJSON.mockClear();
            written(face, {}, (log) =>
            {
                const child = log.child({ toJSON });
                child.info('a');
                child.info('b');
                child.info('c');
            });
            expect(toJSON, face).toHaveBeenCalledTimes(1);
        }
    });

    it('a form that is not a key/value object is carried under fields; a missing argument logs no fields', () =>
    {
        const asFields = (value: unknown): Record<string, unknown> => recorded({}, (log) => log.info('m', value as Record<string, unknown>));
        expect(asFields({ toJSON: () => 'text' })).toEqual({ fields: 'text' });
        expect(asFields({ toJSON: () => [1, 2] })).toEqual({ fields: [1, 2] });
        expect(asFields({ toJSON: () => undefined })).toEqual({});
        expect(asFields(null)).toEqual({});
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        expect(asFields(proxy)).toEqual({ fields: '[unserializable]' });
        expect(asFields({ toJSON: boom })).toEqual({ fields: '[unserializable]' });
        expect(recorded({ fields: { service: 's' } }, (log) => log.child(undefined as unknown as Record<string, unknown>).info('m'))).toEqual({ service: 's' });
        for (const face of FACES)
        {
            expect(() => written(face, {}, (log) => log.info('m', null as unknown as Record<string, unknown>)), face).not.toThrow();
        }
    });
});

describe('a rule reaches every value as JSON writes it', () =>
{
    it('a class instance, a toJSON result and a key at any depth', () =>
    {
        expect(line(['password'], { account: new Account() })).toBe(lineOf({ account: { user: 'ada', password: '[redacted]' } }));
        const carrier = { id: 1, toJSON: () => ({ id: 1, password: 'SECRET-FORM' }) };
        expect(line(['password'], { holder: carrier })).toBe(lineOf({ holder: { id: 1, password: '[redacted]' } }));
        let deep: Record<string, unknown> = { password: 'SECRET-DEEP' };
        let expected: Record<string, unknown> = { password: '[redacted]' };
        for (let level = 0; level < 8; level++)
        {
            deep = { next: deep };
            expected = { next: expected };
        }
        expect(line(['password'], { tree: deep })).toBe(lineOf({ tree: expected }));
    });

    it('a value 4000 levels deep is walked to the end, and one past 4096 levels is given up', () =>
    {
        const chain = (levels: number): Record<string, unknown> =>
        {
            let deep: Record<string, unknown> = { password: 'SECRET-DEEPEST' };
            for (let level = 0; level < levels; level++)
            {
                deep = { next: deep };
            }
            return deep;
        };
        // The record is read, not the line: JSON.stringify on Node 22 stops near 1700 levels.
        const fields = recorded({ redact: ['password'] }, (log) => log.info('m', { tree: chain(4000), keep: 1 }));
        let node = fields.tree as Record<string, unknown>;
        let walked = 0;
        while ('next' in node)
        {
            node = node.next as Record<string, unknown>;
            walked++;
        }
        expect({ walked, leaf: node.password, keep: fields.keep }).toEqual({ walked: 4000, leaf: '[redacted]', keep: 1 });
        expect(line(['password'], { tree: chain(5000), keep: 1 })).toBe(lineOf({ tree: '[unserializable]', keep: 1 }));
    });

    it('a value 4000 levels deep is redacted with little stack left', () =>
    {
        const out = inNode(['--stack-size=200'], [
            `const L = await import(${ SOURCE });`,
            'let fields;',
            'const log = L.createLogger({ redact: [\'password\'], sink: (record) => { fields = record.fields; } });',
            'let deep = { password: \'SECRET-DEEPEST\' };',
            'for (let level = 0; level < 4000; level++) { deep = { next: deep }; }',
            'log.info(\'m\', { tree: deep });',
            'let node = fields.tree;',
            'let walked = 0;',
            'while (typeof node === \'object\' && \'next\' in node) { node = node.next; walked++; }',
            'process.stdout.write(JSON.stringify({ walked, leaf: node.password ?? node }));'
        ]);
        expect(JSON.parse(out)).toEqual({ walked: 4000, leaf: '[redacted]' });
    });

    it('a field of more than 1048576 objects, a shared one counted on each path, is given up quickly', () =>
    {
        const ladder = (levels: number): Record<string, unknown> =>
        {
            let graph: Record<string, unknown> = { password: 'SECRET-SHARED' };
            for (let level = 1; level <= levels; level++)
            {
                graph = { level, a: graph, b: graph };
            }
            return graph;
        };
        const started = performance.now();
        expect(recorded({ redact: ['password'] }, (log) => log.info('m', { graph: ladder(24), keep: 1 }))).toEqual({ graph: '[unserializable]', keep: 1 });
        expect(performance.now() - started).toBeLessThan(5000);
        let copy = recorded({ redact: ['password'] }, (log) => log.info('m', { graph: ladder(12) })).graph as Record<string, unknown>;
        while ('a' in copy)
        {
            copy = copy.a as Record<string, unknown>;
        }
        expect(copy).toEqual({ password: '[redacted]' });
        let calls = 0;
        let carrier: object = { password: 'SECRET-FORM' };
        for (let level = 1; level <= 24; level++)
        {
            const child = carrier;
            carrier = { toJSON: (): unknown => ({ level, a: child, b: child, n: ++calls }) };
        }
        expect(line(['password'], { carrier })).toBe(lineOf({ carrier: '[unserializable]' }));
        expect(calls).toBeLessThanOrEqual(1048577);
        const rows = Array.from({ length: 1048577 }, () => ({}));
        expect(recorded({ redact: ['zzz'] }, (log) => log.info('m', { rows }))).toEqual({ rows: '[unserializable]' });
        expect(recorded({}, (log) => log.info('m', { rows })).rows).toBe(rows);
        const left = Array.from({ length: 600000 }, () => ({}));
        const right = Array.from({ length: 600000 }, () => ({}));
        const both = recorded({ redact: ['zzz'] }, (log) => log.info('m', { left, right }));
        expect(both.left).toBe(left);
        expect(both.right).toBe(right);
    });

    it('a field logged while another field is read has its own budget and its own path', () =>
    {
        const records: LogRecord[] = [];
        const log = createLogger({ redact: ['zzz'], sink: (record) => records.push(record) });
        // A field logged from a getter has its own budget, and the outer field keeps its count.
        const leaf = {};
        const small = Array.from({ length: 1000 }, () => leaf);
        const outer: object[] = Array.from({ length: 1048000 }, () => leaf);
        outer.push(Object.defineProperty({}, 'v', { enumerable: true, get: (): number => (log.info('inner', { small }), 1) }), ...small);
        log.info('outer', { outer });
        expect(records[0]?.fields.small).toBe(small);
        expect(records[1]?.fields.outer).toBe('[unserializable]');
        // After a nested call a back-edge to the field's own object is found at its first read.
        let reads = 0;
        const node: Record<string, unknown> = Object.defineProperty({}, 'log', { enumerable: true, get: (): number => (log.info('inner', { leaf }), 1) });
        Object.defineProperty(node, 'back', { enumerable: true, get: (): unknown => (++reads, node) });
        records.length = 0;
        log.info('outer', { node });
        expect({ reads, lines: records.length, node: records[1]?.fields.node }).toEqual({ reads: 1, lines: 2, node: '[unserializable]' });
        // A nested field holding an object on the outer path is no cycle.
        let calls = 0;
        const shared: Record<string, unknown> = Object.defineProperty({}, 'g', {
            enumerable: true,
            get: (): number =>
            {
                if (++calls === 1)
                {
                    log.info('inner', { shared });
                }
                return 1;
            }
        });
        records.length = 0;
        log.info('outer', { node: { shared } });
        expect(records[0]?.fields.shared).toBe(shared);
    });

    it('a cycle is given up at its first back-edge, near the field and deep below it', () =>
    {
        // The back-edge meets the field's own object, or one past the frames the path scan reads.
        for (const [depth, target] of [[1, 0], [40, 0], [40, 36]] as const)
        {
            let reads = 0;
            const nodes: Record<string, unknown>[] = [{}];
            for (let level = 1; level < depth; level++)
            {
                const next: Record<string, unknown> = {};
                (nodes[level - 1] as Record<string, unknown>).next = next;
                nodes.push(next);
            }
            Object.defineProperty(nodes[depth - 1], 'back', { enumerable: true, get: (): unknown => (++reads, nodes[target]) });
            expect(recorded({ redact: ['password'] }, (log) => log.info('m', { head: nodes[0], keep: 1 })), String(depth)).toEqual({ head: '[unserializable]', keep: 1 });
            expect(reads, `${ depth } ${ target }`).toBe(1);
        }
    });

    it('objects past the scanned frames leave the path when their walk ends or is given up', () =>
    {
        const nodes: Record<string, unknown>[] = [{}];
        for (let level = 1; level < 40; level++)
        {
            const next: Record<string, unknown> = {};
            (nodes[level - 1] as Record<string, unknown>).next = next;
            nodes.push(next);
        }
        const tail = nodes[39] as Record<string, unknown>;
        tail.password = 'SECRET-PATH';
        tail.back = nodes[36];
        const records: Record<string, unknown>[] = [];
        const log = createLogger({ redact: ['password'], sink: (record) => records.push(record.fields) });
        log.info('m', { head: nodes[0] });
        delete tail.back;
        log.info('m', { head: nodes[0], again: nodes[0] });
        const expected = JSON.parse(JSON.stringify(nodes[0]).replace('SECRET-PATH', '[redacted]')) as unknown;
        expect(records).toEqual([{ head: '[unserializable]' }, { head: expected, again: expected }]);
    });

    it('a shared value whose toJSON answers by key is written as JSON writes it at every key', () =>
    {
        const byKey = { toJSON: (key: string): unknown => ({ at: key }) };
        const wide = { pad: Array.from({ length: 70000 }, (_, index) => ({ index })), a: byKey, b: byKey, list: [byKey, byKey] };
        expect(line(['zzz'], { wide })).toBe(lineOf({ wide }));
    });

    it('a copy of a wide object keeps the fast object layout', () =>
    {
        const out = inNode(['--allow-natives-syntax'], [
            `const L = await import(${ SOURCE });`,
            'let fields;',
            'const log = L.createLogger({ redact: [\'authorization\'], sink: (record) => { fields = record.fields; } });',
            'const headers = {};',
            'for (let index = 0; index < 24; index++) { headers[\'x-header-\' + index] = \'v\' + index; }',
            'headers.authorization = \'Bearer SECRET-WIDE\';',
            'log.info(\'m\', { headers });',
            'const headersFast = %HasFastProperties(fields.headers);',
            'const authorization = fields.headers.authorization;',
            'const row = {};',
            'for (let index = 0; index < 200; index++) { row[\'c\' + index] = index; }',
            'row.authorization = \'SECRET-ROW\';',
            'log.info(\'m\', { row });',
            'const rowFast = %HasFastProperties(fields.row);',
            'const rowKey = fields.row.authorization;',
            'const top = {};',
            'for (let index = 0; index < 24; index++) { top[\'x-top-\' + index] = \'v\' + index; }',
            'top.authorization = \'Bearer SECRET-TOP\';',
            'log.info(\'m\', top);',
            'process.stdout.write(JSON.stringify({ fast: headersFast, authorization, rowFast, rowKey, topFast: %HasFastProperties(fields), topKey: fields.authorization }));'
        ]);
        expect(JSON.parse(out)).toEqual({ fast: true, authorization: '[redacted]', rowFast: true, rowKey: '[redacted]', topFast: true, topKey: '[redacted]' });
    });

    it('a value built as it is read ends at the bound instead of growing without end', () =>
    {
        const lazy = (depth: number): Record<string, unknown> => ({
            depth,
            get next(): Record<string, unknown>
            {
                return lazy(depth + 1);
            }
        });
        const wrap = (target: object): object => new Proxy(target, {
            get: (object, key): unknown =>
            {
                const value: unknown = Reflect.get(object, key);
                return value !== null && typeof value === 'object' ? wrap(value) : value;
            }
        });
        const cyclic: Record<string, unknown> = { name: 'a' };
        cyclic.self = cyclic;
        for (const value of [lazy(0), wrap(cyclic)])
        {
            const started = performance.now();
            expect(line(['password'], { value, keep: 1 })).toBe(lineOf({ value: '[unserializable]', keep: 1 }));
            expect(performance.now() - started).toBeLessThan(1000);
        }
    });

    it('an error nested in a field, an array, a settled result or the bindings', () =>
    {
        const failure = (): Error => Object.assign(new Error('upstream'), { headers: { authorization: 'Bearer SECRET-NESTED' }, status: 401 });
        const nested = { headers: { authorization: '[redacted]' }, status: 401 };
        expect(line(['authorization'], { ctx: { err: failure() } })).toBe(lineOf({ ctx: { err: nested } }));
        expect(line(['authorization'], { errors: [failure()] })).toBe(lineOf({ errors: [nested] }));
        expect(line(['authorization'], { results: [{ status: 'rejected', reason: failure() }] }))
            .toBe(lineOf({ results: [{ status: 'rejected', reason: nested }] }));
        expect(line(['ctx.err.headers.authorization'], { ctx: { err: failure() } })).toBe(lineOf({ ctx: { err: nested } }));
        for (const face of FACES)
        {
            expect(written(face, { redact: ['authorization'] }, (log) => log.child({ upstream: failure() }).info('m')), face)
                .not.toContain('SECRET-NESTED');
        }
        expect(line(['authorization'], { upstream: { error: clientError() } })).not.toContain('SECRET-AUTH');
    });

    it('a toJSON that returns its own object, and a form with a toJSON of its own', () =>
    {
        const self = { password: 'SECRET-SELF', id: 2, toJSON: returnsItself };
        expect(line(['password'], { self })).toBe(lineOf({ self: { password: '[redacted]', id: 2 } }));
        const list = Object.assign([{ password: 'SECRET-LIST' }, 2], { toJSON: returnsItself });
        expect(line(['password'], { list })).toBe(lineOf({ list: [{ password: '[redacted]' }, 2] }));
        const inner = vi.fn(() => ({ password: 'SECRET-INNER' }));
        const outer = { toJSON: () => ({ shown: 'p-shown', toJSON: inner }) };
        expect(line(['password'], { outer })).toBe(lineOf({ outer: { shown: 'p-shown' } }));
        expect(inner).not.toHaveBeenCalled();
    });

    it('a Date or a Buffer whose form holds keys, and the built-in ones untouched', () =>
    {
        const own = Object.assign(new Date(0), { toJSON: () => ({ password: 'SECRET-DATE' }) });
        class Stamp extends Date
        {
            public override toISOString(): string
            {
                return { password: 'SECRET-ISO' } as unknown as string;
            }
        }
        expect(line(['password'], { at: own })).toBe(lineOf({ at: { password: '[redacted]' } }));
        expect(line(['password'], { at: new Stamp(0) })).toBe(lineOf({ at: { password: '[redacted]' } }));
        expect(line(['password'], { at: new Date(0) })).toBe(lineOf({ at: new Date(0) }));
        const bytes = Buffer.from('hi');
        expect(line(['password'], { bytes })).toBe(lineOf({ bytes }));
        expect(line(['data'], { bytes })).toBe(lineOf({ bytes: { type: 'Buffer', data: '[redacted]' } }));
    });

    it('a box is never walked, so its own members cost neither the field nor the time', () =>
    {
        const cyclic = Object(7) as Record<string, unknown>;
        cyclic.self = cyclic;
        const throwing = throwingGetter(Object('abc') as object, 'bad');
        expect(line(['zzz'], { cyclic, throwing })).toBe(lineOf({ cyclic: 7, throwing: 'abc' }));
        // A String box longer than 2^24 characters has more index keys than V8 can list.
        const text = Object('x'.repeat(16777217)) as object;
        const started = performance.now();
        expect(line(['zzz'], { text }).length).toBe(lineOf({ text }).length);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    it('a boxed primitive is written as its value', () =>
    {
        const boxed = Object.assign(Object(7) as object, { password: 'SECRET-BOXED' });
        expect(line(['password'], { n: boxed })).toBe(lineOf({ n: 7 }));
        expect(written('fused', { redact: ['zzz'], fields: { n: Object(7) as object, s: Object('x') as object } }, (log) => log.info('m')))
            .toBe('{"level":"info","msg":"m","n":7,"s":"x"}\n');
    });

    it('a rule-named key is replaced without being read', () =>
    {
        const getter = vi.fn(() => 'SECRET-GETTER');
        const value = Object.defineProperty({ id: 1 }, 'password', { enumerable: true, get: getter });
        expect(line(['password'], { value })).toBe(lineOf({ value: { id: 1, password: '[redacted]' } }));
        expect(getter).not.toHaveBeenCalled();
    });
});

describe('a field that is itself an error', () =>
{
    it('keeps its error shape under a rule matching inside it, toJSON or not', () =>
    {
        for (const rule of ['authorization', 'code', 'stack', 'error.config.headers.authorization'])
        {
            const error = clientError();
            const text = line([rule], { status: 402, error });
            const shape = errorShape(error);
            expect(JSON.parse(text), rule).toMatchObject({ status: 402, error: { name: shape.name, message: shape.message } });
            expect(text, rule).not.toContain('SECRET-CARD');
            expect(text, rule).not.toContain('SECRET-AUTH');
            expect(text, rule).not.toContain('config');
        }
        const throwing = Object.assign(new Error('kept'), { toJSON: boom });
        expect(JSON.parse(line(['zzz'], { error: throwing })) as unknown).toMatchObject({ error: { name: 'Error', message: 'kept' } });
    });

    it('a cause that is data is matched where it sits', () =>
    {
        const causeOf = (rule: string, error: Error): unknown => (JSON.parse(line([rule], { err: error })) as { err: ErrorShape }).err.cause;
        const failed = (): Error => new Error('failed', { cause: { request: { password: 'pw-1' } } });
        expect(causeOf('password', failed())).toBe('{"request":{"password":"[redacted]"}}');
        expect(causeOf('err.cause.request.password', failed())).toBe('{"request":{"password":"[redacted]"}}');
        expect(causeOf('cause.request.password', failed())).toBe('{"request":{"password":"pw-1"}}');
        const chain = new Error('outer', { cause: new Error('inner', { cause: { password: 'SECRET-CHAIN' } }) });
        expect((causeOf('err.cause.cause.password', chain) as ErrorShape).cause).toBe('{"password":"[redacted]"}');
        for (const rule of ['message', 'stack', 'name'])
        {
            const shape = JSON.parse(line([rule], { err: new Error('own text', { cause: { a: 1 } }) })) as { err: ErrorShape };
            expect(shape.err.message, rule).toBe('own text');
            expect(shape.err.cause, rule).toBe('{"a":1}');
        }
        for (const rule of ['cause', 'err.cause', 'ERR.Cause'])
        {
            for (const held of [{ token: 'SECRET-SLOT' }, 'body=SECRET-SLOT', new Error('SECRET-SLOT')])
            {
                const shape = JSON.parse(line([rule], { err: new Error('own text', { cause: held }) })) as { err: ErrorShape };
                expect(shape.err.message, rule).toBe('own text');
                expect(shape.err.cause, rule).toBe('[redacted]');
            }
        }
        expect((JSON.parse(line(['cause'], { err: new Error('none') })) as { err: ErrorShape }).err.cause).toBeUndefined();
        const cyclic: Record<string, unknown> = { password: 'SECRET-LOOP' };
        cyclic.self = cyclic;
        expect(causeOf('password', new Error('x', { cause: cyclic }))).toBe('[unserializable]');
        expect(causeOf('zzz', new Error('x', { cause: { toJSON: () => '[unserializable]' } }))).toBe('"[unserializable]"');
    });
});

describe('a field redaction cannot finish', () =>
{
    it('a cyclic value is given up at its first cycle, and the record keeps none of it', () =>
    {
        const users = Array.from({ length: 1000 }, (_, id) => ({ id, password: 'SECRET-GRAPH', friends: [] as unknown[] }));
        for (const user of users)
        {
            user.friends.push(...users);
        }
        const started = performance.now();
        const fields = recorded({ redact: ['password'] }, (log) => log.info('loaded', { user: users[0], keep: 1 }));
        expect(performance.now() - started).toBeLessThan(250);
        expect(fields).toEqual({ user: '[unserializable]', keep: 1 });
        expect(inspect(fields, { depth: Infinity })).not.toContain('SECRET-GRAPH');
    });

    it('a throwing getter, toJSON or Proxy trap gives up its own field on every face, and the line is written', () =>
    {
        const getter = throwingGetter({ a: 1 }, 'b');
        const toJSON = { toJSON: boom };
        const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
        revoke();
        for (const face of FACES)
        {
            for (const [label, value, redact] of [['getter', getter, ['password']], ['toJSON', toJSON, ['password']], ['revoked', proxy, undefined]] as const)
            {
                let text = '';
                expect(() =>
                {
                    text = written(face, { redact: redact === undefined ? undefined : [...redact] }, (log) => log.info('m', { value, keep: 'KEPT' }));
                }, `${ face } ${ label }`).not.toThrow();
                expect(text, `${ face } ${ label }`).toContain('KEPT');
                expect(text, `${ face } ${ label }`).toContain('[unserializable]');
            }
        }
    });

    it('a value logged under a rule is not kept alive by the logger', () =>
    {
        const out = inNode(['--expose-gc'], [
            `const L = await import(${ SOURCE });`,
            'const log = L.createLogger({ redact: [\'password\'], sink: () => undefined });',
            'const refs = [];',
            'const logged = (value) => { refs.push(new WeakRef(value)); log.info(\'m\', { value, keep: 1 }); };',
            'logged({ a: { password: \'x\', b: [1, { c: 2 }] } });',
            'logged({ id: 1, toJSON: () => ({ id: 1, password: \'x\' }) });',
            'let deep = { password: \'x\' };',
            'for (let level = 0; level < 100; level++) { deep = { next: deep }; }',
            'logged(deep);',
            'deep = null;',
            'for (let round = 0; round < 5 && refs.some((ref) => ref.deref() !== undefined); round++)',
            '{ await new Promise((resolve) => setTimeout(resolve, 10)); gc(); }',
            'process.stdout.write(refs.map((ref) => (ref.deref() === undefined ? \'collected\' : \'held\')).join());'
        ]);
        expect(out).toBe('collected,collected,collected');
    });

    it('the pretty face writes the line when a function value cannot be turned into text', () =>
    {
        const { proxy, revoke } = Proxy.revocable(() => undefined, {});
        revoke();
        for (const redact of [undefined, ['password']])
        {
            expect(written('pretty', { redact }, (log) => log.info('m', { v: proxy, keep: 'KEPT' }))).toContain('KEPT');
        }
    });

    it('the pretty face writes the line when a request key or an error-shaped value throws on a later read', () =>
    {
        const request = throwingGetter({ path: '/a', status: 200, durationMs: 1, keep: 'KEPT' }, 'method');
        let reads = 0;
        const shaped = {
            name: 'E',
            message: 'm',
            get stack(): string
            {
                return ++reads > 1 ? boom() : 'at x';
            }
        };
        expect(written('pretty', {}, (log) => log.info('request', request))).toContain('KEPT');
        expect(written('pretty', {}, (log) => log.info('m', { shaped, keep: 'KEPT' }))).toContain('KEPT');
    });

    it('a top-level getter that throws costs its field, with or without a rule', () =>
    {
        const fields = throwingGetter({ keep: 1 }, 'bad');
        for (const redact of [undefined, ['password']])
        {
            for (const face of FACES)
            {
                expect(() => written(face, { redact }, (log) => log.info('m', fields)), face).not.toThrow();
            }
        }
        expect(() => createLogger({ redact: ['password'], fields, sink: () => undefined }).info('m')).not.toThrow();
        expect(() => createLogger({ fields, sink: () => undefined }).info('m', { a: 1 })).not.toThrow();
    });
});

describe('bound context under a rule', () =>
{
    it('a context object changed after child() is never written with a key no rule read', () =>
    {
        for (const face of FACES)
        {
            const ctx: { user: Record<string, unknown> } = { user: {} };
            const text = written(face, { redact: ['password'] }, (log) =>
            {
                const child = log.child({ ctx });
                ctx.user.password = 'SECRET-LATER';
                child.info('m');
                child.info('m', { more: 1 });
            });
            expect(text, face).not.toContain('SECRET-LATER');
        }
    });

    it('with no rule, child() reads a binding getter once', () =>
    {
        let reads = 0;
        const bindings = Object.defineProperty({}, 'n', { enumerable: true, get: (): number => ++reads });
        const fields = recorded({}, (log) => log.child(bindings).info('m'));
        expect({ fields, reads }).toEqual({ fields: { n: 1 }, reads: 1 });
    });

    it('keeps symbol keys with no rule, and under a rule holds only the keys JSON writes', () =>
    {
        const tag = Symbol('tag');
        const free = recorded({ fields: { service: 's' } }, (log) => log.child({ [tag]: 'bound' }).info('m', { [tag]: 'call', a: 1 }));
        expect((free as Record<symbol, unknown>)[tag]).toBe('call');
        const ruled = recorded({ redact: ['password'] }, (log) => log.child({ [tag]: 'SECRET-SYMBOL', password: 'p' }).info('m'));
        expect((ruled as Record<symbol, unknown>)[tag]).toBeUndefined();
        expect(inspect(ruled)).not.toContain('SECRET-SYMBOL');
    });
});

describe('the record carries the form redaction read', () =>
{
    it('a toJSON that answers differently by key or by call writes what was read', () =>
    {
        let calls = 0;
        const byCall = { toJSON: (): unknown => (++calls === 1 ? { shown: 1 } : { password: 'SECRET-SECOND' }) };
        const byKey = { toJSON: (key: string): unknown => (key === '' ? { password: 'SECRET-ROOT' } : { shown: 1 }) };
        const records: LogRecord[] = [];
        createLogger({ redact: ['password'], sink: (record) => records.push(record) }).info('m', { byCall, byKey });
        const record = records[0] as LogRecord;
        for (const text of [ndjsonLine(record), JSON.stringify(record), JSON.stringify(record.fields)])
        {
            expect(text).not.toContain('SECRET-SECOND');
            expect(text).not.toContain('SECRET-ROOT');
        }
        expect(calls).toBe(1);
    });

    it('the console face shows a form, so a key its toJSON hides is never printed', () =>
    {
        const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const user = { name: 'ada', password: 'SECRET-HIDDEN', toJSON: () => ({ name: 'ada' }) };
        createLogger({ face: 'console', redact: ['password'] }).info('m', { user });
        expect(inspect(spy.mock.calls[0], { depth: Infinity })).not.toContain('SECRET-HIDDEN');
        spy.mockRestore();
    });
});

describe('a toJSON result with no keys, a box and a borrowed platform method', () =>
{
    class Stamp
    {
        public static calls = 0;

        public readonly at: string;

        constructor(at: string)
        {
            this.at = at;
        }

        public toJSON(): string
        {
            Stamp.calls++;
            return this.at;
        }
    }

    it('asks a toJSON that answers with a string once per line, nested and as a field, on every face', () =>
    {
        for (const face of FACES)
        {
            Stamp.calls = 0;
            written(face, { redact: ['password'] }, (log) => log.info('m', { at: new Stamp('t1'), user: { at: new Stamp('t2') }, list: [new Stamp('t3')] }));
            expect(Stamp.calls, face).toBe(3);
        }
    });

    it('writes a field of that kind as its form: NDJSON bytes unchanged, the pretty face as the form itself', () =>
    {
        vi.useFakeTimers({ now: 0 });
        const values = { url: new URL('https://example.com/a'), at: new Stamp('t1'), gone: { toJSON: (): undefined => undefined } };
        const forms = { url: 'https://example.com/a', at: 't1', gone: '[unserializable]' };
        for (const face of ['sink', 'fused'] as const)
        {
            expect(written(face, { redact: ['zzz'] }, (log) => log.info('m', values)), face).toBe(written(face, {}, (log) => log.info('m', values)));
        }
        expect(written('pretty', { redact: ['zzz'] }, (log) => log.info('m', values))).toBe(written('pretty', {}, (log) => log.info('m', forms)));
        vi.useRealTimers();
    });

    it('hands a sink a field\'s own toJSON form as the plain data JSON writes', () =>
    {
        const fields = recorded({ redact: ['password'] }, (log) => log.info('m', { url: new URL('https://example.com/a'), at: new Stamp('t1') }));
        expect(fields).toEqual({ url: 'https://example.com/a', at: 't1' });
        const applied = createRedactor(['password']).apply({ url: new URL('https://example.com/b') });
        expect(applied.url).toBe('https://example.com/b');
    });

    it('a toJSON that answers a string first and keys later writes what redaction read', () =>
    {
        let calls = 0;
        const shifting = { toJSON: (): unknown => (++calls === 1 ? 'first' : { password: 'SECRET-SHIFT' }) };
        for (const face of ['sink', 'fused'] as const)
        {
            calls = 0;
            const text = written(face, { redact: ['password'] }, (log) => log.info('m', { c: shifting, nested: { c: shifting } }));
            expect(text, face).not.toContain('SECRET-SHIFT');
        }
    });

    it('a box is written as its primitive and a borrowed box prototype by its own keys', () =>
    {
        class Money extends Number
        {
            public password = 'SECRET-SUB';
        }
        expect(line(['password'], { price: new Money(5) })).toBe(lineOf({ price: 5 }));
        const borrowed = Object.assign(Object.create(Number.prototype) as object, { password: 'SECRET-BORROWED', id: 1 });
        expect(line(['password'], { value: borrowed })).toBe(lineOf({ value: { password: '[redacted]', id: 1 } }));
        const form = Object.assign(Object(5) as object, { toJSON: () => ({ password: 'SECRET-BOXFORM' }) });
        expect(line(['password'], { c: { toJSON: () => form } })).toBe(lineOf({ c: 5 }));
    });

    it('a fields object whose toJSON result has a toJSON of its own, or is an array, is written as JSON writes it', () =>
    {
        const inner = vi.fn(() => ({ password: 'SECRET-INNER' }));
        const records: LogRecord[] = [];
        const log = createLogger({ sink: (record) => records.push(record) });
        log.info('m', { toJSON: () => ({ user: 'ada', toJSON: inner }) });
        log.info('m', { toJSON: () => Object.assign([1, 2], { toJSON: inner }) });
        for (const record of records)
        {
            expect(JSON.stringify(record)).not.toContain('SECRET-INNER');
        }
        expect(records[0]?.fields).toEqual({ user: 'ada' });
        expect(records[1]?.fields).toEqual({ fields: [1, 2] });
        expect(inner).not.toHaveBeenCalled();
    });

    it('a Date or Buffer method replaced on the value is read through, not trusted', () =>
    {
        // Its Symbol.toPrimitive swaps in a toISOString during toJSON; before, it looks built in.
        const date = new Date(0);
        Object.defineProperty(date, Symbol.toPrimitive, {
            value(this: Date): number
            {
                Object.defineProperty(this, 'toISOString', { value: () => ({ password: 'SECRET-DATEHOOK' }), configurable: true });
                return 0;
            }
        });
        expect(line(['password'], { at: date })).toBe(lineOf({ at: { password: '[redacted]' } }));
        const borrowed = { toJSON: Reflect.get(Buffer.prototype, 'toJSON') as unknown, length: 1, 0: { password: 'SECRET-BUF' } };
        expect(line(['password'], { value: borrowed })).not.toContain('SECRET-BUF');
    });

    it('a view that borrowed a Buffer toJSON is read as JSON writes it unless it is a typed array', () =>
    {
        const out = inNode([], [
            'class Shim { toJSON() { const data = []; for (let index = 0; index < this.length; index++) { data.push(this[index]); } return { type: \'Buffer\', data }; } }',
            'globalThis.Buffer = Shim;',
            `const L = await import(${ SOURCE });`,
            'const lines = [];',
            'const log = L.createLogger({ redact: [\'password\'], sink: (record) => lines.push(L.ndjsonLine(record)) });',
            'const view = Object.assign(new DataView(new ArrayBuffer(1)), { toJSON: Shim.prototype.toJSON, length: 1, 0: { password: \'SECRET-VIEW\' } });',
            'const bytes = Object.assign(new Uint8Array([7]), { toJSON: Shim.prototype.toJSON });',
            'log.info(\'m\', { view, bytes });',
            'process.stdout.write(lines.join(\'\'));'
        ]);
        expect(out).not.toContain('SECRET-VIEW');
        expect(JSON.parse(out)).toMatchObject({ view: { type: 'Buffer', data: [{ password: '[redacted]' }] }, bytes: { type: 'Buffer', data: [7] } });
    });

    it('a carrier met again on its own path is written as JSON writes it when its form is new', () =>
    {
        const node: Record<string, unknown> = {
            id: 7,
            toJSON(this: Record<string, unknown>, key: string): unknown
            {
                return key === 'self' ? { $ref: 7 } : { id: this.id, self: this };
            }
        };
        expect(line(['zzz'], { node })).toBe(lineOf({ node }));
    });

    it('a carrier handed back as another carrier\'s form is written as JSON writes it, near the field and deep', () =>
    {
        // Each part of the form answers with the carrier: by key and by index.
        const pair = (): object =>
        {
            const form: Record<string, unknown> = { id: 1, password: 'SECRET-PAIR' };
            const carrier = { toJSON: (): unknown => form };
            form.back = { toJSON: (): unknown => carrier };
            form.list = [{ toJSON: (): unknown => carrier }];
            return carrier;
        };
        const below = (levels: number, value: unknown): Record<string, unknown> =>
        {
            let node: Record<string, unknown> = { value };
            for (let level = 0; level < levels; level++)
            {
                node = { next: node };
            }
            return node;
        };
        // The form on frame 0, on the last scanned frame, on the first one in the set and deeper.
        const fields = { near: pair(), scanned: below(30, pair()), set: below(31, pair()), deep: below(40, pair()) };
        expect(line(['zzz'], fields)).toBe(lineOf(fields));
        expect(line(['password'], fields)).toBe(lineOf(fields).replace(/SECRET-PAIR/g, '[redacted]'));
    });

    it('a toJSON that returns itself and then a new object when met again is written as JSON writes it', () =>
    {
        const byKey = (): Record<string, unknown> =>
        {
            const node: Record<string, unknown> = {
                id: 2,
                toJSON(this: Record<string, unknown>, key: string): unknown
                {
                    return key === 'self' ? { $ref: 2 } : this;
                }
            };
            node.self = node;
            return node;
        };
        let calls = 0;
        const byCall: Record<string, unknown> = {
            id: 3,
            toJSON(this: Record<string, unknown>): unknown
            {
                return ++calls === 1 ? this : { stub: calls };
            }
        };
        byCall.self = byCall;
        let deep: Record<string, unknown> = { node: byKey() };
        for (let level = 0; level < 40; level++)
        {
            deep = { next: deep };
        }
        const expected = { byKey: { id: 2, self: { $ref: 2 } }, byCall: { id: 3, self: { stub: 2 } }, deep };
        expect(line(['zzz'], { byKey: byKey(), byCall, deep })).toBe(lineOf(expected));
    });

    it('a toJSON that keeps returning itself is asked where JSON asks it and given up where JSON fails', () =>
    {
        let calls = 0;
        const loop: Record<string, unknown> = {
            toJSON(this: Record<string, unknown>): unknown
            {
                calls++;
                return this;
            }
        };
        loop.self = loop;
        // Itself twice, then a new object: JSON fails at the second answer.
        let answers = 0;
        const twice: Record<string, unknown> = {
            toJSON(this: Record<string, unknown>): unknown
            {
                return ++answers <= 2 ? this : { stub: answers };
            }
        };
        twice.self = twice;
        expect(line(['zzz'], { loop, twice })).toBe(lineOf({ loop: '[unserializable]', twice: '[unserializable]' }));
        expect({ calls, answers }).toEqual({ calls: 2, answers: 2 });
    });

    it('a toJSON that answers with a new holder of itself is given up after a few answers', () =>
    {
        // As a member, behind a getter and in an array: JSON follows each until its stack runs out.
        let calls = 0;
        const member: Record<string, unknown> = { toJSON: (): unknown => ({ n: ++calls, self: member }) };
        const getter: Record<string, unknown> = {
            toJSON: (): unknown => ({
                n: ++calls,
                get self(): unknown
                {
                    return getter;
                }
            })
        };
        const listed: Record<string, unknown> = { toJSON: (): unknown => [++calls, listed] };
        for (const value of [member, getter, listed])
        {
            calls = 0;
            expect(line(['zzz'], { value, keep: 1 })).toBe(lineOf({ value: '[unserializable]', keep: 1 }));
            expect(calls).toBe(97);
        }
    });

    it('parents written as stubs naming their own parents are written as JSON writes them, however deep', () =>
    {
        const near = stubChain(40);
        expect(line(['zzz'], { near })).toBe(lineOf({ near }));
        // Deep, and after a field whose frames it reuses.
        let flat: Record<string, unknown> = {};
        for (let level = 0; level < 100; level++)
        {
            flat = { next: flat };
        }
        const deep = stubChain(300);
        expect(line(['zzz'], { flat, deep })).toBe(lineOf({ flat, deep }));
    });

    it('each field counts its own re-entries, a field logged inside another one included', () =>
    {
        // A field given up at the bound leaves the next field the whole allowance.
        const member: Record<string, unknown> = { toJSON: (): unknown => ({ self: member }) };
        const root = stubChain(40);
        expect(line(['zzz'], { member, root })).toBe(lineOf({ member: '[unserializable]', root }));
        // A field logged inside one deep in re-entries counts from none; the outer keeps its own.
        const lines: string[] = [];
        const log = createLogger({ redact: ['zzz'], sink: (record) => lines.push(ndjsonLine(record).replace(/"time":\d+,/, '').trimEnd()) });
        let answers = 0;
        const outer: Record<string, unknown> = {
            toJSON: (): unknown =>
            {
                if (++answers !== 93)
                {
                    return { n: answers, self: outer };
                }
                return {
                    get inner(): number
                    {
                        log.info('inner', { root: stubChain(40) });
                        return 1;
                    },
                    self: outer
                };
            }
        };
        log.info('outer', { outer });
        expect(lines).toEqual([
            '{"level":"info","msg":"inner",' + JSON.stringify({ root: stubChain(40) }).slice(1),
            '{"level":"info","msg":"outer","outer":"[unserializable]"}'
        ]);
        expect(answers).toBe(97);
    });

    it('a toJSON that answers by key keeps JSON\'s form when it meets itself', () =>
    {
        const node: Record<string, unknown> = {
            data: 'd',
            toJSON(this: Record<string, unknown>, key: string): unknown
            {
                return key === '' ? this : 'ref:self';
            }
        };
        node.self = node;
        expect(line(['password'], { node })).toBe(lineOf({ node: { data: 'd', self: 'ref:self' } }));
    });

    it('copies survive a frozen Object.prototype', () =>
    {
        const out = inNode([], [
            'Object.freeze(Object.prototype);',
            `const L = await import(${ SOURCE });`,
            'const lines = [];',
            'const log = L.createLogger({ redact: [\'password\'], sink: (r) => lines.push(L.ndjsonLine(r)) });',
            'const body = JSON.parse(\'{"constructor":"c","toString":"t","password":"p","user":{"constructor":"x","password":"q"}}\');',
            'log.info(\'m\', body);',
            'log.child(body).info(\'bound\');',
            'log.info(\'nested\', { body });',
            'process.stdout.write(lines.join(\'\'));'
        ]);
        const lines = out.trim().split('\n').map((text) => JSON.parse(text) as Record<string, unknown>);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatchObject({ constructor: 'c', toString: 't', password: '[redacted]', user: { constructor: 'x', password: '[redacted]' } });
        expect(lines[2]).toMatchObject({ body: { constructor: 'c', password: '[redacted]' } });
        expect(out).not.toMatch(/"password":"[pq]"/);
    });
});

describe('the public API keeps its shape', () =>
{
    it('errorShape maps point-free and never redacts', () =>
    {
        const errors = [new Error('a', { cause: { code: 1 } })];
        const shapes: ErrorShape[] = errors.map(errorShape);
        expect(shapes[0]?.cause).toBe('{"code":1}');
        const readonlyErrors: readonly Error[] = errors;
        expect(readonlyErrors.map(errorShape)).toHaveLength(1);
    });

    it('a hand-written Redactor is asked once per call, and a planned one reaches a data cause', () =>
    {
        const apply = vi.fn((fields: Record<string, unknown>) => fields);
        const handWritten: Redactor = { apply };
        shapeFields({ status: 500, err: new Error('x', { cause: { token: 'T' } }) }, handWritten);
        expect(apply).toHaveBeenCalledTimes(1);
        const planned = createRedactor(['token']);
        const record = (): Record<string, unknown> => ({ err: new Error('x', { cause: { token: 'SECRET-T' } }) });
        for (const redactor of [planned, { ...planned }, Object.freeze({ ...planned })])
        {
            expect((shapeFields(record(), redactor).err as ErrorShape).cause).toBe('{"token":"[redacted]"}');
        }
        const replaced: Redactor = { ...planned };
        const swapped = vi.fn((fields: Record<string, unknown>) => ({ ...planned.apply(fields), extra: '[redacted]' }));
        replaced.apply = swapped;
        expect(shapeFields({ extra: 'SECRET-EXTRA' }, replaced)).toEqual({ extra: '[redacted]' });
        expect(swapped).toHaveBeenCalledTimes(1);
    });
});
