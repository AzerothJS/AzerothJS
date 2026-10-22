/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Field shaping and the fast NDJSON line.
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
 *     diff and grep predictably. Redaction reads each value a rule reaches as JSON writes it, a
 *     toJSON() result too, so no key it names is written there; an error field keeps its own text.
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

/**
 * @internal How far below a field redaction walks before it gives the field up: no real record
 * nests this deep, and a value built as it is read would never end.
 */
const MAX_FIELD_DEPTH = 4096;

/** @internal What replaces a value no format can carry honestly. */
const UNSERIALIZABLE = '[unserializable]';

/** @internal What replaces a redacted value, in every face. */
const REDACTED = '[redacted]';

/** @internal A Date's built-in methods: a date written through them is a string. */
const DATE_TO_JSON: unknown = Reflect.get(Date.prototype, 'toJSON');
const DATE_TO_ISO: unknown = Reflect.get(Date.prototype, 'toISOString');
const DATE_VALUE_OF: unknown = Reflect.get(Date.prototype, 'valueOf');
const DATE_TO_PRIMITIVE: unknown = Reflect.get(Date.prototype, Symbol.toPrimitive);

/** @internal Node's Buffer.prototype.toJSON, absent in a browser: its form is `{ type, data }`. */
const BUFFER: unknown = Reflect.get(globalThis, 'Buffer');
const BUFFER_TO_JSON: unknown = typeof BUFFER === 'function' ? Reflect.get(BUFFER.prototype as object, 'toJSON') : undefined;

/** @internal A typed array's name from its slot, undefined for a DataView or a Proxy. */
const TYPED_ARRAY_NAME: unknown = Reflect.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, Symbol.toStringTag)?.get;

/** @internal JSON.isRawJSON where the platform has it. */
const IS_RAW_JSON: unknown = Reflect.get(JSON, 'isRawJSON');

/** @internal Keys a plain assignment could not set: read-only on a frozen Object.prototype. */
const DEFINED = new Set<string>();

/**
 * @internal What JSON unboxes a value by: the internal slot of a Number, String, Boolean or BigInt
 * (a subclass and another realm's box have it, a borrowed prototype does not), or a raw JSON value.
 */
function boxTag(value: object): 'number' | 'string' | 'boolean' | 'bigint' | 'raw' | null
{
    try
    {
        const proto: unknown = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === Array.prototype)
        {
            return null;
        }
        if (proto === null)
        {
            return typeof IS_RAW_JSON === 'function' && IS_RAW_JSON.call(JSON, value) === true ? 'raw' : null;
        }
        // The tag names a candidate; only the box's own valueOf proves the slot is there.
        switch (Object.prototype.toString.call(value))
        {
            case '[object Number]':
                Number.prototype.valueOf.call(value);
                return 'number';
            case '[object String]':
                String.prototype.valueOf.call(value);
                return 'string';
            case '[object Boolean]':
                Boolean.prototype.valueOf.call(value);
                return 'boolean';
            case '[object BigInt]':
                BigInt.prototype.valueOf.call(value);
                return 'bigint';
            default:
                return null;
        }
    }
    catch
    {
        return null;
    }
}

/** @internal The primitive JSON writes for a boxed toJSON result; a BigInt throws, as in JSON. */
function unboxed(form: object, tag: 'number' | 'string' | 'boolean' | 'bigint' | 'raw'): unknown
{
    switch (tag)
    {
        case 'number':
            // JSON writes a Number box through ToNumber, which unary plus is.
            return +(form as { valueOf(): number });
        case 'string':
            // eslint-disable-next-line @typescript-eslint/no-base-to-string -- ToString, as JSON
            return String(form);
        case 'boolean':
            return Boolean.prototype.valueOf.call(form);
        case 'bigint':
            throw CYCLE;
        default:
            return form;
    }
}

/** @internal One guarded read: a throwing getter or trap costs that value. Pretty face too. */
export function read(source: object, key: string): unknown
{
    try
    {
        return (source as Record<string, unknown>)[key];
    }
    catch
    {
        return UNSERIALIZABLE;
    }
}

/** @internal An object's own keys, none when a Proxy trap throws. Also for the pretty face. */
export function keysOf(source: object): string[]
{
    try
    {
        return Object.keys(source);
    }
    catch
    {
        return [];
    }
}

