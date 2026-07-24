/**
 * MODULE: schema - validators that infer their TypeScript types
 *
 * The anti-"schemas divorced from types": one declaration drives runtime validation AND the
 * compile-time type. `object({ email: string() })` validates unknown input and `Infer<...>`
 * of it IS `{ email: string }` - no interface written twice, no JSON Schema in a JS costume,
 * no codegen.
 *
 * Four deliberate shapes:
 *
 *   - ERRORS ARE A FLAT FIELD-PATH MAP: `{ 'items.0.email': 'Enter a valid email' }`. This
 *     is the exact shape `@azerothjs/form`'s setError consumes and the HTTP layer's
 *     ValidationError carries - a server-side failure lands in the browser form untouched.
 *   - EVERY FAILURE ALSO CARRIES A STABLE CODE. Failures are collected as ordered ISSUES
 *     (`{ path, code, message }`); the flat map is derived from them. Codes default to the
 *     rule that failed ('required', 'min', 'format', ...) and every node accepts `codes` /
 *     `messages` override maps, so an application can speak its own error enum without a
 *     second validation layer. Messages are for humans; clients switch on codes.
 *   - `refine` TAKES A FORM VALIDATOR. `@azerothjs/form`'s FieldValidator is
 *     `(value) => string | null`; refine accepts exactly that shape structurally, so
 *     `string().refine(email())` reuses the SAME rule the browser form runs - one source of
 *     validation truth, zero import coupling between the packages.
 *   - COERCION IS EXPLICIT. Query strings and form posts deliver strings; `number({ coerce:
 *     true })` opts into string-to-number conversion where the TRANSPORT is stringly, and
 *     nowhere else - a JSON body that sends "42" for a number is a client bug worth a 422.
 *
 * Parsing collects EVERY error in one pass by default (a form with three bad fields hears
 * about all three); `{ mode: 'first' }` stops at the first issue in field-declaration order
 * (the stop-at-first-error style, and a fast path). `parse` throws SchemaError; `safeParse`
 * returns a discriminated result for callers that prefer no exceptions.
 *
 * String checks run in a documented, stable order: required -> type -> normalization
 * (trim/lowercase, whose result is what parses OUT) -> nonempty -> min -> max -> pattern ->
 * format, then refinements.
 */

/**
 * A sync field validator: `(value) => error message | null`. THE atomic validation shape of
 * the whole framework - the browser form's per-field rules, the factories in validators.ts,
 * and this package's `refine` all speak it. Single-argument by design: a validator sees only
 * its own value, so it stays trivial to write, wrap, and compose.
 */
export type FieldValidator<V = unknown> = (value: V) => string | null;

/** The shape `refine` accepts - a {@link FieldValidator}, by its historical name. */
export type Refinement<T> = FieldValidator<T>;

/** The flat field-path error map - the wire/form-compatible failure shape. */
export type FieldErrors = Record<string, string>;

/** One validation failure: the dot path, a stable machine code, and the human message. */
export interface Issue
{
    path: string;
    code: string;
    message: string;
}

/** Parse behavior: collect every issue (default) or stop at the first. */
export interface ParseOptions
{
    mode?: 'all' | 'first';
}

/**
 * Per-node overrides mapping a RULE name ('required', 'type', 'min', 'max', 'pattern',
 * 'format', 'nonempty', ...) to the application's own stable code and/or message. Codes are
 * opaque strings - the library never interprets them.
 */
export interface RuleOverrides
{
    codes?: Record<string, string>;
    messages?: Record<string, string>;
}

/** Options for {@link Schema.refine}: the issue's code (default 'refine') and message override. */
export interface RefineOptions
{
    code?: string;
    message?: string;
}

/** The discriminated result of a non-throwing parse. */
export type ParseResult<T> =
    | { ok: true; value: T }
    | { ok: false; errors: FieldErrors; issues: Issue[] };

/** A validation failure as an exception, carrying the field-path map and the ordered issues. */
export class SchemaError extends Error
{
    public readonly fields: FieldErrors;

    public readonly issues: Issue[];

