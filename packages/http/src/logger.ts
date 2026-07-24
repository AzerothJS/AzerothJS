/**
 * MODULE: http/logger - structured logging as an interface, not a dependency
 *
 * The complaint about the incumbent frameworks is coupling (pino wired into the instance),
 * not logging itself. Here the LOG RECORD is the contract: a level, a message, a time, and
 * a flat fields object. A sink is one function from record to nowhere - the default writes
 * JSON lines (the format every collector ingests), a pretty sink is provided for humans in
 * development, and anything else (pino, OpenTelemetry logs, a test spy) is a five-line
 * adapter the APPLICATION owns.
 *
 * `child(fields)` binds context once - a request logger carries its requestId into every
 * line without threading arguments. Errors serialize with name/message/stack instead of
 * the `{}` that JSON.stringify makes of them.
 */

import { requestIdOf } from './edge.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One log event - the wire contract between loggers and sinks. */
export interface LogRecord
{
    level: LogLevel;
    message: string;
    /** Epoch milliseconds; the sink chooses the presentation. */
    time: number;
    fields: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger
{
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;

    /** A logger with `fields` merged into every record - request/job context binds once. */
    child(fields: Record<string, unknown>): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** @internal Errors JSON.stringify as {}; give them a real shape wherever they appear. */
function serializable(fields: Record<string, unknown>): Record<string, unknown>
{
    let out = fields;
    for (const [key, value] of Object.entries(fields))
    {
        if (value instanceof Error)
        {
            if (out === fields)
            {
                out = { ...fields };
            }
            out[key] = { name: value.name, message: value.message, stack: value.stack };
        }
    }
    return out;
}

/** The default sink: one JSON object per line on stdout - what log collectors ingest. */
export function jsonSink(record: LogRecord): void
{
    console.log(JSON.stringify({
        level: record.level,
        time: new Date(record.time).toISOString(),
        message: record.message,
        ...serializable(record.fields)
    }));
}

/** A development sink: level-tagged single lines with inline fields. */
export function prettySink(record: LogRecord): void
{
    const fields = Object.entries(serializable(record.fields))
        .map(([key, value]) => `${ key }=${ typeof value === 'string' ? value : JSON.stringify(value) }`)
        .join(' ');
    console.log(`${ new Date(record.time).toISOString() } ${ record.level.toUpperCase().padEnd(5) } ${ record.message }${ fields === '' ? '' : '  ' + fields }`);
}

/**
 * Builds a logger over a sink. Records below `level` are dropped BEFORE any allocation -
 * a silenced debug call costs one comparison.
 */
export function createLogger(options: { sink?: LogSink | undefined; level?: LogLevel | undefined; fields?: Record<string, unknown> | undefined } = {}): Logger
{
    const sink = options.sink ?? jsonSink;
    const threshold = LEVEL_RANK[options.level ?? 'info'];
    const base = options.fields ?? {};

    function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void
    {
        if (LEVEL_RANK[level] < threshold)
        {
            return;
        }
        sink({ level, message, time: Date.now(), fields: fields === undefined ? base : { ...base, ...fields } });
    }

    return {
        debug: (message, fields) => emit('debug', message, fields),
        info: (message, fields) => emit('info', message, fields),
        warn: (message, fields) => emit('warn', message, fields),
        error: (message, fields) => emit('error', message, fields),
        child: (fields) => createLogger({ sink, level: options.level, fields: { ...base, ...fields } })
    };
}

/**
 * The standard request-logging observer: one info line per completed request with method,
 * path, status, and wall time; 5xx log at error level. A correlation id assigned by the
 * `requestId` edge middleware rides along automatically. Wire it as `observe` on the App.
 */
export function logRequests(logger: Logger): { onComplete(request: Request, response: Response, durationMs: number): void }
{
    return {
        onComplete(request, response, durationMs): void
        {
            const fields: Record<string, unknown> = {
                method: request.method,
                path: new URL(request.url).pathname,
                status: response.status,
                durationMs: Math.round(durationMs * 100) / 100
            };
            const id = requestIdOf(request);
            if (id !== undefined)
            {
                fields.requestId = id;
            }
            if (response.status >= 500)
            {
                logger.error('request failed', fields);
            }
            else
            {
                logger.info('request', fields);
            }
        }
    };
}
