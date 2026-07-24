/**
 * MODULE: logger/sinks - the two faces over one record
 *
 * A sink is one function from record to nowhere; these are the built-in three:
 *
 *   - prettySink: the developer face. One aligned line per event - compact timestamp,
 *     a level icon in the level's color, the message, fields as dim key=value pairs.
 *     Errors get the treatment a human debugging at 2am deserves: the message on the
 *     line, the stack indented and dimmed below it, the cause chain walked.
 *   - ndjsonSink: the production face. One machine-first JSON line per event, byte-clean
 *     (no ANSI ever), stable field order - what every collector ingests.
 *   - consoleSink: the browser face. Levels map to console methods; the badge is styled
 *     with %c so DevTools shows the same identity the terminal does.
 *
 * Icons degrade to ASCII on terminals that cannot render them; color obeys color.ts's
 * capability rules. Neither is ever decided per record - the sink closes over one
 * detection done at construction.
 */

import type { LogLevel, LogRecord, LogSink } from './record.ts';
import type { ColorTier, Palette, Style, TtyLike } from './color.ts';
import { colorTier, palette, supportsUnicode } from './color.ts';
import type { ErrorShape } from './serialize.ts';
import { ndjsonLine } from './serialize.ts';

/** The subset of a writable stream sinks need. */
export interface WritableLike extends TtyLike
{
    write(chunk: string): unknown;
}

/** @internal stdout/stderr behind a guard so the module loads in a browser. */
function stdStream(fd: 'stdout' | 'stderr'): WritableLike | undefined
{
    return typeof process === 'undefined' ? undefined : process[fd];
}

/** Options shared by the terminal sinks. */
export interface TerminalSinkOptions
{
    /** Target stream; default stdout (prettySink routes warn+ to stderr when unset). */
    stream?: WritableLike | undefined;

    /** Override detected color capability (tests, forced CI rendering). */
    tier?: ColorTier | undefined;

    /** Override Unicode icon detection. */
    unicode?: boolean | undefined;

    /**
     * Field names THIS sink never renders (prettySink only). For a context field bound
     * on every line - `service` in a single-service dev terminal - the repetition is
     * noise to a human but signal to a collector: hide it here, keep it in the NDJSON
     * faces and files.
     */
    hide?: readonly string[] | undefined;
}

/** @internal Per-level presentation: icon, ASCII fallback, and the badge style. */
const LEVEL_BADGE: Record<LogLevel, { icon: string; ascii: string; style: (p: Palette) => Style }> =
{
    trace: { icon: '·', ascii: '.', style: (p) => p.dim },
    debug: { icon: '✦', ascii: '*', style: (p) => p.magenta },
    info: { icon: '●', ascii: 'i', style: (p) => p.brand },
    warn: { icon: '▲', ascii: '!', style: (p) => p.yellow },
    error: { icon: '✖', ascii: 'x', style: (p) => p.red },
    fatal: { icon: '✖', ascii: 'X', style: (p) => p.inverseRed }
};

/**
 * @internal HH:MM:SS in local time. Milliseconds were dropped deliberately: the
 * clock answers "when did this happen", and sub-second precision lives where it
 * matters - in measured fields like durationMs. (The full epoch is always in the
 * record for NDJSON faces and files.)
 */