    constructor(fields: FieldErrors, issues?: Issue[])
    {
        const entries = Object.entries(fields);
        super(`Validation failed for ${ entries.length } field${ entries.length === 1 ? '' : 's' }: `
            + entries.map(([path, message]) => `${ path || '(value)' }: ${ message }`).join('; '));
        this.name = 'SchemaError';
        this.fields = fields;
        this.issues = issues ?? entries.map(([path, message]) => ({ path, code: 'invalid', message }));
    }
}

/** @internal The collector threaded through one parse pass. */
interface Collector
{
    issues: Issue[];

    /** First-error mode: once one issue exists, nothing further is recorded. */
    first: boolean;
}

/**
 * @internal Structural metadata a combinator attaches to its schema, so a consumer can
 * COMPILE from the declaration - `@azerothjs/http`'s jsonEncoder walks it to build a
 * serializer the way the validator itself was built from the same declaration. Nodes
 * without metadata (custom/unknown combinators) simply fall back at the consumer.
 */
export interface SchemaMeta
{
    kind: 'string' | 'number' | 'boolean' | 'array' | 'object';
    /** object: the declared field schemas, in declaration order. */
    shape?: Record<string, Schema<unknown>>;
    /** array: the item schema. */
    item?: Schema<unknown>;
    /** Set by .optional(): undefined (and omitted keys) are accepted. */
    optional?: boolean;
}

/** A schema for T: runtime validation whose static type IS T. */
export interface Schema<T>
{
    /** @internal Declaration metadata for compile-from-declaration consumers; see {@link SchemaMeta}. */
    meta?: SchemaMeta;

    /** Validates and returns the (possibly normalized/coerced) value; throws {@link SchemaError}. */
    parse(value: unknown, options?: ParseOptions): T;

    /** Validates without throwing; issues collect in one pass (or stop at the first, per mode). */
    safeParse(value: unknown, options?: ParseOptions): ParseResult<T>;

    /** This schema, but accepting undefined (and omitted object keys). */
    optional(): Schema<T | undefined>;

    /**
     * Adds a refinement - the SAME single-argument validator shape @azerothjs/form uses,
     * so browser-form rules run verbatim at the server boundary. Refinements run after the
     * structural check, in order, first failure wins for the field. `options` sets the
     * issue's stable code (default 'refine') and overrides the message.
     */
    refine(check: Refinement<T>, options?: RefineOptions): Schema<T>;

    /** @internal One-pass core: validate into the collector at `path`; undefined on failure. */
    run(value: unknown, path: string, collector: Collector): T | undefined;
}

/** The TypeScript type a schema validates - the whole point. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** @internal Marks optional schemas so object() can distinguish absent keys. */
const IS_OPTIONAL = Symbol('optional');

/** @internal The flat first-message-per-path projection of an issue list. */
function toFieldErrors(issues: Issue[]): FieldErrors
{
    const errors: FieldErrors = {};
    for (const issue of issues)
    {
        errors[issue.path] = errors[issue.path] ?? issue.message;
    }
    return errors;
}

/** @internal Shared plumbing: parse/safeParse/optional/refine derive from run(). */
function base<T>(run: (value: unknown, path: string, collector: Collector) => T | undefined, meta?: SchemaMeta): Schema<T>
{
    const schema: Schema<T> = {
        run,
        parse(value: unknown, options: ParseOptions = {}): T
        {
            const collector: Collector = { issues: [], first: options.mode === 'first' };
            const parsed = run(value, '', collector);
            if (collector.issues.length > 0)
            {
                throw new SchemaError(toFieldErrors(collector.issues), collector.issues);
            }
            return parsed as T;
        },
        safeParse(value: unknown, options: ParseOptions = {}): ParseResult<T>
        {
            const collector: Collector = { issues: [], first: options.mode === 'first' };
            const parsed = run(value, '', collector);
            if (collector.issues.length > 0)
            {
                return { ok: false, errors: toFieldErrors(collector.issues), issues: collector.issues };
            }
            return { ok: true, value: parsed as T };
        },
        optional(): Schema<T | undefined>
        {
            const optionalSchema = base<T | undefined>(
                (value, path, collector) => (value === undefined ? undefined : run(value, path, collector)),
                meta === undefined ? undefined : { ...meta, optional: true }
            );
            (optionalSchema as { [IS_OPTIONAL]?: boolean })[IS_OPTIONAL] = true;
            return optionalSchema;
        },
        refine(check: Refinement<T>, options: RefineOptions = {}): Schema<T>
        {
            // A refinement narrows VALIDATION, not the value's shape - metadata carries over.
            return base<T>((value, path, collector) =>
            {
                const before = collector.issues.length;
                const parsed = run(value, path, collector);
                if (collector.issues.length > before)
                {
                    return undefined; // structurally invalid; the refinement never sees it
                }
                const message = check(parsed as T);
                if (message !== null)
                {
                    return fail(collector, path, options.code ?? 'refine', options.message ?? message);
                }
                return parsed;
            }, meta);
        }
    };
    if (meta !== undefined)
    {
        schema.meta = meta;
    }
    return schema;
}

