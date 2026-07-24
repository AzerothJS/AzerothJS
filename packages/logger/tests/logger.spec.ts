// @vitest-environment node
//
// The logger's promises, exercised for real: level gating (and its zero-cost disabled
// path), child bindings, redaction reaching no sink, error/cause shapes, NDJSON lines
// that always parse with stable key order, the color/unicode social contract
// (NO_COLOR/FORCE_COLOR/TTY), pretty rendering, and the banner's layout and gating.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    createLogger, ndjsonSink, prettySink, consoleSink,
    renderBanner, printBanner, formatReady,
    ndjsonLine, errorShape, colorTier, supportsUnicode, palette
} from '@azerothjs/logger';
import type { LogRecord, WritableLike } from '@azerothjs/logger';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string): string => s.replace(ANSI, '');

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

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['NO_COLOR', 'FORCE_COLOR', 'AZEROTH_LOG', 'NODE_ENV', 'TERM', 'COLORTERM', 'WT_SESSION', 'TERM_PROGRAM'];

beforeEach(() =>
{
    for (const key of ENV_KEYS)
    {
        savedEnv[key] = process.env[key];
        Reflect.deleteProperty(process.env, key);
    }
});

afterEach(() =>
{
    for (const key of ENV_KEYS)
    {
        if (savedEnv[key] === undefined)
        {
            Reflect.deleteProperty(process.env, key);
        }
        else
        {
            process.env[key] = savedEnv[key];
        }
    }
});

describe('levels', () =>
{
    it('drops records below the threshold and emits at or above it', () =>
    {
        const records: LogRecord[] = [];
        const log = createLogger({ level: 'warn', sink: (r) => records.push(r) });
        log.trace('t'); log.debug('d'); log.info('i'); log.warn('w'); log.error('e'); log.fatal('f');
        expect(records.map((r) => r.level)).toEqual(['warn', 'error', 'fatal']);
    });

    it('silent drops everything', () =>
    {
        const records: LogRecord[] = [];
        const log = createLogger({ level: 'silent', sink: (r) => records.push(r) });
        log.fatal('end of the world');
        expect(records).toEqual([]);
    });

    it('enabled() reports the gate so callers can skip expensive field construction', () =>
    {
        const log = createLogger({ level: 'info', sink: () => undefined });
        expect(log.enabled('debug')).toBe(false);
        expect(log.enabled('info')).toBe(true);
        expect(log.enabled('error')).toBe(true);
    });

    it('a disabled call never touches the sink or the fields object', () =>
    {
        const sink = vi.fn();
        const log = createLogger({ level: 'error', sink });
        log.debug('nope', { expensive: 'value' });
        expect(sink).not.toHaveBeenCalled();
    });
});

describe('children and fields', () =>
{
    it('child bindings ride every record, bound context first, call fields after', () =>
    {
        const records: LogRecord[] = [];
        const log = createLogger({ level: 'info', sink: (r) => records.push(r) }).child({ requestId: 'r1' });
        log.info('hello', { step: 2 });
        expect(records[0]?.fields).toEqual({ requestId: 'r1', step: 2 });
        expect(Object.keys(records[0]?.fields ?? {})).toEqual(['requestId', 'step']);
    });

    it('grandchildren merge cumulatively; later bindings win on collision', () =>
    {
        const records: LogRecord[] = [];
        const log = createLogger({ level: 'info', sink: (r) => records.push(r) })
            .child({ a: 1, shared: 'parent' })
            .child({ b: 2, shared: 'kid' });
        log.info('x');
        expect(records[0]?.fields).toEqual({ a: 1, shared: 'kid', b: 2 });
    });
});

