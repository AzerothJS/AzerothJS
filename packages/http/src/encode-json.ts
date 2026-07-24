/**
 * MODULE: http/encode-json - responses compiled from a schema declaration
 *
 * `json(data)` walks the value at runtime - JSON.stringify introspects every key of every
 * response. But an API route's response shape is usually DECLARED already (the same
 * declaration that validates it). jsonEncoder() compiles that declaration ONCE into a
 * serializer specialized to the shape - key strings prebuilt, field order fixed, primitive
 * fields encoded inline with escape-guarded quoting - and returns a constructor producing
 * the kernel's lazy Response. The declaration-driven twin of `readValidated`: one reads the
 * boundary through the schema, the other writes it.
 *
 * Same structural-typing stance as readValidated's SchemaLike: `@azerothjs/schema`'s Schema
 * satisfies {@link EncodableSchema} without an import coupling - any node whose metadata is
 * missing or unrecognized (a custom combinator, record/union) falls back to JSON.stringify
 * for that node, so output always matches what JSON.stringify would produce for declared
 * shapes.
 */

import { payloadResponse } from './respond.ts';

/** The structural metadata shape this module compiles from (@azerothjs/schema's SchemaMeta). */
export interface EncoderMeta
{
    kind: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'literal' | 'enum' | 'record' | 'union';
    shape?: Record<string, EncodableSchema<unknown>>;
    /** array: the item schema; record: the value schema. */
    item?: EncodableSchema<unknown>;
    optional?: boolean;
    /** Set by .nullable(): null is a valid value and encodes as JSON null. */
    nullable?: boolean;
    /** literal: the expected value - a compile-time constant for the encoder. */
    value?: string | number | boolean;
}

/**
 * The STRUCTURAL shape of a declaration this module accepts - `@azerothjs/schema`'s Schema
 * satisfies it; no runtime or type dependency between the packages.
 */
export interface EncodableSchema<T>
{
    meta?: EncoderMeta;

    /** Present so the value type infers from the declaration; never called here. */
    parse(value: unknown): T;
}

/** @internal A compiled node serializer: value in, JSON text out. */
type Encode = (value: unknown) => string;

/**
 * @internal Characters forcing the JSON.stringify slow path for a string: quote, backslash,
 * control characters, and ANY surrogate half (JSON.stringify escapes lone surrogates; pairs
 * simply take the slow path, trading emoji speed for byte-exact correctness). Everything
 * else serializes as plain quote-wrap - skipping a C++ boundary crossing per field, which
 * is where a compiled encoder actually wins.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what the guard must detect
const NEEDS_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/** @internal JSON.stringify with its undefined-input hole closed (top-level undefined -> 'null'). */
function fallback(value: unknown): string
{
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify's lib type hides that undefined/function/symbol input returns undefined
    return JSON.stringify(value) ?? 'null';
}

/**
 * @internal One field of a compiled object encoder: both key prefixes prebuilt, primitive
 * kinds tagged so the object loop encodes them INLINE (a closure call per primitive field
 * costs more than the field's own serialization).
 */
interface Field
{
    key: string;
    first: string;
    rest: string;
    kind: 'string' | 'number' | 'boolean' | 'complex';
    encode: Encode;
}

/** @internal The primitive kinds the object loop inlines (enum values ARE strings). */
const PRIMITIVE_KINDS = new Set(['string', 'number', 'boolean', 'enum']);

/** @internal Compiles one schema node; unknown/missing metadata compiles to the fallback. */
function compile(schema: EncodableSchema<unknown> | undefined): Encode
{
    const meta = schema?.meta;
    if (meta === undefined)
    {
        return fallback;
    }
    if (meta.nullable === true)
    {
        const inner = compileKind(meta);
        return (value): string => (value === null ? 'null' : inner(value));
    }
    return compileKind(meta);
}

