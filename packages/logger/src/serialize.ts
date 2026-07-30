/**
 * MODULE: logger/serialize - field shaping and the fast NDJSON line
 *
 * Two jobs, both correctness-critical:
 *
 *   - SHAPING. Errors JSON.stringify as `{}`; here they become { name, message, stack }
 *     with the full `cause` chain walked (depth-capped - a cyclic cause must not hang a
 *     log call). Redaction replaces configured field paths BEFORE any sink sees the
 *     record, so a secret never exists in a formatted line. Nothing here throws: a
 *     BigInt, a cycle, a throwing getter or toJSON degrades to '[unserializable]',
 *     because a log call that throws takes the caller's request with it.
 *
 *   - THE LINE. The NDJSON serializer builds each line by hand with the escape-guarded
 *     string fast path (the same technique @azerothjs/http's jsonEncoder proved): a plain
 *     string field costs a regex test and two quotes, never a C++ JSON.stringify crossing.
 *     Field order is stable (level, time, msg, then fields in insertion order), so lines
 *     diff and grep predictably. The serializer and the redactor read the SAME key set
 *     (own enumerable keys), so no key can be emitted that redaction never inspected.
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

/** @internal How deep a cause chain serializes before it is cut off. Shared with the pretty face. */
export const MAX_CAUSE_DEPTH = 5;

/** @internal What replaces a value no format can carry honestly. */
const UNSERIALIZABLE = '[unserializable]';

/** @internal What replaces a redacted value, in every face. */
const REDACTED = '[redacted]';

/** @internal How deep redaction descends into nested field values. */
const MAX_REDACT_DEPTH = 6;

/** The serialized shape of an Error, cause chain included. */
export interface ErrorShape
{
    name: string;
    message: string;
    stack?: string;
    cause?: ErrorShape | string;
}

/**
 * @internal JSON text for one value, or undefined when no honest text exists. A BigInt, a
 * cycle, a throwing `toJSON` and a throwing getter all make JSON.stringify throw; the retry
 * spends a replacer only on the failing value, so the common path keeps the native fast one.
 * Shared with the pretty face, which renders structures as JSON on the line.
 */
export function jsonText(value: unknown): string | undefined
{
    try
    {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for functions/symbols despite its declared type
        return JSON.stringify(value) ?? undefined;
    }
    catch
    {
        try
        {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- as above
            return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? String(item) : item)) ?? undefined;
        }
        catch
        {
            return undefined;
        }
    }
}

/** @internal A property read that survives a throwing getter (an Error may define one). */
function readText(error: Error, key: 'name' | 'message' | 'stack'): string | undefined
{
    try
    {
        const value: unknown = error[key];
        return typeof value === 'string' ? value : undefined;
    }
    catch
    {
        return undefined;
    }
}

/** @internal The `cause` read, isolated for the same reason as {@link readText}. */
function readCause(error: Error): unknown
{
    try
    {
        return error.cause;
    }
    catch
    {
        return undefined;
    }
}

/**
 * Serializes an Error into the `{ name, message, stack, cause }` shape sinks render -
 * JSON.stringify alone turns an Error into `{}`. The cause chain is walked to a fixed
 * depth so a cyclic cause can never hang a log call, and every read is isolated: an
 * Error carrying a throwing `stack`/`cause` getter still logs.
 */
export function errorShape(error: Error, depth = 0): ErrorShape
{
    const shape: ErrorShape = { name: readText(error, 'name') ?? 'Error', message: readText(error, 'message') ?? '' };
    const stack = readText(error, 'stack');
    if (stack !== undefined)
    {
        shape.stack = stack;
    }
    const cause = readCause(error);
    if (cause !== undefined && depth < MAX_CAUSE_DEPTH)
    {
        shape.cause = cause instanceof Error
            ? errorShape(cause, depth + 1)
            : typeof cause === 'string'
                ? cause
                : jsonText(cause) ?? UNSERIALIZABLE;
    }
    return shape;
}

/**
 * A prepared redaction plan: the field paths whose values are replaced before any sink
 * runs. Build it once per logger with {@link createRedactor} and hand it to
 * {@link shapeFields}.
 */
export interface Redactor
{
    /** Returns `fields` with every configured value replaced, copying only what changed. */
    apply(fields: Record<string, unknown>): Record<string, unknown>;
}

/** @internal One node of the dotted-path prefix tree. */
interface PathNode
{
    /** A configured path ends here: this key's value is replaced whole. */
    leaf: boolean;