/** @internal Sets `key` as own data: `__proto__` or a frozen prototype's name stays data. */
function own(target: Record<string, unknown>, key: string, value: unknown): void
{
    if (key !== '__proto__' && (DEFINED.size === 0 || !DEFINED.has(key)))
    {
        try
        {
            target[key] = value;
            return;
        }
        catch
        {
            DEFINED.add(key);
        }
    }
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** @internal Copies `source`'s own keys into `target` one guarded read at a time. */
function copyInto(target: Record<string, unknown>, source: object): void
{
    for (const key of keysOf(source))
    {
        own(target, key, read(source, key));
    }
}

/** @internal One copied key; a callable toJSON stays behind, as JSON never asks a form's own. */
function put(out: Record<string, unknown>, key: string, value: unknown): void
{
    if (key !== 'toJSON' || typeof value !== 'function')
    {
        own(out, key, value);
    }
}

/**
 * @internal A toJSON result as a writer must hold it: a result with a callable toJSON, or one
 * that is an error, is copied without it, as JSON writes it, its reads guarded.
 */
function plainForm(form: object): object
{
    const toJSON = read(form, 'toJSON');
    if (typeof toJSON !== 'function' && toJSON !== UNSERIALIZABLE && !isError(form))
    {
        return form;
    }
    if (Array.isArray(form))
    {
        const items = form as unknown[];
        const copy: unknown[] = [];
        for (let index = 0; index < items.length; index++)
        {
            copy.push(read(items, String(index)));
        }
        return copy;
    }
    const out: Record<string, unknown> = {};
    for (const key of keysOf(form))
    {
        put(out, key, read(form, key));
    }
    return out;
}

/**
 * @internal The fields a record carries: none for a missing argument, else the object's JSON
 * form, a form with no keys under `fields`, so a config that hides its secrets hides them here.
 */
export function fieldsOf(fields: Record<string, unknown> | null | undefined): Record<string, unknown>
{
    if (fields === undefined || fields === null)
    {
        return {};
    }
    try
    {
        const toJSON: unknown = fields.toJSON;
        if (typeof toJSON !== 'function')
        {
            return fields;
        }
        const form: unknown = toJSON.call(fields, '');
        if (form === undefined || typeof form === 'function' || typeof form === 'symbol')
        {
            return {};
        }
        if (form === null || typeof form !== 'object')
        {
            return { fields: form };
        }
        const tag = boxTag(form);
        if (tag !== null)
        {
            return { fields: unboxed(form, tag) };
        }
        const plain = plainForm(form);
        return Array.isArray(plain) ? { fields: plain } : plain as Record<string, unknown>;
    }
    catch
    {
        return { fields: UNSERIALIZABLE };
    }
}

/** @internal Bound context with call fields over it; a throwing getter costs its value. */
export function mergeFields(bound: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown>
{
    try
    {
        return { ...bound, ...fields };
    }
    catch
    {
        const out: Record<string, unknown> = {};
        copyInto(out, bound);
        copyInto(out, fields);
        return out;
    }
}

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

/** @internal An instanceof that a revoked Proxy cannot throw out of. */
function isError(value: unknown): value is Error
{
    try
    {
        return value instanceof Error;
    }
    catch
    {
        return false;
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
    return shapeError(error, depth, undefined, '');
}

/** @internal errorShape for the field `key`, its cause matched and redacted by `plan`. */
function shapeError(error: Error, depth: number, plan: Plan | undefined, key: string): ErrorShape
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
        // A rule naming the cause slot hides the whole cause, whatever it holds.
        if (plan?.slot(key, depth) === true)
        {
            shape.cause = REDACTED;
        }
        else if (isError(cause))
        {
            shape.cause = shapeError(cause, depth + 1, plan, key);
        }
        else if (typeof cause === 'string')
        {
            shape.cause = cause;
        }
        else
        {
            const data = plan === undefined ? cause : plan.cause(cause, key, depth);
            shape.cause = data === GIVEN_UP ? UNSERIALIZABLE : jsonText(data) ?? UNSERIALIZABLE;
        }
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
    /**
     * Returns `fields` with every configured value replaced, copying only what changed. One from
     * {@link createRedactor} writes each value a rule reaches as JSON does, an error field aside.
     */
    apply(fields: Record<string, unknown>): Record<string, unknown>;
}

/** @internal Compiled redact paths, run by createRedactor's Redactor and by the logger. */
export interface Plan
{
    /** The fields redacted; with `snapshot`, every object the walk reads is copied as well. */
    apply(fields: Record<string, unknown>, snapshot: boolean): Record<string, unknown>;

    /** A cause that is data, redacted where it sits: `depth` causes below the field `key`. */
    cause(value: unknown, key: string, depth: number): unknown;

    /** True when a rule names the cause slot `depth` causes below the field `key`. */
    slot(key: string, depth: number): boolean;
}

/** @internal The plan behind each apply createRedactor built; a hand-written one has none. */
const PLANS = new WeakMap<object, Plan>();

/** @internal One node of the dotted-path prefix tree. */
interface PathNode
{
    /** A configured path ends here: this key's value is replaced whole. */
    leaf: boolean;

    children: Map<string, PathNode>;
}

/** @internal Thrown to give up a field JSON cannot write either: a cycle, or one with no end. */
const CYCLE = new TypeError('cyclic value');

/** @internal What a redaction step returns when it pushed a frame instead of finishing. */
const PENDING: unique symbol = Symbol('pending');

/** @internal What a walk returns when it gives its field up; written as '[unserializable]'. */
const GIVEN_UP: unique symbol = Symbol('given up');

/** @internal What a reused frame holds between walks. */
const RELEASED: object = {};

/** @internal How many frames a plan keeps for reuse once a walk is over. */
const KEPT_FRAMES = 64;

/** @internal Objects a field's walk opens, a shared one once per path, before it gives up. */
const MAX_FIELD_OBJECTS = 1048576;

/** @internal Path frames checked by a scan; a deeper frame's objects are kept in a set. */
const SCANNED_FRAMES = 32;

/** @internal Carriers a path may hold inside their own forms, below its scanned frames. */
const MAX_REENTRIES = 64;

/** @internal Key counts between which a finished copy is spread once, for V8's fast layout. */
const FAST_COPY_KEYS = 16;
const SPREAD_COPY_KEYS = 256;

/** @internal One object a walk is reading: its members, its copy and its plan position. */
interface Frame
{
    /** The object whose members are read: a value, or the form its toJSON returned. */
    source: object;

    /** The value whose toJSON returned `source`, carried in the record as that form, or null. */
    carrier: object | null;

    /** True when `carrier` also carries one of the nearest frames below this one. */
    reentry: boolean;

    /** Own enumerable keys, or null for an array, which is read by index as JSON reads it. */
    keys: string[] | null;

    length: number;

    index: number;

    /** The member at `index` as it was read, and whether a rule names it. */
    read: unknown;

    named: boolean;

    /** The copy, made from the first change (from the start for a snapshot). */
    out: unknown[] | Record<string, unknown> | null;

    node: PathNode;
}

/**
 * Builds a redaction plan from declared field paths. Matching is CASE-INSENSITIVE, a bare name
 * matches that key at ANY depth (`authorization` covers a node:http `{ headers: req.headers }`),
 * a dotted path (`headers.authorization`) matches exactly that position, and an array is
 * transparent to a path. Each value a rule reaches is read as JSON writes it, toJSON() and own
 * keys included; a field the walk cannot finish (a cycle, a throw, over 4096 levels or 1048576
 * objects) is '[unserializable]'. An error field is left to {@link shapeFields}, which keeps its
 * own text and hides its cause under a rule naming it (`err.cause`). Nothing is mutated in place.
 */
export function createRedactor(paths: readonly string[]): Redactor
{
    const plan = createPlan(paths);
    const apply = (fields: Record<string, unknown>): Record<string, unknown> => plan.apply(fields, false);
    PLANS.set(apply, plan);
    return { apply };
}

/** @internal The compiled paths behind {@link createRedactor}. */
export function createPlan(paths: readonly string[]): Plan
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

    // The path set a walk marks objects in, kept between calls; a nested call makes its own.
    let spare: Set<object> | null = null;

    // The objects the current field's walk has opened.
    let opened = 0;

    // The frames on the current path whose carrier came back inside its own form.
    let reentries = 0;

    /** A platform form no rule reaches: a date's string, a Buffer's bytes unless a key is named. */
    function fixed(value: object, toJSON: unknown, node: PathNode): boolean
    {
        if (toJSON === DATE_TO_JSON)
        {
            const date = value as { toISOString?: unknown; valueOf?: unknown; [Symbol.toPrimitive]?: unknown };
            return date.toISOString === DATE_TO_ISO && date.valueOf === DATE_VALUE_OF && date[Symbol.toPrimitive] === DATE_TO_PRIMITIVE;
        }
        return toJSON === BUFFER_TO_JSON && typeof TYPED_ARRAY_NAME === 'function' && TYPED_ARRAY_NAME.call(value) !== undefined
            && !names.has('type') && !names.has('data') && !node.children.has('type') && !node.children.has('data');
    }

    // Frames of the walks in progress, below `depth`; a nested call stacks its own above them,
    // and the frames past `depth` are kept to be reused. `reached` is how many hold a value.
    const stack: Frame[] = [];
    let depth = 0;
    let reached = 0;

    // The first frame of the field being walked: its path is the frames from here to `depth`.
    let floor = 0;

    /** True when `value` is on the field's path: a frame's object, by scan or by set. */
    function onPath(value: object, seen: Set<object>): boolean
    {
        const top = Math.min(depth, floor + SCANNED_FRAMES);
        for (let at = floor; at < top; at++)
        {
            const frame = stack[at] as Frame;
            if (frame.source === value)
            {
                return true;
            }
        }
        return depth - floor > SCANNED_FRAMES && seen.has(value);
    }

    /** True when `carrier` already carries one of the nearest frames on the field's path. */
    function reentered(carrier: object): boolean
    {
        const bottom = Math.max(floor, depth - SCANNED_FRAMES);
        for (let at = depth - 1; at >= bottom; at--)
        {
            if ((stack[at] as Frame).carrier === carrier)
            {
                return true;
            }
        }
        return false;
    }

    /**
     * One value as JSON writes it: the value itself when nothing below it needs reading, or
     * PENDING with a frame pushed for its members. Throws to give the field up.
     */
    function open(value: unknown, key: string | number, node: PathNode, top: boolean, seen: Set<object>, snapshot: boolean): unknown
    {
        if (value === null || typeof value !== 'object')
        {
            return value;
        }
        // Nothing configured can match below here, so the subtree is left alone.
        if (names.size === 0 && node.children.size === 0)
        {
            return value;
        }
        // A field's own error is written by errorShape, before any toJSON it has is asked.
        if (top && isError(value))
        {
            return value;
        }
        const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
        if (typeof toJSON !== 'function')
        {
            return push(value, null, node, seen, snapshot);
        }
        if (fixed(value, toJSON, node))
        {
            return value;
        }
        // JSON writes what toJSON returns, so the form is carried and no writer asks again.
        const json: unknown = toJSON.call(value, typeof key === 'number' ? String(key) : key);
        if (json === null || typeof json !== 'object')
        {
            // A field whose form JSON cannot write keeps the text the writers give it.
            return top && (json === undefined || typeof json === 'function' || typeof json === 'symbol') ? GIVEN_UP : json;
        }
        const tag = boxTag(json);
        if (tag !== null)
        {
            return unboxed(json, tag);
        }
        return push(json, value, node, seen, snapshot);
    }

    /** Puts `source` on the path with a frame for its members; a value already on it is a cycle. */
    function push(source: object, carrier: object | null, node: PathNode, seen: Set<object>, snapshot: boolean): unknown
    {
        if (onPath(source, seen))
        {
            throw CYCLE;
        }
        // JSON writes a shared object once per path, so a small value can stand for an endless one.
        if (++opened > MAX_FIELD_OBJECTS)
        {
            throw CYCLE;
        }
        // JSON writes a box or a raw JSON value as its primitive, never its own keys.
        if (!Array.isArray(source) && boxTag(source) !== null)
        {
            return source;
        }
        let reentry = false;
        if (depth - floor >= SCANNED_FRAMES)
        {
            // JSON follows a toJSON answering a new holder of itself until its stack runs out.
            reentry = carrier !== null && reentered(carrier);
            if (reentry && ++reentries > MAX_REENTRIES)
            {
                throw CYCLE;
            }
            seen.add(source);
        }
        const keys = Array.isArray(source) ? null : Object.keys(source);
        const length = keys === null ? (source as unknown[]).length : keys.length;
        const out = snapshot ? keys === null ? [] : {} : null;
        const frame = stack[depth];
        if (frame === undefined)
        {
            stack.push({ source, carrier, reentry, keys, length, index: 0, read: undefined, named: false, out, node });
        }
        else
        {
            frame.source = source;
            frame.carrier = carrier;
            frame.reentry = reentry;
            frame.keys = keys;
            frame.length = length;
            frame.index = 0;
            frame.out = out;
            frame.node = node;
        }
        depth++;
        if (depth > reached)
        {
            reached = depth;
        }
        return PENDING;
    }

    /** After the outermost walk: the frames let go of what they read, and only a few are kept. */
    function settle(): void
    {
        if (stack.length > KEPT_FRAMES)
        {
            stack.length = KEPT_FRAMES;
        }
        const held = Math.min(reached, stack.length);
        for (let at = 0; at < held; at++)
        {
            const frame = stack[at] as Frame;
            frame.source = RELEASED;
            frame.carrier = null;
            frame.keys = null;
            frame.read = undefined;
            frame.out = null;
        }
        reached = 0;
    }

    /**
     * Reads the frame's members from its index on; true when one needs a frame of its own,
     * which is then on top, with this frame's place kept for the result.
     */
    function run(frame: Frame, seen: Set<object>, snapshot: boolean): boolean
    {
        const { source, keys, length, node } = frame;
        let index = frame.index;
        let out = frame.out;
        for (; index < length; index++)
        {
            let read: unknown = undefined;
            let named = false;
            let walked: unknown = REDACTED;
            if (keys === null)
            {
                read = (source as unknown[])[index];
                walked = open(read, index, node, false, seen, snapshot);
            }
            else
            {
                const key = keys[index] as string;
                const folded = key.toLowerCase();
                const child = node.children.get(folded);
                // A configured key is replaced unread, so its getter never runs.
                named = names.has(folded) || child?.leaf === true;
                if (!named)
                {
                    read = (source as Record<string, unknown>)[key];
                    walked = open(read, key, child ?? EMPTY, false, seen, snapshot);
                }
            }
            if (walked === PENDING)
            {
                frame.index = index;
                frame.out = out;
                frame.read = read;
                frame.named = named;
                return true;
            }
            if (out === null)
            {
                if (!named && walked === read)
                {
                    continue;
                }
                out = earlier(frame, index);
            }
            if (keys === null)
            {
                (out as unknown[]).push(walked);
            }
            else
            {
                put(out as Record<string, unknown>, keys[index] as string, walked);
            }
        }
        frame.index = length;
        frame.out = out;
        return false;
    }

    /** Takes the walked value of the frame's current member, copying from the first change. */
    function accept(frame: Frame, walked: unknown): void
    {
        const index = frame.index;
        frame.index = index + 1;
        if (frame.out === null)
        {
            if (!frame.named && walked === frame.read)
            {
                return;
            }
            frame.out = earlier(frame, index);
        }
        if (frame.keys === null)
        {
            (frame.out as unknown[]).push(walked);
        }
        else
        {
            put(frame.out as Record<string, unknown>, frame.keys[index] as string, walked);
        }
    }

    /** A copy of the members before `index`, read again from the source. */
    function earlier(frame: Frame, index: number): unknown[] | Record<string, unknown>
    {
        if (frame.keys === null)
        {
            const items = frame.source as unknown[];
            const out: unknown[] = [];
            for (let at = 0; at < index; at++)
            {
                out.push(items[at]);
            }
            return out;
        }
        const record = frame.source as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (let at = 0; at < index; at++)
        {
            const key = frame.keys[at] as string;
            put(out, key, record[key]);
        }
        return out;
    }

    /** Takes a finished frame off the path: its copy, or its source when nothing changed. */
    function finish(frame: Frame, seen: Set<object>): unknown
    {
        depth--;
        if (depth - floor >= SCANNED_FRAMES)
        {
            seen.delete(frame.source);
            if (frame.reentry)
            {
                reentries--;
            }
        }
        let out = frame.out ?? frame.source;
        if (frame.out !== null && frame.keys !== null && frame.keys.length > FAST_COPY_KEYS && frame.keys.length <= SPREAD_COPY_KEYS)
        {
            out = { ...(frame.out as Record<string, unknown>) };
        }
        if (frame.carrier !== null)
        {
            out = plainForm(out);
        }
        return out;
    }

    /**
     * One field read to the end without recursion: its JSON form, or GIVEN_UP at a cycle, a
     * throw, or past the depth or object limit, where JSON fails on the field or would not end.
     */
    function field(value: unknown, node: PathNode, seen: Set<object>, snapshot: boolean): unknown
    {
        const base = depth;
        const outerFloor = floor;
        const outerOpened = opened;
        const outerReentries = reentries;
        floor = base;
        opened = 0;
        reentries = 0;
        try
        {
            let result = open(value, '', node, true, seen, snapshot);
            while (depth > base)
            {
                if (depth - base > MAX_FIELD_DEPTH)
                {
                    throw CYCLE;
                }
                const frame = stack[depth - 1] as Frame;
                if (result !== PENDING)
                {
                    accept(frame, result);
                }
                result = run(frame, seen, snapshot) ? PENDING : finish(frame, seen);
            }
            if (base === 0)
            {
                settle();
            }
            return result;
        }
        catch
        {
            depth = base;
            seen.clear();
            if (base === 0)
            {
                settle();
            }
            return GIVEN_UP;
        }
        finally
        {
            floor = outerFloor;
            opened = outerOpened;
            reentries = outerReentries;
        }
    }

    function apply(fields: Record<string, unknown>, snapshot: boolean): Record<string, unknown>
    {
        const seen = spare ?? new Set<object>();
        spare = null;
        const keys = keysOf(fields);
        let out: Record<string, unknown> | null = snapshot ? {} : null;
        for (let index = 0; index < keys.length; index++)
        {
            const key = keys[index] as string;
            const folded = key.toLowerCase();
            const child = root.children.get(folded);
            let value: unknown = REDACTED;
            let walked: unknown = REDACTED;
            const named = names.has(folded) || child?.leaf === true;
            if (!named)
            {
                value = read(fields, key);
                walked = value === UNSERIALIZABLE ? value : field(value, child ?? EMPTY, seen, snapshot);
                if (walked === GIVEN_UP)
                {
                    walked = UNSERIALIZABLE;
                }
            }
            if (out === null)
            {
                if (!named && walked === value)
                {
                    continue;
                }
                out = {};
                for (let earlier = 0; earlier < index; earlier++)
                {
                    const earlierKey = keys[earlier] as string;
                    own(out, earlierKey, read(fields, earlierKey));
                }
            }
            own(out, key, walked);
        }
        spare = seen;
        if (out === null)
        {
            return fields;
        }
        return keys.length > FAST_COPY_KEYS && keys.length <= SPREAD_COPY_KEYS ? { ...out } : out;
    }

    /** The plan node of the cause slot `depth` causes below the field `key`. */
    function slotNode(key: string, depth: number): PathNode
    {
        let node = root.children.get(key.toLowerCase()) ?? EMPTY;
        for (let hop = 0; hop <= depth; hop++)
        {
            node = node.children.get('cause') ?? EMPTY;
        }
        return node;
    }

    function cause(value: unknown, key: string, depth: number): unknown
    {
        const seen = spare ?? new Set<object>();
        spare = null;
        const out = field(value, slotNode(key, depth), seen, false);
        spare = seen;
        return out;
    }

    function slot(key: string, depth: number): boolean
    {
        return names.has('cause') || slotNode(key, depth).leaf;
    }

    return { apply, cause, slot };
}

/**
 * @internal Fields redacted by the logger's plan and every Error given a shape; with `snapshot`
 * (bound context) every object redaction read is copied, as the NDJSON face's fragment holds it.
 */
export function shapeWith(fields: Record<string, unknown>, plan: Plan | undefined, snapshot: boolean): Record<string, unknown>
{
    return shapeErrors(plan === undefined ? fields : plan.apply(fields, snapshot), plan);
}

/** @internal Every Error field given a real shape, its cause matched by `plan`. */
function shapeErrors(out: Record<string, unknown>, plan: Plan | undefined): Record<string, unknown>
{
    let shaped: Record<string, unknown> | null = null;
    for (const key of keysOf(out))
    {
        const value = read(out, key);
        if (value === null || typeof value !== 'object' || !isError(value))
        {
            continue;
        }
        shaped ??= mergeFields(out, {});
        own(shaped, key, shapeError(value, 0, plan, key));
    }
    return shaped ?? out;
}

/**
 * Returns fields with every Error given a real shape, its own text kept, and every redacted path
 * replaced, copying only what changed; a {@link createRedactor} Redactor reaches causes too.
 */
export function shapeFields(fields: Record<string, unknown>, redact?: Redactor): Record<string, unknown>
{
    if (redact === undefined)
    {
        return shapeErrors(fields, undefined);
    }
    const apply: unknown = Reflect.get(redact, 'apply');
    const plan = typeof apply === 'function' ? PLANS.get(apply) : undefined;
    if (plan !== undefined)
    {
        return shapeErrors(plan.apply(fields, false), plan);
    }
    const applied: Record<string, unknown> = Reflect.apply(apply as Redactor['apply'], redact, [fields]);
    return shapeErrors(applied, undefined);
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
    for (const key of keysOf(fields))
    {
        out += ',' + quoted(key) + ':' + jsonValue(read(fields, key));
    }
    return out;
}

/** @internal Message quoting for the fused emit path (the same guarded fast path). */
export function quotedString(value: string): string
{
    return quoted(value);
}
