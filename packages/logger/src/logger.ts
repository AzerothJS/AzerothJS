/**
 * MODULE: logger/logger - the core, and the face selection
 *
 * createLogger() builds a logger over a sink. The design promises exactly two things:
 *
 *   - A DISABLED level costs one integer comparison. No record object, no field merge,
 *     no Date.now() - `log.trace(...)` in a hot loop with level=info is free. This is
 *     the property that makes leaving instrumentation in production code acceptable.
 *   - FACE SELECTION is automatic and honest. On a TTY outside production the pretty
 *     face renders; piped, in production, or under a collector, byte-clean NDJSON.
 *     `AZEROTH_LOG` overrides both face and level from the environment without touching
 *     code: `AZEROTH_LOG=debug`, `AZEROTH_LOG=json`, `AZEROTH_LOG=pretty:trace`.
 *
 * Redaction happens in the logger, not the sink: a redacted field never reaches ANY
 * sink, so no formatter can leak what the application declared secret.
 */

import type { LevelThreshold, Logger, LogLevel, LogRecord, LogSink } from './record.ts';
import { LEVEL_RANK } from './record.ts';
import type { WritableLike } from './sinks.ts';
import { consoleSink, prettySink } from './sinks.ts';
import { fieldsFragment, quotedString, shapeFields } from './serialize.ts';

/** Which face renders records; `auto` picks by TTY/NODE_ENV/runtime. */
export type LoggerFace = 'auto' | 'pretty' | 'ndjson' | 'console';

/** Construction-time configuration; everything defaults to the right thing for a dev TTY and a container alike. */
export interface LoggerOptions
{
    /** Minimum level that emits; default `info` (or the AZEROTH_LOG override). */
    level?: LevelThreshold | undefined;

    /** Output face; default `auto`. Ignored when `sink` is given. */
    face?: LoggerFace | undefined;

    /** A custom sink - a file writer, a collector adapter, a test spy. */
    sink?: LogSink | undefined;

    /** Fields bound to every record (service name, environment). */
    fields?: Record<string, unknown> | undefined;

    /** Top-level field names whose VALUES never reach a sink (replaced with '[redacted]'). */
    redact?: readonly string[] | undefined;

    /** Target stream for the built-in faces; default stdout/stderr. */
    stream?: WritableLike | undefined;
}

/** @internal Parses AZEROTH_LOG: "debug" | "json" | "pretty:trace" | "json:info". */
function envOverride(): { face?: LoggerFace; level?: LevelThreshold }
{
    const raw = typeof process === 'undefined' ? undefined : process.env.AZEROTH_LOG;
    if (raw === undefined || raw === '')
    {
        return {};
    }
    const out: { face?: LoggerFace; level?: LevelThreshold } = {};
    for (const part of raw.split(':'))
    {
        if (part === 'json' || part === 'ndjson')
        {
            out.face = 'ndjson';
        }
        else if (part === 'pretty')
        {
            out.face = 'pretty';
        }
        else if (part in LEVEL_RANK)
        {
            out.level = part as LevelThreshold;
        }
    }
    return out;
}

/** @internal Resolves `auto` to a concrete face for this runtime and stream. */
function resolveFace(face: LoggerFace, stream: WritableLike | undefined): 'pretty' | 'ndjson' | 'console'
{
    if (face !== 'auto')
    {
        return face;
    }
    if (typeof process === 'undefined')
    {
        return 'console';
    }
    const out = stream ?? process.stdout;
    const production = process.env.NODE_ENV === 'production';
    return out.isTTY === true && !production ? 'pretty' : 'ndjson';
}

/**
 * Builds a logger. See {@link LoggerOptions}; with no options at all you get `info`
 * level, pretty output on a dev TTY, and NDJSON everywhere else - the right default
 * for both a terminal and a container.
 */