    children: Map<string, PathNode>;
}

/** @internal Only a plain object is walked: a class instance's own shape is its business. */
function isPlainObject(value: object): boolean
{
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Builds a redaction plan from declared field paths. Matching is CASE-INSENSITIVE (the
 * canonical HTTP casing `Authorization` is the same secret as `authorization`), a bare name
 * matches that key at ANY depth (so `{ headers: req.headers }` is covered by `authorization`,
 * which is how a request is actually logged), a dotted path (`headers.authorization`) matches
 * exactly that position, and an array is transparent to a path (`items.token` covers every
 * element). Descent is depth-capped and cycle-aware; nothing is ever mutated in place - the
 * application's own objects (a live request's headers) come back untouched.
 */
export function createRedactor(paths: readonly string[]): Redactor
{
    const names = new Set<string>();
    const root: PathNode = { leaf: false, children: new Map() };

    for (const path of paths)
    {
        const segments = path.toLowerCase().split('.').filter((segment) => segment !== '');
        const first = segments[0];
        if (first === undefined)
        {
            continue;
        }
        if (segments.length === 1)
        {
            names.add(first);
            continue;
        }
        let node = root;
        for (const segment of segments)
        {
            let child = node.children.get(segment);
            if (child === undefined)
            {
                child = { leaf: false, children: new Map() };
                node.children.set(segment, child);
            }
            node = child;
        }
        node.leaf = true;
    }

    const EMPTY: PathNode = { leaf: false, children: new Map() };

    function descend(value: unknown, node: PathNode, depth: number, seen: Set<object>): unknown
    {
        if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== 'object')
        {
            return value;
        }
        // Nothing configured can match below here, so the subtree is left alone.
        if (names.size === 0 && node.children.size === 0)
        {
            return value;
        }
        if (seen.has(value))
        {
            return value; // a cycle: the serializer answers for it, the walk must not loop
        }
        seen.add(value);
        let out: unknown = value;
        if (Array.isArray(value))
        {
            let copy: unknown[] | null = null;
            for (let index = 0; index < value.length; index++)
            {
                const item: unknown = value[index];
                const walked = descend(item, node, depth + 1, seen);
                if (walked !== item)
                {
                    copy ??= [...(value as unknown[])];
                    copy[index] = walked;
                }
            }
            out = copy ?? value;
        }
        else if (isPlainObject(value))
        {
            out = walk(value as Record<string, unknown>, node, depth + 1, seen);
        }
        seen.delete(value);
        return out;
    }

    function walk(source: Record<string, unknown>, node: PathNode, depth: number, seen: Set<object>): Record<string, unknown>
    {
        let out = source;
        for (const key of Object.keys(source))
        {
            const folded = key.toLowerCase();
            const child = node.children.get(folded);
            const value = source[key];
            let replacement: unknown;
            if (names.has(folded) || child?.leaf === true)
            {
                replacement = REDACTED;
            }
            else
            {
                replacement = descend(value, child ?? EMPTY, depth, seen);
                if (replacement === value)
                {
                    continue;
                }
            }
            if (out === source)
            {
                out = { ...source };
            }
            out[key] = replacement;
        }
        return out;
    }

    return {
        apply: (fields: Record<string, unknown>): Record<string, unknown> => walk(fields, root, 0, new Set<object>())
    };
}

/**
 * Returns fields with every Error given a real shape and every redacted path replaced.
 * Copies lazily - the common record (no errors, nothing redacted) passes through untouched.
 */
export function shapeFields(fields: Record<string, unknown>, redact?: Redactor): Record<string, unknown>
{
    let out = redact === undefined ? fields : redact.apply(fields);
    for (const key of Object.keys(out))
    {
        const value = out[key];
        if (!(value instanceof Error))
        {
            continue;
        }
        if (out === fields)
        {
            out = { ...fields };
        }
        out[key] = errorShape(value);
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
    // JSON has no bigint, and an application that keeps money in one must still be able to
    // log it: the decimal digits are the fact, as a string.
    if (typeof value === 'bigint')
    {
        return quoted(String(value));
    }
    return jsonText(value) ?? quoted(UNSERIALIZABLE);
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
    // OWN keys only: `for...in` would emit inherited ones, which redaction (own keys, like
    // every other reader of a fields object) never saw - a secret on the prototype would
    // reach the sink in cleartext.
    for (const key of Object.keys(fields))
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
