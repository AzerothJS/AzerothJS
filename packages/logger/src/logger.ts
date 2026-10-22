/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The core, and the face selection.
 *
 * createLogger() builds a logger over a sink. The design promises exactly two things:
 *
 *   - A DISABLED level costs one integer comparison. No record object, no field merge,
 *     no Date.now() - `log.trace(...)` in a hot loop with level=info is free. This is
 *     the property that makes leaving instrumentation in production code acceptable.
 *   - FACE SELECTION is automatic and honest. On a TTY outside production the pretty
 *     face renders; piped, in production, or under a collector, byte-clean NDJSON.
 *     `AZEROTH_LOG` overrides face and level from the environment without touching
 *     code: `AZEROTH_LOG=debug`, `AZEROTH_LOG=json`, `AZEROTH_LOG=pretty:trace`. The
 *     face component targets the AMBIENT terminal only - a logger built over an
 *     explicit `stream` (a log file) keeps its code-chosen face, so no environment
 *     can repoint pretty prose into a machine-read file. The level component always
 *     applies.
 *
 * Redaction happens in the logger: a value a rule reaches and names is replaced before any sink
 * runs, so the NDJSON, file and pretty faces never write it; an error field keeps its own text.
 */

import type { LevelThreshold, Logger, LogLevel, LogRecord, LogSink } from './record.ts';
import { LEVEL_RANK } from './record.ts';
import type { WritableLike } from './sinks.ts';
import { consoleSink, ndjsonSink, prettySink } from './sinks.ts';
import type { Plan } from './serialize.ts';
import { createPlan, fieldsFragment, fieldsOf, keysOf, mergeFields, quotedString, shapeWith } from './serialize.ts';

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

    /**
     * Field paths whose values become '[redacted]' before any sink runs, in what JSON writes; an
     * error field keeps its own text. Case-insensitive; a bare name matches at any depth
     * (`authorization` covers a node:http `{ headers: req.headers }`), a dotted path matches only
     * that position (`user.password`), and an array is transparent (`items.token`, every element).
     */
    redact?: readonly string[] | undefined;

    /**
     * Target stream for the built-in faces; default stdout/stderr. An explicit stream
     * also pins the face against `AZEROTH_LOG` - the env face component only applies
     * to the default stdio, so a file target can never be repointed to pretty prose.
     */
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
    // A browser has no `process`; some bundlers shim a PARTIAL one (env only, no stdout).
    // Either way there is no writable TTY, so the browser face is the console sink.
    const out = stream ?? (typeof process === 'undefined' ? undefined : process.stdout);
    if (out === undefined)
    {
        return 'console';
    }
    const production = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
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
    const plan = options.redact === undefined ? undefined : createPlan(options.redact);

    const bound = shapeWith(fieldsOf(options.fields), plan, true);

    if (options.sink === undefined)
    {
        // The env face targets the ambient terminal; an explicit stream keeps its
        // code-chosen face (a FileStream stays NDJSON no matter what AZEROTH_LOG says).
        const envFace = options.stream === undefined ? override.face : undefined;
        const face = resolveFace(envFace ?? options.face ?? 'auto', options.stream);
        if (face === 'ndjson')
        {
            // The production face gets the FUSED path: no record object, no per-call
            // re-serialization of bound context - a child's bindings become one cached
            // string fragment, the pino trick that makes contextual logging near-free.
            const stream = options.stream ?? (typeof process === 'undefined' ? undefined : process.stdout);
            return buildFused(stream, threshold, bound, plan);
        }
        const sink = face === 'pretty' ? prettySink({ stream: options.stream }) : consoleSink();
        return build(sink, threshold, bound, plan);
    }

    // Bound fields are shaped ONCE here (and again per child()); emit can then pass
    // them through untouched on the no-call-fields fast path.
    return build(options.sink, threshold, bound, plan);
}

/**
 * The sink the terminal gets under the automatic rules, env override included:
 * pretty on a dev TTY or under `AZEROTH_LOG=pretty`, byte-clean NDJSON when piped
 * or in production, the console face in a browser. This is the terminal half of a
 * tee - `teeSink(terminalSink(), fileSink('logs/'))` - and the ONE construction
 * that still follows the env face after createLogger stopped applying it to
 * explicit streams: here the stream IS the terminal, so repointing it is exactly
 * what the environment is entitled to do.
 *
 * @param stream - The terminal stream; default stdout (stderr routing for
 *   warn+ stays the pretty face's own behavior).
 * @returns A sink for the resolved face.
 */
export function terminalSink(stream?: WritableLike): LogSink
{
    const face = resolveFace(envOverride().face ?? 'auto', stream);
    return face === 'pretty' ? prettySink({ stream })
        : face === 'console' ? consoleSink()
            : ndjsonSink({ stream });
}

/** @internal A child's bound context: its bindings shaped and redacted once, over its parent's. */
function bind(bound: Record<string, unknown>, fields: Record<string, unknown> | undefined, plan: Plan | undefined): Record<string, unknown>
{
    return plan === undefined
        ? shapeWith(mergeFields(bound, fieldsOf(fields)), undefined, true)
        : mergeFields(bound, shapeWith(fieldsOf(fields), plan, true));
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
    plan: Plan | undefined
): Logger
{
    const boundFragment = fieldsFragment(bound);

    function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void
    {
        let line = '{"level":"' + level + '","time":' + String(Date.now()) + ',"msg":' + quotedString(message) + boundFragment;
        if (fields !== undefined)
        {
            line += fieldsFragment(shapeWith(fieldsOf(fields), plan, false));
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
        child: (fields) => buildFused(stream, threshold, bind(bound, fields, plan), plan),
        enabled: (level) => LEVEL_RANK[level] >= threshold
    };
}

/** @internal The recursive core: one closure set per logger/child. */
function build(sink: LogSink, threshold: number, bound: Record<string, unknown>, plan: Plan | undefined): Logger
{
    const hasBound = keysOf(bound).length > 0;

    function emit(level: LogLevel, rank: number, message: string, fields?: Record<string, unknown>): void
    {
        if (rank < threshold)
        {
            return;
        }
        // Bound context is shaped and redacted when it is bound. With no rule the merged
        // object is shaped; under a rule the call fields are, then merged over it.
        let merged = bound;
        if (fields !== undefined && plan === undefined)
        {
            const given = fieldsOf(fields);
            merged = shapeWith(hasBound ? mergeFields(bound, given) : given, undefined, false);
        }
        else if (fields !== undefined)
        {
            const shaped = shapeWith(fieldsOf(fields), plan, false);
            merged = hasBound ? mergeFields(bound, shaped) : shaped;
        }
        const record: LogRecord = { level, message, time: Date.now(), fields: merged };
        try
        {
            sink(record);
        }
        catch
        {
            // Logging must never break the system: a broken destination is the sink's
            // problem, not the caller's. teeSink isolates each destination the same way.
        }
    }

    return {
        trace: gate(10, threshold, (message, fields) => emit('trace', 10, message, fields)),
        debug: gate(20, threshold, (message, fields) => emit('debug', 20, message, fields)),
        info: gate(30, threshold, (message, fields) => emit('info', 30, message, fields)),
        warn: gate(40, threshold, (message, fields) => emit('warn', 40, message, fields)),
        error: gate(50, threshold, (message, fields) => emit('error', 50, message, fields)),
        fatal: gate(60, threshold, (message, fields) => emit('fatal', 60, message, fields)),
        child: (fields) => build(sink, threshold, bind(bound, fields, plan), plan),
        enabled: (level) => LEVEL_RANK[level] >= threshold
    };
}
