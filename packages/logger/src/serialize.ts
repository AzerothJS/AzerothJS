/**
 * MODULE: logger/serialize - field shaping and the fast NDJSON line
 *
 * Two jobs, both correctness-critical:
 *
 *   - SHAPING. Errors JSON.stringify as `{}`; here they become { name, message, stack }
 *     with the full `cause` chain walked (depth-capped - a cyclic cause must not hang a
 *     log call). Redaction replaces configured field paths BEFORE any sink sees the
 *     record, so a secret never exists in a formatted line.
 *
 *   - THE LINE. The NDJSON serializer builds each line by hand with the escape-guarded
 *     string fast path (the same technique @azerothjs/http's jsonEncoder proved): a plain
 *     string field costs a regex test and two quotes, never a C++ JSON.stringify crossing.
 *     Field order is stable (level, time, msg, then fields in insertion order), so lines
 *     diff and grep predictably.
 */

import type { LogRecord } from './record.ts';

/** @internal Strings needing JSON.stringify: quotes, backslash, control chars, surrogates. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what the guard must detect
const NEEDS_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/** @internal Quote a string the fast way when clean, the correct way when not. */
function quoted(value: string): string
{
    return NEEDS_ESCAPE.test(value) ? JSON.stringify(value) : '"' + value + '"';
}

/** @internal How deep a cause chain serializes before it is cut off. */
const MAX_CAUSE_DEPTH = 5;

/** The serialized shape of an Error, cause chain included. */
export interface ErrorShape
{
    name: string;
    message: string;
    stack?: string;
    cause?: ErrorShape | string;
}

/** Serializes an Error with its `cause` chain (depth-capped against cycles). */
export function errorShape(error: Error, depth = 0): ErrorShape
{
    const shape: ErrorShape = { name: error.name, message: error.message };
    if (error.stack !== undefined)
    {
        shape.stack = error.stack;
    }
    if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH)
    {
        shape.cause = error.cause instanceof Error
            ? errorShape(error.cause, depth + 1)
            : typeof error.cause === 'string'
                ? error.cause
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for functions/symbols despite its declared type
                : JSON.stringify(error.cause) ?? '[unserializable]';
    }
    return shape;
}

/**
 * Returns fields with every Error given a real shape and every redacted path replaced.
 * Copies lazily - the common record (no errors, nothing redacted) passes through untouched.
 */
export function shapeFields(fields: Record<string, unknown>, redact?: ReadonlySet<string>): Record<string, unknown>
{
    let out = fields;
    for (const key of Object.keys(fields))
    {
        const value = fields[key];
        const redacted = redact !== undefined && redact.has(key);
        if (!redacted && !(value instanceof Error))
        {
            continue;
        }
        if (out === fields)
        {
            out = { ...fields };
        }
        out[key] = redacted ? '[redacted]' : errorShape(value as Error);
    }
    return out;
}

/** @internal One JSON value, string fast path first; undefined becomes null (JSON has no undefined). */
function jsonValue(value: unknown): string
{
    if (typeof value === 'string')
    {
        return quoted(value);
    }
    if (typeof value === 'number')
    {
        return Number.isFinite(value) ? String(value) : 'null';
    }
    if (value === true)
    {
        return 'true';
    }
    if (value === false)
    {
        return 'false';
    }
    if (value === null || value === undefined)
    {
        return 'null';
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for functions/symbols despite its declared type
    return JSON.stringify(value) ?? 'null';
}

/**
 * One NDJSON line for a record: `{"level":...,"time":...,"msg":...,<fields>}` plus the
 * newline. Stable key order; fields serialize in insertion order (bound context first,
 * call fields after - the logger merges them that way).
 */
export function ndjsonLine(record: LogRecord): string
{
    return '{"level":"' + record.level + '","time":' + String(record.time) + ',"msg":' + quoted(record.message)
        + fieldsFragment(record.fields) + '}\n';
}

/**
 * The `,"key":value` fragment for a fields object - the shared serializer behind
 * {@link ndjsonLine} and the logger's fused fast path (which caches a child's bound
 * fragment ONCE instead of re-serializing the same bindings on every record).
 */
export function fieldsFragment(fields: Record<string, unknown>): string
{
    let out = '';
    for (const key in fields)
    {
        out += ',' + quoted(key) + ':' + jsonValue(fields[key]);
    }
    return out;
}

/** @internal Message quoting for the fused emit path (the same guarded fast path). */
export function quotedString(value: string): string
{
    return quoted(value);
}