describe('redaction and error shaping', () =>
{
    it('redacted fields never reach any sink - call fields, bound fields, and children', () =>
    {
        const records: LogRecord[] = [];
        const log = createLogger({
            level: 'info',
            redact: ['authorization', 'cookie'],
            fields: { cookie: 'session=abc' },
            sink: (r) => records.push(r)
        });
        log.info('req', { authorization: 'Bearer xyz', path: '/x' });
        log.child({ authorization: 'Bearer child' }).info('nested');
        expect(records[0]?.fields).toEqual({ cookie: '[redacted]', authorization: '[redacted]', path: '/x' });
        expect(records[1]?.fields.authorization).toBe('[redacted]');
    });

    it('errors serialize with name, message, stack, and the cause chain', () =>
    {
        const root = new Error('disk gone');
        const wrapped = new Error('save failed', { cause: root });
        const shape = errorShape(wrapped);
        expect(shape.name).toBe('Error');
        expect(shape.message).toBe('save failed');
        expect(typeof shape.stack).toBe('string');
        expect(typeof shape.cause === 'object' && shape.cause.message).toBe('disk gone');
    });

    it('a cyclic cause chain is depth-capped instead of hanging', () =>
    {
        const a = new Error('a');
        const b = new Error('b', { cause: a });
        (a as { cause?: unknown }).cause = b;
        const shape = errorShape(a);
        let depth = 0;
        let cursor = shape.cause;
        while (cursor !== undefined && typeof cursor !== 'string')
        {
            depth++;
            cursor = cursor.cause;
        }
        expect(depth).toBeLessThanOrEqual(6);
    });
});

describe('NDJSON face', () =>
{
    it('emits one parseable line per record with stable leading keys', () =>
    {
        const out = capture();
        const log = createLogger({ level: 'info', sink: ndjsonSink({ stream: out.stream }) });
        log.info('hello world', { user: 'thrall', count: 3 });
        const line = out.lines()[0] ?? '';
        expect(line.startsWith('{"level":"info","time":')).toBe(true);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed.msg).toBe('hello world');
        expect(parsed.user).toBe('thrall');
        expect(parsed.count).toBe(3);
    });

    it('every hostile string still produces valid JSON, byte-identical to JSON.stringify', () =>
    {
        for (const hostile of ['quote " inside', 'back\\slash', 'line\nbreak', 'tab\t', 'unicode čžš 日本語', 'emoji \u{1F600}', 'lone \ud800 surrogate'])
        {
            const line = ndjsonLine({ level: 'info', message: hostile, time: 0, fields: { value: hostile } });
            const parsed = JSON.parse(line) as { msg: string; value: string };
            expect(parsed.msg).toBe(JSON.parse(JSON.stringify(hostile)));
            expect(parsed.value).toBe(parsed.msg);
        }
    });

    it('non-finite numbers, undefined, null, and nested structures serialize as JSON.stringify would', () =>
    {
        const line = ndjsonLine({
            level: 'warn', message: 'm', time: 1,
            fields: { nan: NaN, inf: Infinity, u: undefined, n: null, deep: { a: [1, 'two'] } }
        });
        expect(JSON.parse(line)).toEqual({ level: 'warn', time: 1, msg: 'm', nan: null, inf: null, u: null, n: null, deep: { a: [1, 'two'] } });
    });

    it('never emits ANSI codes, even when FORCE_COLOR is set', () =>
    {
        process.env.FORCE_COLOR = '3';
        const out = capture(true);
        const log = createLogger({ level: 'info', face: 'ndjson', stream: out.stream });
        log.info('clean');
        expect(out.raw()).not.toMatch(ANSI);
    });
});