/** @internal The kind switch (nullable handled by the caller). */
function compileKind(meta: EncoderMeta): Encode
{
    switch (meta.kind)
    {
        case 'string':
        case 'enum':
            return (value): string =>
                (typeof value === 'string' && !NEEDS_ESCAPE.test(value) ? '"' + value + '"' : fallback(value));
        case 'literal': {
            // The declaration names ONE valid value - its JSON is a compile-time constant.
            const text = fallback(meta.value);
            return (value): string => (value === meta.value ? text : fallback(value));
        }
        case 'union':
            // The matching variant is only knowable per value; stay byte-exact via stringify.
            return fallback;
        case 'record': {
            const item = compile(meta.item);
            return (value): string =>
            {
                if (value === null || typeof value !== 'object' || Array.isArray(value))
                {
                    return fallback(value);
                }
                let out = '{';
                let empty = true;
                for (const [key, element] of Object.entries(value as Record<string, unknown>))
                {
                    // JSON.stringify omits undefined properties; so do we.
                    if (element === undefined)
                    {
                        continue;
                    }
                    out += (empty ? '' : ',') + JSON.stringify(key) + ':' + item(element);
                    empty = false;
                }
                return out + '}';
            };
        }
        case 'number':
            return (value): string => (typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback(value));
        case 'boolean':
            return (value): string => (value === true ? 'true' : value === false ? 'false' : fallback(value));
        case 'array': {
            const item = compile(meta.item);
            return (value): string =>
            {
                if (!Array.isArray(value))
                {
                    return fallback(value);
                }
                let out = '[';
                for (let i = 0; i < value.length; i++)
                {
                    // JSON.stringify serializes an undefined ELEMENT as null.
                    out += (i === 0 ? '' : ',') + (value[i] === undefined ? 'null' : item(value[i]));
                }
                return out + ']';
            };
        }
        case 'object': {
            const fields: Field[] = Object.entries(meta.shape ?? {}).map(([key, node]) => ({
                key,
                first: JSON.stringify(key) + ':',
                rest: ',' + JSON.stringify(key) + ':',
                kind: (node.meta !== undefined && PRIMITIVE_KINDS.has(node.meta.kind)
                    ? (node.meta.kind === 'enum' ? 'string' : node.meta.kind)
                    : 'complex') as Field['kind'],
                encode: compile(node)
            }));
            return (value): string =>
            {
                if (value === null || typeof value !== 'object')
                {
                    return fallback(value);
                }
                const record = value as Record<string, unknown>;
                let out = '{';
                let empty = true;
                for (const field of fields)
                {
                    const fieldValue = record[field.key];
                    // JSON.stringify omits undefined properties; so do we (covers .optional()).
                    if (fieldValue === undefined)
                    {
                        continue;
                    }
                    // Primitive kinds encode inline - on the small objects that dominate API
                    // traffic, the closure call per field costs more than the field itself.
                    let piece: string;
                    if (field.kind === 'string')
                    {
                        piece = typeof fieldValue === 'string' && !NEEDS_ESCAPE.test(fieldValue)
                            ? '"' + fieldValue + '"'
                            : fallback(fieldValue);
                    }
                    else if (field.kind === 'number')
                    {
                        piece = typeof fieldValue === 'number' && Number.isFinite(fieldValue)
                            ? String(fieldValue)
                            : fallback(fieldValue);
                    }
                    else if (field.kind === 'boolean')
                    {
                        piece = fieldValue === true ? 'true' : fieldValue === false ? 'false' : fallback(fieldValue);
                    }
                    else
                    {
                        piece = field.encode(fieldValue);
                    }
                    out += (empty ? field.first : field.rest) + piece;
                    empty = false;
                }
                return out + '}';
            };
        }
    }
}

/**
 * Compiles a response declaration into a JSON Response constructor. Declare the shape once
 * (the same combinators that validate request bodies), build the encoder at module scope,
 * and return it from handlers - each response serializes through the precompiled shape
 * instead of JSON.stringify's per-call introspection:
 *
 * ```ts
 * import { object, string } from '@azerothjs/schema';
 * import { jsonEncoder } from '@azerothjs/http';
 *
 * const userJson = jsonEncoder(object({ id: string(), name: string() }));
 * app.get('/users/:id', async (context) => userJson(await loadUser(context.params.id)));
 * ```
 *
 * Output is byte-identical to `json(data)` for values matching the declaration; a field the
 * declaration does not cover is simply not emitted (the same boundary discipline object()
 * applies to input), and any node the metadata cannot describe falls back to JSON.stringify.
 */
export function jsonEncoder<T>(schema: EncodableSchema<T>): (data: T, init?: ResponseInit) => Response
{
    const encode = compile(schema);
    return (data: T, init: ResponseInit = {}): Response =>
        payloadResponse(encode(data), 'application/json; charset=utf-8', init);
}