export function createLogger(options: LoggerOptions = {}): Logger
{
    const override = envOverride();
    const threshold = LEVEL_RANK[override.level ?? options.level ?? 'info'];
    const redact = options.redact === undefined ? undefined : new Set(options.redact);

    const bound = shapeFields(options.fields ?? {}, redact);

    if (options.sink === undefined)
    {
        const face = resolveFace(override.face ?? options.face ?? 'auto', options.stream);
        if (face === 'ndjson')
        {
            // The production face gets the FUSED path: no record object, no per-call
            // re-serialization of bound context - a child's bindings become one cached
            // string fragment, the pino trick that makes contextual logging near-free.
            const stream = options.stream ?? (typeof process === 'undefined' ? undefined : process.stdout);
            return buildFused(stream, threshold, bound, redact);
        }
        const sink = face === 'pretty' ? prettySink({ stream: options.stream }) : consoleSink();
        return build(sink, threshold, bound, redact);
    }

    // Bound fields are shaped ONCE here (and again per child()); emit can then pass
    // them through untouched on the no-call-fields fast path.
    return build(options.sink, threshold, bound, redact);
}

/** @internal The one shared no-op for every disabled level - a call site pays a plain call. */
const NOOP = (): void => undefined;

/** @internal A level method: NOOP below the threshold, the real emitter at or above. */
function gate(rank: number, threshold: number, method: (message: string, fields?: Record<string, unknown>) => void): (message: string, fields?: Record<string, unknown>) => void
{
    return rank < threshold ? NOOP : method;
}

/**
 * @internal The fused NDJSON core: writes lines straight to the stream with the bound
 * context pre-serialized. Byte-identical output to build()+ndjsonSink - proven by the
 * shared serializer underneath - just without the intermediate record.
 */
function buildFused(
    stream: { write(chunk: string): unknown } | undefined,
    threshold: number,
    bound: Record<string, unknown>,
    redact: ReadonlySet<string> | undefined
): Logger
{
    const boundFragment = fieldsFragment(bound);

    function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void
    {
        let line = '{"level":"' + level + '","time":' + String(Date.now()) + ',"msg":' + quotedString(message) + boundFragment;
        if (fields !== undefined)
        {
            line += fieldsFragment(shapeFields(fields, redact));
        }
        stream?.write(line + '}\n');
    }

    return {
        trace: gate(10, threshold, (message, fields) => emit('trace', message, fields)),
        debug: gate(20, threshold, (message, fields) => emit('debug', message, fields)),
        info: gate(30, threshold, (message, fields) => emit('info', message, fields)),
        warn: gate(40, threshold, (message, fields) => emit('warn', message, fields)),
        error: gate(50, threshold, (message, fields) => emit('error', message, fields)),
        fatal: gate(60, threshold, (message, fields) => emit('fatal', message, fields)),
        child: (fields) => buildFused(stream, threshold, shapeFields({ ...bound, ...fields }, redact), redact),
        enabled: (level) => LEVEL_RANK[level] >= threshold
    };
}

/** @internal The recursive core: one closure set per logger/child. */
function build(sink: LogSink, threshold: number, bound: Record<string, unknown>, redact: ReadonlySet<string> | undefined): Logger
{
    const hasBound = Object.keys(bound).length > 0;

    function emit(level: LogLevel, rank: number, message: string, fields?: Record<string, unknown>): void
    {
        if (rank < threshold)
        {
            return;
        }
        const merged = fields === undefined
            ? bound
            : hasBound ? { ...bound, ...fields } : fields;
        const record: LogRecord =
        {
            level,
            message,
            time: Date.now(),
            // Bound context is pre-shaped and pre-redacted at construction; only a
            // merge that brought NEW call fields needs shaping here.
            fields: merged === bound ? merged : shapeFields(merged, redact)
        };
        sink(record);
    }

    return {
        trace: gate(10, threshold, (message, fields) => emit('trace', 10, message, fields)),
        debug: gate(20, threshold, (message, fields) => emit('debug', 20, message, fields)),
        info: gate(30, threshold, (message, fields) => emit('info', 30, message, fields)),
        warn: gate(40, threshold, (message, fields) => emit('warn', 40, message, fields)),
        error: gate(50, threshold, (message, fields) => emit('error', 50, message, fields)),
        fatal: gate(60, threshold, (message, fields) => emit('fatal', 60, message, fields)),
        child: (fields) => build(sink, threshold, shapeFields({ ...bound, ...fields }, redact), redact),
        enabled: (level) => LEVEL_RANK[level] >= threshold
    };
}