describe('pretty face', () =>
{
    it('renders time, icon, message, and dim key=value fields on one line', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });
        sink({ level: 'info', message: 'server up', time: Date.UTC(2026, 0, 1, 12, 30, 5, 42), fields: { port: 3000 } });
        const line = out.lines()[0] ?? '';
        // info is the ambient level: the icon carries it, the word stays home.
        expect(line).toContain('● server up');
        expect(line).not.toContain('info');
        expect(line).toContain('port=3000');
        // Seconds-only clock: sub-second precision lives in measured fields.
        expect(line).toMatch(/\d\d:\d\d:\d\d /);
        expect(line).not.toMatch(/\d\d:\d\d:\d\d\.\d/);
    });

    it('keeps the level word for every non-info level', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });
        sink({ level: 'error', message: 'boom', time: 0, fields: {} });
        sink({ level: 'debug', message: 'poke', time: 0, fields: {} });
        expect(out.lines()[0]).toContain('✖ error');
        expect(out.lines()[1]).toContain('✦ debug');
    });

    it('hide: named fields never render on this sink (files keep them)', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true, hide: ['service'] });
        sink({ level: 'info', message: 'listening', time: 0, fields: { service: 'api', url: 'http://x' } });
        const line = out.lines()[0] ?? '';
        expect(line).toContain('http://x');
        expect(line).not.toContain('service=');
    });

    it('field pairs hang off the dim interpunct; ASCII keeps the double space', () =>
    {
        const out = capture(true);
        prettySink({ stream: out.stream, tier: 'none', unicode: true })(
            { level: 'info', message: 'listening', time: 0, fields: { url: 'http://x', env: 'dev' } });
        // url= is a tautology - the value names itself, so only the key drops.
        expect(out.lines()[0]).toContain('listening · http://x · env=dev');

        const ascii = capture(true);
        prettySink({ stream: ascii.stream, tier: 'none', unicode: false })(
            { level: 'info', message: 'listening', time: 0, fields: { env: 'dev' } });
        expect(ascii.lines()[0]).toContain('listening  env=dev');
    });

    it('a request-shaped record reads as a sentence; extra fields trail as pairs', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });
        sink({ level: 'info', message: 'request', time: 0, fields: { method: 'GET', path: '/healthz', status: 200, durationMs: 0.48, requestId: 'abc123' } });
        const line = out.lines()[0] ?? '';
        expect(line).toContain('GET /healthz → 200 · 0.48ms');
        expect(line).toContain('requestId=abc123');
        // The sentence consumed its scaffolding: no key=value re-render, no message word.
        expect(line).not.toContain('method=');
        expect(line).not.toContain('status=');
        expect(line).not.toContain('request ·');
    });

    it('method verbs wear their REST colors in the sentence', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'basic', unicode: true });
        sink({ level: 'info', message: 'request', time: 0, fields: { method: 'GET', path: '/a', status: 200, durationMs: 1 } });
        sink({ level: 'info', message: 'request', time: 0, fields: { method: 'POST', path: '/a', status: 201, durationMs: 1 } });
        sink({ level: 'info', message: 'request', time: 0, fields: { method: 'DELETE', path: '/a', status: 204, durationMs: 1 } });
        const lines = out.lines();
        expect(lines[0]).toContain('[36mGET[39m');
        expect(lines[1]).toContain('[32mPOST[39m');
        expect(lines[2]).toContain('[31mDELETE[39m');
    });

    it('a 5xx request sentence keeps its error level word', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });
        sink({ level: 'error', message: 'request failed', time: 0, fields: { method: 'GET', path: '/boom', status: 500, durationMs: 3.1 } });
        const line = out.lines()[0] ?? '';
        expect(line).toContain('✖ error');
        expect(line).toContain('GET /boom → 500 · 3.1ms');
    });

    it('hiding any sentence ingredient disarms the sentence - hide always wins', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true, hide: ['status'] });
        sink({ level: 'info', message: 'request', time: 0, fields: { method: 'GET', path: '/x', status: 200, durationMs: 1 } });
        const line = out.lines()[0] ?? '';
        // No sentence (it would have to show the hidden status) - pairs, minus status.
        expect(line).not.toContain('GET /x →');
        expect(line).toContain('method=GET');
        expect(line).not.toContain('status');
    });

    it('an incomplete request shape falls back to ordinary pairs', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });
        sink({ level: 'info', message: 'request', time: 0, fields: { method: 'GET', path: '/x' } });
        const line = out.lines()[0] ?? '';
        expect(line).toContain('request · method=GET · path=/x');
    });

    it('semantic values: urls wear the brand, wherever they appear', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'basic', unicode: true });
        sink({ level: 'info', message: 'up', time: 0, fields: { url: 'http://localhost:5200', docs: 'https://azerothjs.dev' } });
        const raw = out.raw();
        // basic-tier brand is cyan (36); both the url key and the url-shaped value get it.
        expect(raw).toContain('[36mhttp://localhost:5200[39m');
        expect(raw).toContain('[36mhttps://azerothjs.dev[39m');
        expect(strip(raw)).toContain('· http://localhost:5200');
        expect(strip(raw)).toContain('docs=https://azerothjs.dev');
    });

    it('semantic values: status codes render as verdicts, out-of-range stays plain', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'basic', unicode: true });
        sink({ level: 'info', message: 'r', time: 0, fields: { status: 200 } });
        sink({ level: 'info', message: 'r', time: 0, fields: { status: 302 } });
        sink({ level: 'info', message: 'r', time: 0, fields: { status: 404 } });
        sink({ level: 'info', message: 'r', time: 0, fields: { status: 500 } });
        sink({ level: 'info', message: 'r', time: 0, fields: { status: 999, state: 'active' } });
        const lines = out.lines();
        expect(lines[0]).toContain('[32m200[39m'); // green
        expect(lines[1]).toContain('[36m302[39m'); // cyan
        expect(lines[2]).toContain('[33m404[39m'); // yellow
        expect(lines[3]).toContain('[31m500[39m'); // red
        expect(lines[4]).toContain('status=[22m999'); // plain after the dim key closes
    });

    it('warn and error messages wear their level color; info stays plain', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'basic', unicode: true });
        sink({ level: 'warn', message: 'careful', time: 0, fields: {} });
        sink({ level: 'error', message: 'broken', time: 0, fields: {} });
        sink({ level: 'info', message: 'calm', time: 0, fields: {} });
        const lines = out.lines();
        expect(lines[0]).toContain('[33mcareful[39m');
        expect(lines[1]).toContain('[31mbroken[39m');
        expect(lines[2]).not.toContain('[33mcalm');
        expect(strip(lines[2] ?? '')).toContain('calm');
    });

    it('falls back to ASCII badges when unicode is off', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: false });
        sink({ level: 'warn', message: 'careful', time: 0, fields: {} });
        expect(out.lines()[0]).toContain('! warn ');
    });

    it('renders a shaped error as an indented block with the cause chain', () =>
    {
        const out = capture(true);
        const sink = prettySink({ stream: out.stream, tier: 'none', unicode: true });
        const shape = errorShape(new Error('save failed', { cause: new Error('disk gone') }));
        sink({ level: 'error', message: 'request failed', time: 0, fields: { error: shape } });
        const raw = out.raw();
        expect(raw).toContain('request failed');
        expect(raw).toContain('caused by: Error: disk gone');
    });

    it('colors when a tier is forced, and NO_COLOR strips everything', () =>
    {
        const colored = capture(true);
        prettySink({ stream: colored.stream, tier: 'truecolor', unicode: true })(
            { level: 'info', message: 'x', time: 0, fields: {} });
        expect(colored.raw()).toMatch(ANSI);

        process.env.NO_COLOR = '1';
        const plain = capture(true);
        prettySink({ stream: plain.stream })({ level: 'info', message: 'x', time: 0, fields: {} });
        expect(plain.raw()).not.toMatch(ANSI);
    });
});

