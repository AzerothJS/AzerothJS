/**
 * MODULE: logger/record - the wire contract
 *
 * One log event is a LEVEL, a MESSAGE, a TIME, and a flat FIELDS object - nothing else.
 * Everything in the package is a function over that record: the logger produces them, a
 * sink consumes them, the two faces (pretty, NDJSON) are just different sinks. Keeping the
 * record this small is what lets `@azerothjs/http` treat logging as an interface and lets
 * an application adapt any collector in five lines.
 *
 * The level set is a superset of the http kernel's (`trace` below debug for wire-level
 * detail, `fatal` above error for process-ending failures), so a logger from this package
 * satisfies the kernel's structural `Logger` interface as-is.
 */

/** Severity, lowest to highest. `silent` is a THRESHOLD only - no record carries it. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** A level threshold: every LogLevel, or silent (drop everything). */
export type LevelThreshold = LogLevel | 'silent';

/**
 * Numeric ranks, spaced pino-style so a collector mixing sources sorts sensibly.
 * @internal
 */
export const LEVEL_RANK: Record<LevelThreshold, number> =
{
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
    silent: Number.POSITIVE_INFINITY
};

/** One log event - the contract between loggers and sinks. */
export interface LogRecord
{
    level: LogLevel;

    message: string;

    /** Epoch milliseconds; the sink chooses the presentation. */
    time: number;

    /** Bound context (child loggers) merged with the call's fields. */
    fields: Record<string, unknown>;
}

/** A sink consumes records; where they go is its business entirely. */
export type LogSink = (record: LogRecord) => void;

/** The logger surface. Structurally a superset of @azerothjs/http's Logger. */
export interface Logger
{
    trace(message: string, fields?: Record<string, unknown>): void;
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    fatal(message: string, fields?: Record<string, unknown>): void;

    /** A logger with `fields` merged into every record - request/job context binds once. */
    child(fields: Record<string, unknown>): Logger;

    /** True when `level` would emit - guard EXPENSIVE field construction, not plain calls. */
    enabled(level: LogLevel): boolean;
}