function clockTime(epochMs: number): string
{
    const d = new Date(epochMs);
    const pad2 = (n: number): string => (n < 10 ? '0' : '') + String(n);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** @internal The shape logRequests-style observers emit; recognized structurally. */
interface RequestShape
{
    method: string;
    path: string;
    status: number;
    durationMs: number;
}

/** @internal A record whose fields carry a complete request story - and nothing guessed. */
function requestShape(fields: Record<string, unknown>): RequestShape | null
{
    const { method, path, status, durationMs } = fields;
    if (typeof method === 'string' && typeof path === 'string'
        && typeof status === 'number' && typeof durationMs === 'number')
    {
        return { method, path, status, durationMs };
    }
    return null;
}

/** @internal Keys the request sentence consumes - they must not re-render as pairs. */
const REQUEST_KEYS = ['method', 'path', 'status', 'durationMs'] as const;

/**
 * @internal Semantic value styling: a fact gets the one style its MEANING earns.
 * A URL is a destination (brand - the same fact the ready frame paints brand); a
 * status code is a verdict (2xx green, 3xx cyan, 4xx yellow, 5xx red). Everything
 * else stays plain - restraint is what keeps the styled facts readable. Styling
 * only: the value's bytes are never altered.
 */
function styleValue(key: string, value: unknown, paint: Palette): string
{
    const text = String(value);
    if (key === 'url' || (typeof value === 'string' && /^https?:\/\//.test(value)))
    {
        return paint.brand(text);
    }
    if (key === 'status' && typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599)
    {
        const verdict = value < 300 ? paint.green : value < 400 ? paint.cyan : value < 500 ? paint.yellow : paint.red;
        return verdict(text);
    }
    return text;
}

/**
 * @internal Inline field rendering: dim keys, semantically styled values, JSON for
 * structures. Each pair hangs off a dim interpunct - the house separator the doctor
 * verdict line established - so the eye finds the message/fields boundary and each
 * pair's start without reading. ASCII terminals keep the plain double space.
 */
function inlineFields(fields: Record<string, unknown>, paint: Palette, hidden: ReadonlySet<string>, joint: string): string
{
    let out = '';
    for (const key of Object.keys(fields))
    {
        if (hidden.has(key))
        {
            continue;
        }
        const value = fields[key];
        if (value !== null && typeof value === 'object')
        {
            continue; // structures render on their own lines (errors) or as JSON below
        }
        // `url=http://...` is a tautology - the value names itself. The key is
        // dropped from DISPLAY only (files and NDJSON keep it); any other key
        // stays, because `docs=https://...` needs its key to say WHICH url.
        const label = key === 'url' && typeof value === 'string' && /^https?:\/\//.test(value)
            ? ''
            : paint.dim(key + '=');
        out += joint + label + styleValue(key, value, paint);
    }
    return out;
}

/** @internal The error block under a line: dim stack, cause chain walked. */
function errorBlock(shape: ErrorShape, paint: Palette, indent: string): string
{
    let out = '';
    if (shape.stack !== undefined)
    {
        // The stack's first line repeats name+message; keep the frames only.
        const frames = shape.stack.split('\n').slice(1).join('\n' + indent);
        out += '\n' + indent + paint.dim(frames);
    }
    else
    {
        out += '\n' + indent + paint.red(shape.name + ': ' + shape.message);
    }
    let cause = shape.cause;
    while (cause !== undefined)
    {
        if (typeof cause === 'string')
        {
            out += '\n' + indent + paint.dim('caused by: ' + cause);
            break;
        }
        out += '\n' + indent + paint.dim('caused by: ' + cause.name + ': ' + cause.message);
        cause = cause.cause;
    }
    return out;
}

/**
 * The developer face: aligned, colored, iconed single lines on a TTY.
 * warn/error/fatal go to stderr when no explicit stream is given, so `app 2>errors.log`
 * separates severities the Unix way.
 */
export function prettySink(options: TerminalSinkOptions = {}): LogSink
{
    const out = options.stream ?? stdStream('stdout');
    const err = options.stream ?? stdStream('stderr');
    const tier = options.tier ?? colorTier(out);
    const paint = palette(tier);
    const unicode = options.unicode ?? supportsUnicode();
    const hidden: ReadonlySet<string> = new Set(options.hide ?? []);
    const joint = unicode ? ' ' + paint.dim('·') + ' ' : '  ';

    return (record: LogRecord): void =>
    {
        const badge = LEVEL_BADGE[record.level];
        const style = badge.style(paint);
        const fields = record.fields;

        // `info` is the ambient level - the icon and color already say it, so the word
        // stays home and the common line gets calmer. Every other level SHOULD read
        // louder than the stream around it, so those keep their word.
        const levelWord = record.level === 'info' ? '' : ' ' + style(record.level.padEnd(5));

        // The headline. A request-shaped record reads as a SENTENCE - the field order
        // IS the grammar (`GET /healthz -> 200 - 0.48ms`), so the scaffolding keys and
        // the redundant message word retire from display. Every other record keeps its
        // message, bold (the event name is what the line is about) and level-tinted
        // for warn/error - the message IS the alarm.
        // hide always wins: hiding any sentence ingredient disarms the sentence
        // (it could not render without showing the hidden field).
        const request = REQUEST_KEYS.some((key) => hidden.has(key)) ? null : requestShape(fields);
        let headline: string;
        let consumed = hidden;
        if (request === null)
        {
            const tinted = record.level === 'warn'
                ? paint.yellow(record.message)
                : record.level === 'error' || record.level === 'fatal' ? paint.red(record.message) : record.message;
            headline = paint.bold(tinted);
        }
        else
        {
            // The verb wears its REST convention: reads cyan, creations green,
            // mutations yellow, deletions red - action identity, not decoration.
            const verb = request.method === 'GET' || request.method === 'HEAD' ? paint.cyan
                : request.method === 'POST' ? paint.green
                    : request.method === 'PUT' || request.method === 'PATCH' ? paint.yellow
                        : request.method === 'DELETE' ? paint.red : (text: string): string => text;
            headline = verb(request.method) + ' ' + request.path
                + ' ' + paint.dim(unicode ? '→' : '->')
                + ' ' + styleValue('status', request.status, paint)
                + ' ' + paint.dim(unicode ? '·' : '-')
                + ' ' + String(request.durationMs) + 'ms';
            consumed = new Set([...hidden, ...REQUEST_KEYS]);
        }

        let line = paint.dim(clockTime(record.time))
            + ' ' + style(unicode ? badge.icon : badge.ascii)
            + levelWord
            + ' ' + headline
            + inlineFields(fields, paint, consumed, joint);

        // Structured values (already shaped by the logger) each get their own treatment:
        // an error renders as a block; other objects as compact JSON on the line.
        for (const key of Object.keys(fields))
        {
            if (consumed.has(key))
            {
                continue;
            }
            const value = fields[key];
            if (value === null || typeof value !== 'object')
            {
                continue;
            }
            if (isErrorShape(value))
            {
                line += errorBlock(value, paint, '    ');
            }
            else
            {
                line += joint + paint.dim(key + '=') + JSON.stringify(value);
            }
        }

        const target = record.level === 'warn' || record.level === 'error' || record.level === 'fatal' ? err : out;
        target?.write(line + '\n');
    };
}

/** @internal Recognizes the shape errorShape() produces (fields are pre-shaped). */
function isErrorShape(value: object): value is ErrorShape
{
    return 'name' in value && 'message' in value && ('stack' in value || 'cause' in value);
}

/**
 * The production face: one byte-clean NDJSON line per record (no ANSI ever, stable key
 * order) to the given stream or stdout - the format every log collector ingests.
 */
export function ndjsonSink(options: { stream?: WritableLike | undefined } = {}): LogSink
{
    const out = options.stream ?? stdStream('stdout');
    return (record: LogRecord): void =>
    {
        out?.write(ndjsonLine(record));
    };
}

/**
 * The browser face: each level maps onto the matching console method (so DevTools
 * filtering works) with the badge styled via %c to carry the same identity the
 * terminal faces have.
 */
export function consoleSink(): LogSink
{
    const METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> =
    {
        trace: 'debug', debug: 'debug', info: 'info', warn: 'warn', error: 'error', fatal: 'error'
    };
    const BADGE_CSS: Record<LogLevel, string> =
    {
        trace: 'color:#8a8f98',
        debug: 'color:#b07fd8',
        info: 'color:#5fb3e8;font-weight:bold',
        warn: 'color:#d8a03f;font-weight:bold',
        error: 'color:#e05f5f;font-weight:bold',
        fatal: 'color:#fff;background:#e05f5f;font-weight:bold'
    };
    return (record: LogRecord): void =>
    {

        console[METHOD[record.level]]('%c' + record.level + '%c ' + record.message, BADGE_CSS[record.level], '', record.fields);
    };
}