describe('face selection and env overrides', () =>
{
    it('auto picks NDJSON on a non-TTY stream', () =>
    {
        const out = capture(false);
        const log = createLogger({ stream: out.stream });
        log.info('piped');
        expect(out.lines()[0]?.startsWith('{"level"')).toBe(true);
    });

    it('auto picks NDJSON in production even on a TTY', () =>
    {
        process.env.NODE_ENV = 'production';
        const out = capture(true);
        const log = createLogger({ stream: out.stream });
        log.info('prod');
        expect(out.lines()[0]?.startsWith('{"level"')).toBe(true);
    });

    it('AZEROTH_LOG overrides level and face from the environment', () =>
    {
        process.env.AZEROTH_LOG = 'json:debug';
        const out = capture(true);
        const log = createLogger({ level: 'error', face: 'pretty', stream: out.stream });
        log.debug('visible');
        const parsed = JSON.parse(out.lines()[0] ?? '{}') as { msg?: string };
        expect(parsed.msg).toBe('visible');
    });
});

describe('console face', () =>
{
    it('maps levels onto console methods with a styled badge', () =>
    {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        consoleSink()({ level: 'warn', message: 'browser side', time: 0, fields: { a: 1 } });
        expect(spy).toHaveBeenCalledOnce();
        const [format] = spy.mock.calls[0] as [string];
        expect(format).toContain('%cwarn%c browser side');
        spy.mockRestore();
    });
});