/** @internal Records one issue (respecting first-error mode); returns undefined for the run. */
function fail(collector: Collector, path: string, code: string, message: string): undefined
{
    if (collector.first && collector.issues.length > 0)
    {
        return undefined;
    }
    collector.issues.push({ path, code, message });
    return undefined;
}

/** @internal Resolves a rule through a node's override maps, then records the issue. */
function reject(collector: Collector, path: string, overrides: RuleOverrides | undefined, rule: string, message: string): undefined
{
    return fail(collector, path, overrides?.codes?.[rule] ?? rule, overrides?.messages?.[rule] ?? message);
}

/** @internal Absent input: undefined and null both fail the 'required' rule of the node. */
function isMissing(value: unknown): boolean
{
    return value === undefined || value === null;
}

/**
 * @internal THE email rule of the framework - `string({ format: 'email' })` and the `email()`
 * validator factory both use it: pragmatic (local@domain.tld, no whitespace), deliberately
 * not RFC 5322 exhaustive.
 */
export const EMAIL_PATTERN: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @internal ISO 8601 date-time shape; Date.parse alone is too lenient to trust. */
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** @internal The format rules: name -> (value) => valid. */
const FORMATS: Record<string, (value: string) => boolean> =
{
    email: (value) => EMAIL_PATTERN.test(value),
    uuid: (value) => UUID_PATTERN.test(value),
    datetime: (value) => DATETIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value)),
    url: (value) =>
    {
        try
        {
            new URL(value);
            return true;
        }
        catch
        {
            return false;
        }
    }
};

const FORMAT_MESSAGES: Record<string, string> =
{
    email: 'Must be a valid email address',
    uuid: 'Must be a valid UUID',
    datetime: 'Must be a valid ISO 8601 date-time',
    url: 'Must be a valid URL'
};

export interface StringOptions extends RuleOverrides
{
    /** Strip surrounding whitespace BEFORE any check; the trimmed value is what parses out. */
    trim?: boolean;

    /** Lowercase (after trim) BEFORE any check; the lowercased value is what parses out. */
    lowercase?: boolean;

    /** Reject the empty string (after normalization) - the IsNotEmpty semantics. */
    nonempty?: boolean;

    /** Minimum length. */
    min?: number;

    /** Maximum length. */
    max?: number;

    /** A pattern the (normalized) value must match. */
    pattern?: RegExp;

    /** A named format; email matches @azerothjs/form's email() rule exactly. */
    format?: 'email' | 'url' | 'uuid' | 'datetime';
}

/**
 * A string. Normalization (`trim`, `lowercase`) runs first and its result is the parsed
 * value; checks then run in the stable order nonempty -> min -> max -> pattern -> format.
 */
export function string(options: StringOptions = {}): Schema<string>
{
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, options, 'required', 'Required');
        }
        if (typeof value !== 'string')
        {
            return reject(collector, path, options, 'type', 'Expected a string');
        }
        let out = value;
        if (options.trim === true)
        {
            out = out.trim();
        }
        if (options.lowercase === true)
        {
            out = out.toLowerCase();
        }
        if (options.nonempty === true && out === '')
        {
            return reject(collector, path, options, 'nonempty', 'Must not be empty');
        }
        if (options.min !== undefined && out.length < options.min)
        {
            return reject(collector, path, options, 'min', `Must be at least ${ options.min } characters`);
        }
        if (options.max !== undefined && out.length > options.max)
        {
            return reject(collector, path, options, 'max', `Must be at most ${ options.max } characters`);
        }
        if (options.pattern !== undefined && !options.pattern.test(out))
        {
            return reject(collector, path, options, 'pattern', 'Invalid format');
        }
        if (options.format !== undefined)
        {
            const formatRule = FORMATS[options.format];
            if (formatRule !== undefined && !formatRule(out))
            {
                return reject(collector, path, options, 'format',
                    FORMAT_MESSAGES[options.format] ?? 'Invalid format');
            }
        }
        return out;
    }, { kind: 'string' });
}

