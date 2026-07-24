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

/** @internal HH:MM:SS.mmm in local time - compact, sortable within a day. */
function clockTime(epochMs: number): string
{
    const d = new Date(epochMs);
    const pad2 = (n: number): string => (n < 10 ? '0' : '') + String(n);
    const ms = d.getMilliseconds();
    const pad3 = ms < 10 ? '00' + String(ms) : ms < 100 ? '0' + String(ms) : String(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + pad3;
}

/** @internal Inline field rendering: dim keys, plain values, JSON for structures. */
function inlineFields(fields: Record<string, unknown>, paint: Palette): string
{
    let out = '';
    for (const key of Object.keys(fields))
    {
        const value = fields[key];
        if (value !== null && typeof value === 'object')
        {
            continue; // structures render on their own lines (errors) or as JSON below
        }
        out += '  ' + paint.dim(key + '=') + String(value);
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

    return (record: LogRecord): void =>
    {
        const badge = LEVEL_BADGE[record.level];
        const style = badge.style(paint);
        const fields = record.fields;

        let line = paint.dim(clockTime(record.time))
            + ' ' + style(unicode ? badge.icon : badge.ascii)
            + ' ' + style(record.level.padEnd(5))
            + ' ' + record.message
            + inlineFields(fields, paint);

        // Structured values (already shaped by the logger) each get their own treatment:
        // an error renders as a block; other objects as compact JSON on the line.
        for (const key of Object.keys(fields))
        {
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
                line += '  ' + paint.dim(key + '=') + JSON.stringify(value);
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