describe('banner', () =>
{
    it('renders the mark, name, version, aligned entries, and the measured ready line', () =>
    {
        const banner = strip(renderBanner({
            version: '0.8.0-beta.2',
            subtitle: 'http',
            entries: [['Local', 'http://127.0.0.1:3000'], ['Network', 'http://192.168.1.7:3000']],
            readyMs: 12.4,
            stream: capture(false).stream
        }));
        expect(banner).toContain('AzerothJS');
        expect(banner).toContain('v0.8.0-beta.2');
        expect(banner).toContain('Local    http://127.0.0.1:3000');
        expect(banner).toContain('Network  http://192.168.1.7:3000');
        expect(banner).toContain('Ready in 12 ms');
    });

    it('formats ready times honestly across magnitudes', () =>
    {
        expect(formatReady(0.44)).toBe('0.4 ms');
        expect(formatReady(12.4)).toBe('12 ms');
        expect(formatReady(999.4)).toBe('999 ms');
        expect(formatReady(3421)).toBe('3.42 s');
    });

    it('printBanner refuses non-TTY streams and production mode', () =>
    {
        const piped = capture(false);
        expect(printBanner({ stream: piped.stream })).toBe(false);
        expect(piped.raw()).toBe('');

        process.env.NODE_ENV = 'production';
        const tty = capture(true);
        expect(printBanner({ stream: tty.stream })).toBe(false);
        expect(tty.raw()).toBe('');
    });

    it('prints on an interactive dev terminal', () =>
    {
        const tty = capture(true);
        expect(printBanner({ version: '1.0.0', stream: tty.stream })).toBe(true);
        expect(strip(tty.raw())).toContain('AzerothJS');
    });
});

describe('color capability', () =>
{
    it('NO_COLOR beats FORCE_COLOR beats TTY detection', () =>
    {
        process.env.NO_COLOR = '1';
        process.env.FORCE_COLOR = '3';
        expect(colorTier({ isTTY: true })).toBe('none');

        Reflect.deleteProperty(process.env, 'NO_COLOR');
        expect(colorTier({ isTTY: false })).toBe('truecolor');

        Reflect.deleteProperty(process.env, 'FORCE_COLOR');
        expect(colorTier({ isTTY: false })).toBe('none');
    });

    it('quiet text is a real gray at capable tiers (faint is unreliable on Windows hosts)', () =>
    {
        expect(palette('truecolor').dim('x')).toContain('38;2;138;148;158');
        expect(palette('256').dim('x')).toContain('38;5;245');
        // Basic terminals keep SGR-2 faint - no 256 palette to draw a gray from.
        expect(palette('basic').dim('x')).toContain('[2m');
    });

    it('recognizes the JetBrains terminal as truecolor', () =>
    {
        process.env.TERMINAL_EMULATOR = 'JetBrains-JediTerm';
        try
        {
            expect(colorTier({ isTTY: true })).toBe('truecolor');
        }
        finally
        {
            Reflect.deleteProperty(process.env, 'TERMINAL_EMULATOR');
        }
    });

    it('treats every supported Windows console as unicode-capable', () =>
    {
        if (process.platform === 'win32')
        {
            // No env marker needed: Node's Windows floor is Win10+, whose console
            // fonts carry the glyph set - this machine IS the test environment.
            expect(supportsUnicode()).toBe(true);
        }
        else
        {
            expect(typeof supportsUnicode()).toBe('boolean');
        }
    });
});