export interface NumberOptions extends RuleOverrides
{
    /** Minimum value. */
    min?: number;

    /** Maximum value. */
    max?: number;

    /** Demand an integer. */
    int?: boolean;

    /** Convert numeric strings (for query/form transports ONLY - never default). */
    coerce?: boolean;
}

/** A finite number; NaN and Infinity are rejected as type failures. */
export function number(options: NumberOptions = {}): Schema<number>
{
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, options, 'required', 'Required');
        }
        let candidate = value;
        if (options.coerce === true && typeof candidate === 'string' && candidate.trim() !== '')
        {
            candidate = Number(candidate);
        }
        if (typeof candidate !== 'number' || !Number.isFinite(candidate))
        {
            return reject(collector, path, options, 'type', 'Expected a number');
        }
        if (options.int === true && !Number.isInteger(candidate))
        {
            return reject(collector, path, options, 'int', 'Expected an integer');
        }
        if (options.min !== undefined && candidate < options.min)
        {
            return reject(collector, path, options, 'min', `Must be at least ${ options.min }`);
        }
        if (options.max !== undefined && candidate > options.max)
        {
            return reject(collector, path, options, 'max', `Must be at most ${ options.max }`);
        }
        return candidate;
    }, { kind: 'number' });
}

/** A boolean; `coerce` accepts 'true'/'false'/'1'/'0' strings (query/form transports). */
export function boolean(options: { coerce?: boolean } & RuleOverrides = {}): Schema<boolean>
{
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, options, 'required', 'Required');
        }
        if (options.coerce === true && typeof value === 'string')
        {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1')
            {
                return true;
            }
            if (normalized === 'false' || normalized === '0')
            {
                return false;
            }
        }
        if (typeof value !== 'boolean')
        {
            return reject(collector, path, options, 'type', 'Expected a boolean');
        }
        return value;
    }, { kind: 'boolean' });
}

/** Exactly `expected` (a literal type). */
export function literal<const V extends string | number | boolean>(expected: V, overrides?: RuleOverrides): Schema<V>
{
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, overrides, 'required', 'Required');
        }
        return value === expected
            ? expected
            : reject(collector, path, overrides, 'literal', `Expected ${ JSON.stringify(expected) }`);
    }, { kind: (typeof expected) as 'string' | 'number' | 'boolean' });
}

/** One of `values`; the schema's type is their union. */
export function enumOf<const V extends readonly string[]>(values: V, overrides?: RuleOverrides): Schema<V[number]>
{
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, overrides, 'required', 'Required');
        }
        return typeof value === 'string' && values.includes(value)
            ? value
            : reject(collector, path, overrides, 'enum', `Expected one of: ${ values.join(', ') }`);
    }, { kind: 'string' });
}

/** An array of `item`; `min`/`max` bound the length. Every element error is collected. */
export function array<T>(item: Schema<T>, options: { min?: number; max?: number } & RuleOverrides = {}): Schema<T[]>
{
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, options, 'required', 'Required');
        }
        if (!Array.isArray(value))
        {
            return reject(collector, path, options, 'type', 'Expected an array');
        }
        if (options.min !== undefined && value.length < options.min)
        {
            return reject(collector, path, options, 'min', `Must have at least ${ options.min } item${ options.min === 1 ? '' : 's' }`);
        }
        if (options.max !== undefined && value.length > options.max)
        {
            return reject(collector, path, options, 'max', `Must have at most ${ options.max } item${ options.max === 1 ? '' : 's' }`);
        }
        const before = collector.issues.length;
        const out: (T | undefined)[] = [];
        for (let index = 0; index < value.length; index++)
        {
            out.push(item.run(value[index], path === '' ? String(index) : `${ path }.${ index }`, collector));
            if (collector.first && collector.issues.length > 0)
            {
                break;
            }
        }
        return collector.issues.length > before ? undefined : out as T[];
    }, { kind: 'array', item: item });
}

/** The object type of a shape of schemas. */
export type ShapeType<Shape extends Record<string, Schema<unknown>>> =
    { [K in keyof Shape]: Infer<Shape[K]> };

/**
 * An object with a fixed shape. Unknown keys are STRIPPED (never delivered to handlers - a
 * mass-assignment payload dies here); a missing required key fails THROUGH the field's own
 * schema (so its `codes` override governs the 'required' issue), and every per-field failure
 * is reported under its dot path, in field-declaration order.
 */
export function object<Shape extends Record<string, Schema<unknown>>>(shape: Shape, overrides?: RuleOverrides): Schema<ShapeType<Shape>>
{
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, overrides, 'required', 'Required');
        }
        if (typeof value !== 'object' || Array.isArray(value))
        {
            return reject(collector, path, overrides, 'type', 'Expected an object');
        }
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        const before = collector.issues.length;
        for (const [key, fieldSchema] of Object.entries(shape))
        {
            const fieldPath = path === '' ? key : `${ path }.${ key }`;
            const fieldValue = record[key];
            if (fieldValue === undefined && (fieldSchema as { [IS_OPTIONAL]?: boolean })[IS_OPTIONAL] === true)
            {
                continue;
            }
            const parsed = fieldSchema.run(fieldValue, fieldPath, collector);
            if (parsed !== undefined)
            {
                out[key] = parsed;
            }
            if (collector.first && collector.issues.length > 0)
            {
                break;
            }
        }
        return collector.issues.length > before ? undefined : out as ShapeType<Shape>;
    }, { kind: 'object', shape: shape });
}

/** A dictionary of arbitrary string keys to `value`-schema values. */
export function record<T>(value: Schema<T>, overrides?: RuleOverrides): Schema<Record<string, T>>
{
    return base((input, path, collector) =>
    {
        if (isMissing(input))
        {
            return reject(collector, path, overrides, 'required', 'Required');
        }
        if (typeof input !== 'object' || Array.isArray(input))
        {
            return reject(collector, path, overrides, 'type', 'Expected an object');
        }
        const out: Record<string, T> = {};
        const before = collector.issues.length;
        for (const [key, element] of Object.entries(input as Record<string, unknown>))
        {
            const parsed = value.run(element, path === '' ? key : `${ path }.${ key }`, collector);
            if (parsed !== undefined)
            {
                out[key] = parsed;
            }
            if (collector.first && collector.issues.length > 0)
            {
                break;
            }
        }
        return collector.issues.length > before ? undefined : out;
    });
}

/** Any of `options`, tried in order; the first structural match wins. */
export function union<Schemas extends ReadonlyArray<Schema<unknown>>>(
    options: Schemas,
    overrides?: RuleOverrides
): Schema<Infer<Schemas[number]>>
{
    // A JS caller writing the variadic form union(a, b) passes schema `b` where the
    // overrides belong and crashes much later with a bare "options is not iterable".
    // Types prevent this in TS; the guard gives the untyped caller a real answer now.
    // The `as unknown` keeps Array.isArray's `any[]` predicate from narrowing the
    // generic - without it, every later `option` in this function degrades to `any`.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the assertion blocks Array.isArray's `any[]` predicate from narrowing the generic; removing it degrades every later `option` to `any`
    if (!Array.isArray(options as unknown))
    {
        throw new TypeError(`union() expects an ARRAY of schemas - union([a, b]) - received ${ typeof options }. Wrap the options in one array; the second argument is rule overrides, not another schema.`);
    }
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, overrides, 'required', 'Required');
        }
        for (const option of options)
        {
            // Probes short-circuit: only "did it match" matters, never the probe's issues.
            const probe: Collector = { issues: [], first: true };
            const parsed = option.run(value, path, probe);
            if (probe.issues.length === 0)
            {
                return parsed as Infer<Schemas[number]>;
            }
        }
        return reject(collector, path, overrides, 'union', 'No union variant matched');
    });
}
