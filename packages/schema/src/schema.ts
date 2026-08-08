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
 *     is the exact shape `azerothjs`'s setError consumes and the HTTP layer's
 *     ValidationError carries - a server-side failure lands in the browser form untouched.
 *   - EVERY FAILURE ALSO CARRIES A STABLE CODE. Failures are collected as ordered ISSUES
 *     (`{ path, code, message }`); the flat map is derived from them. Codes default to the
 *     rule that failed ('required', 'min', 'format', ...) and every node accepts `codes` /
 *     `messages` override maps, so an application can speak its own error enum without a
 *     second validation layer. Messages are for humans; clients switch on codes.
 *   - `refine` TAKES A FORM VALIDATOR. `azerothjs`'s FieldValidator is
 *     `(value) => string | null`; refine accepts exactly that shape structurally, so
 *     `string().refine(email())` reuses the SAME rule the browser form runs - one source of
 *     validation truth, zero import coupling between the packages.
 *   - COERCION IS EXPLICIT. Query strings and form posts deliver strings; `number({ coerce:
 *     true })` opts into string-to-number conversion where the TRANSPORT is stringly, and
 *     nowhere else - a JSON body that sends "42" for a number is a client bug worth a 422.
 *
 * Parsing collects EVERY error in one pass by default (a form with three bad fields hears
 * about all three), up to a fixed ceiling - past it the result is marked `truncated` rather
 * than letting a bulk body's element-times-field issue count become the response's size and
 * the event loop's stall. `{ mode: 'first' }` stops at the first issue in field-declaration
 * order (the stop-at-first-error style, and a fast path). `parse` throws SchemaError;
 * `safeParse` returns a discriminated result for callers that prefer no exceptions.
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

/** The shape `refine` accepts - an alias of {@link FieldValidator}. */
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

/**
 * The discriminated result of a non-throwing parse. `truncated` is present when the parse
 * reached the issue ceiling, so failures past it were never collected.
 */
export type ParseResult<T> =
    | { ok: true; value: T }
    | { ok: false; errors: FieldErrors; issues: Issue[]; truncated?: boolean };

/**
 * @internal Hard ceiling on the issues one parse collects. A bulk endpoint's array of
 * objects emits one issue PER DECLARED FIELD per element, so an uncapped collector turns a
 * body that passed the transport's size limit into millions of issues, a blocked event loop,
 * and a response far larger than the request. 100 issues is more than any client can act on.
 */
const MAX_ISSUES = 100;

/** @internal How many field paths a {@link SchemaError} message names before it counts the rest. */
const MESSAGE_PATH_LIMIT = 5;

/** @internal Longest path text one message entry repeats. */
const MAX_PATH_TEXT = 64;

/** @internal Everything a path may NOT contribute to a message: keys are attacker-controlled. */
const UNSAFE_PATH_TEXT = /[^\w.$[\]-]/g;

/**
 * @internal One field path as message text. The message's `path: message` grammar is
 * spoofable with a key like `x: injected; y`, so the separators (and anything else exotic)
 * never survive into it - the `fields` map carries the real key.
 */
function safePath(path: string): string
{
    if (path === '')
    {
        return '(value)';
    }
    const text = path.replace(UNSAFE_PATH_TEXT, '?');
    return text.length > MAX_PATH_TEXT ? `${ text.slice(0, MAX_PATH_TEXT) }...` : text;
}

/** A validation failure as an exception, carrying the field-path map and the ordered issues. */
export class SchemaError extends Error
{
    public readonly fields: FieldErrors;

    public readonly issues: Issue[];

    /** True when the parse reached the issue ceiling, so further failures were never collected. */
    public readonly truncated: boolean;

    constructor(fields: FieldErrors, issues?: Issue[], truncated = false)
    {
        const entries = Object.entries(fields);
        const listed = entries.slice(0, MESSAGE_PATH_LIMIT)
            .map(([path, message]) => `${ safePath(path) }: ${ message }`)
            .join('; ');
        const rest = entries.length - Math.min(entries.length, MESSAGE_PATH_LIMIT);
        super(`Validation failed for ${ entries.length }${ truncated ? '+' : '' } field${ entries.length === 1 ? '' : 's' }: `
            + listed + (rest > 0 ? ` (+${ rest } more)` : ''));
        this.name = 'SchemaError';
        this.fields = fields;
        this.issues = issues ?? entries.map(([path, message]) => ({ path, code: 'invalid', message }));
        this.truncated = truncated;
    }
}

/** @internal The collector threaded through one parse pass. */
interface Collector
{
    issues: Issue[];

    /** First-error mode: once one issue exists, nothing further is recorded. */
    first: boolean;

    /** Set when the ceiling stopped collection, so the result can say so. */
    truncated: boolean;
}

/**
 * @internal Structural metadata a combinator attaches to its schema, so a consumer can
 * COMPILE from the declaration - `@azerothjs/http`'s jsonEncoder walks it to build a
 * serializer, and `@azerothjs/http/api`'s OpenAPI exporter walks it to describe the wire
 * type - each built from the same declaration the validator itself was built from.
 * The schema is fully self-describing: `constraints` IS the options object the run
 * closure reads (one reference, one source of truth), never a copy. Nodes without
 * metadata (custom/unknown combinators) simply fall back at the consumer.
 */
export interface SchemaMeta
{
    kind: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'literal' | 'enum' | 'record' | 'union';
    /** object: the declared field schemas, in declaration order. */
    shape?: Record<string, Schema<unknown>>;
    /** array: the item schema; record: the value schema. */
    item?: Schema<unknown>;
    /** Set by .optional(): undefined (and omitted keys) are accepted. */
    optional?: boolean;

    /** Set by .nullable(): null is accepted and passes through. */
    nullable?: boolean;
    /** The combinator's options object - the same reference the validator reads. */
    constraints?: StringOptions | NumberOptions | BooleanOptions | DateOptions | ArrayOptions;
    /** literal: the expected value. */
    value?: string | number | boolean;
    /** enum: the allowed values, in declaration order. */
    values?: readonly string[];
    /** union: the variant schemas, in declaration order. */
    options?: ReadonlyArray<Schema<unknown>>;
    /** Declared identity of each .refine() layer, outermost last (predicates stay opaque). */
    refinements?: ReadonlyArray<{ code?: string | undefined; message?: string | undefined }>;
}

/**
 * The Standard Schema v1 interop surface (https://standardschema.dev) - the `~standard`
 * property Zod, Valibot, ArkType, and Standard-Schema-aware consumers (form resolvers,
 * tRPC, other frameworks) speak. Every schema this package builds carries it, so a
 * house schema plugs into ANY Standard Schema consumer - and the framework's own
 * boundaries (api routes, forms) accept any foreign validator that carries it.
 */
export interface StandardSchemaV1<Output = unknown>
{
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (value: unknown) =>
        StandardResult<Output> | Promise<StandardResult<Output>>;
        readonly types?: { readonly output: Output } | undefined;
    };
}

/** One Standard Schema validation outcome. */
export type StandardResult<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined }> };

/** A schema for T: runtime validation whose static type IS T. */
export interface Schema<T> extends StandardSchemaV1<T>
{
    /** @internal Declaration metadata for compile-from-declaration consumers; see {@link SchemaMeta}. */
    meta?: SchemaMeta;

    /** Validates and returns the (possibly normalized/coerced) value; throws {@link SchemaError}. */
    parse(value: unknown, options?: ParseOptions): T;

    /** Validates without throwing; issues collect in one pass (or stop at the first, per mode). */
    safeParse(value: unknown, options?: ParseOptions): ParseResult<T>;

    /** This schema, but accepting undefined (and omitted object keys). */
    optional(): Schema<T | undefined>;

    /** This schema, but accepting null (which passes through) - JSON's explicit absence. */
    nullable(): Schema<T | null>;

    /**
     * Adds a refinement - the SAME single-argument validator shape azerothjs uses,
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

/**
 * @internal Carries the {@link IS_OPTIONAL} marker from a source schema to a derived one.
 * `.refine()`/`.nullable()` build a fresh schema; without this the marker is lost and
 * `object()` stops skipping an absent optional key - which then runs the field's validator
 * (and any refinement predicate) on `undefined`.
 */
function propagateOptional(source: unknown, derived: object): void
{
    if ((source as { [IS_OPTIONAL]?: boolean })[IS_OPTIONAL] === true)
    {
        (derived as { [IS_OPTIONAL]?: boolean })[IS_OPTIONAL] = true;
    }
}

/** @internal The flat first-message-per-path projection of an issue list. */
function toFieldErrors(issues: Issue[]): FieldErrors
{
    // A null prototype plus defineProperty, not `errors[path] = message`: the paths are
    // ATTACKER-controlled, and on a plain literal `__proto__` hits the prototype setter (the
    // issue vanishes) while `constructor`/`toString` read back an inherited FUNCTION that a
    // first-wins `??` then keeps - a FieldErrors typed Record<string, string> holding a
    // function crashes every consumer that calls a string method on it.
    const errors = Object.create(null) as FieldErrors;
    for (const issue of issues)
    {
        if (!Object.hasOwn(errors, issue.path))
        {
            Object.defineProperty(errors, issue.path, { value: issue.message, enumerable: true, writable: true, configurable: true });
        }
    }
    return errors;
}

/** @internal The failure branch of a parse; `truncated` appears only when the ceiling fired. */
function toFailure<T>(collector: Collector): ParseResult<T>
{
    const errors = toFieldErrors(collector.issues);
    return collector.truncated
        ? { ok: false, errors, issues: collector.issues, truncated: true }
        : { ok: false, errors, issues: collector.issues };
}

/** @internal Shared plumbing: parse/safeParse/optional/refine derive from run(). */
function base<T>(run: (value: unknown, path: string, collector: Collector) => T | undefined, meta?: SchemaMeta): Schema<T>
{
    const schema: Schema<T> = {
        run,
        parse(value: unknown, options: ParseOptions = {}): T
        {
            const collector: Collector = { issues: [], first: options.mode === 'first', truncated: false };
            const parsed = run(value, '', collector);
            if (collector.issues.length > 0)
            {
                throw new SchemaError(toFieldErrors(collector.issues), collector.issues, collector.truncated);
            }
            return parsed as T;
        },
        safeParse(value: unknown, options: ParseOptions = {}): ParseResult<T>
        {
            const collector: Collector = { issues: [], first: options.mode === 'first', truncated: false };
            const parsed = run(value, '', collector);
            if (collector.issues.length > 0)
            {
                return toFailure<T>(collector);
            }
            return { ok: true, value: parsed as T };
        },
        // Standard Schema v1: the interop face any ~standard-aware consumer speaks.
        // Always SYNCHRONOUS here (house validation is one pass, no async refinements);
        // dotted issue paths map to the spec's segment arrays ('' = root = no path).
        '~standard': {
            version: 1,
            vendor: 'azerothjs',
            validate: (value: unknown) =>
            {
                const result = schema.safeParse(value);
                return result.ok
                    ? { value: result.value }
                    : { issues: result.issues.map((issue) => ({ message: issue.message, path: issue.path === '' ? undefined : issue.path.split('.') })) };
            }
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
        nullable(): Schema<T | null>
        {
            // null flows through as a VALUE (unlike optional's undefined, which object()
            // treats as absence) - it is JSON's explicit "no value here".
            const nullableSchema = base<T | null>(
                (value, path, collector) => (value === null ? null : run(value, path, collector)),
                meta === undefined ? undefined : { ...meta, nullable: true }
            );
            // A `.optional().nullable()` chain must stay skippable as an absent object key:
            // carry the optional marker forward so object() still elides it.
            propagateOptional(schema, nullableSchema);
            return nullableSchema;
        },
        refine(check: Refinement<T>, options: RefineOptions = {}): Schema<T>
        {
            // A refinement narrows VALIDATION, not the value's shape - metadata carries
            // over, with the refinement's declared identity appended so a describing
            // consumer knows a further check exists (the predicate itself stays opaque).
            const refinedMeta = meta === undefined ? undefined : {
                ...meta,
                refinements: [...meta.refinements ?? [], { code: options.code, message: options.message }]
            };
            const refinedSchema = base<T>((value, path, collector) =>
            {
                const before = collector.issues.length;
                const parsed = run(value, path, collector);
                if (collector.issues.length > before)
                {
                    return undefined; // structurally invalid; the refinement never sees it
                }
                // An optional-absent (or nullable-null flowing to undefined) value has nothing
                // to refine - running `check(undefined)` would throw inside a predicate written
                // for the present value (`v.length`), turning an OMITTED optional field into a
                // crash on valid input. Skip it; the refinement checks presence, not absence.
                if (parsed === undefined)
                {
                    return undefined;
                }
                const message = check(parsed);
                if (message !== null)
                {
                    return fail(collector, path, options.code ?? 'refine', options.message ?? message);
                }
                return parsed;
            }, refinedMeta);
            // `.optional().refine()` must remain a skippable absent key (object() keys off the
            // marker, not meta) - without this, refine on an optional field is a landmine.
            propagateOptional(schema, refinedSchema);
            return refinedSchema;
        }
    };
    if (meta !== undefined)
    {
        schema.meta = meta;
    }
    return schema;
}

/**
 * @internal True once the collector takes nothing further: first-error mode has its issue, or
 * the ceiling is reached - and then the result is marked truncated, because input that would
 * have failed is no longer being described.
 */
function stopCollecting(collector: Collector): boolean
{
    if (collector.first)
    {
        return collector.issues.length > 0;
    }
    if (collector.issues.length < MAX_ISSUES)
    {
        return false;
    }
    collector.truncated = true;
    return true;
}

/**
 * @internal Records one issue (respecting first-error mode and the ceiling); returns undefined
 * for the run. Every combinator funnels through here, so ONE guard bounds them all.
 */
function fail(collector: Collector, path: string, code: string, message: string): undefined
{
    if (stopCollecting(collector))
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

/**
 * Constraints for {@link string}: length bounds, pattern, format, and the normalizations
 * (`trim`/`lowercase`) that run BEFORE validation - what parses out is the normalized value.
 */
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

    /** A named format; email matches azerothjs's email() rule exactly. */
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
    }, { kind: 'string', constraints: options });
}

/**
 * Constraints for {@link number}: bounds, integer-ness, and `coerce` - the query-string seam,
 * turning the string a URL carries into the number the schema declares before validating it.
 */
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
    }, { kind: 'number', constraints: options });
}

/**
 * Constraints for {@link boolean}: `coerce` accepts the forms a query string or form post
 * actually sends ('true'/'false'/'1'/'0') instead of treating every non-empty string as true.
 */
export interface BooleanOptions extends RuleOverrides
{
    /** Accept 'true'/'false'/'1'/'0' strings (query/form transports ONLY - never default). */
    coerce?: boolean;
}

/** A boolean; `coerce` accepts 'true'/'false'/'1'/'0' strings (query/form transports). */
export function boolean(options: BooleanOptions = {}): Schema<boolean>
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
    }, { kind: 'boolean', constraints: options });
}

/**
 * Constraints for {@link date}: instant bounds. min/max compare epoch milliseconds, so a
 * bound written as one instant and a value sent in another offset still compare correctly.
 */
export interface DateOptions extends RuleOverrides
{
    /** Earliest accepted instant (inclusive). */
    min?: Date;

    /** Latest accepted instant (inclusive). */
    max?: Date;
}

/**
 * A Date - THE Date wire codec of the framework. JSON cannot carry a Date, so the wire shape
 * is the ISO 8601 string `JSON.stringify` already produces; parsing turns it back into a
 * Date instance, and a Date instance (the in-process case) passes through. The string gate
 * is the same `datetime` format rule `string({ format: 'datetime' })` runs - Date.parse
 * alone is too lenient to trust ('Jan 1 2026' is not a wire shape).
 */
export function date(options: DateOptions = {}): Schema<Date>
{
    return base((value, path, collector) =>
    {
        if (isMissing(value))
        {
            return reject(collector, path, options, 'required', 'Required');
        }
        let out: Date;
        if (value instanceof Date)
        {
            if (Number.isNaN(value.getTime()))
            {
                return reject(collector, path, options, 'type', 'Expected a valid date');
            }
            out = value;
        }
        else if (typeof value === 'string')
        {
            if (!DATETIME_PATTERN.test(value) || Number.isNaN(Date.parse(value)))
            {
                return reject(collector, path, options, 'format', FORMAT_MESSAGES['datetime'] ?? 'Invalid format');
            }
            out = new Date(value);
        }
        else
        {
            return reject(collector, path, options, 'type', 'Expected a date');
        }
        if (options.min !== undefined && out.getTime() < options.min.getTime())
        {
            return reject(collector, path, options, 'min', `Must not be before ${ options.min.toISOString() }`);
        }
        if (options.max !== undefined && out.getTime() > options.max.getTime())
        {
            return reject(collector, path, options, 'max', `Must not be after ${ options.max.toISOString() }`);
        }
        return out;
    }, { kind: 'date', constraints: options });
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
    }, { kind: 'literal', value: expected });
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
    }, { kind: 'enum', values: values });
}

/**
 * Constraints for {@link array}: element-count bounds. Element validation belongs to the item
 * schema; these only bound how many of them a caller may send.
 */
export interface ArrayOptions extends RuleOverrides
{
    /** Minimum length. */
    min?: number;

    /** Maximum length. */
    max?: number;
}

/** An array of `item`; `min`/`max` bound the length. Every element error is collected. */
export function array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]>
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
            // An exhausted collector cannot describe the rest of the array, and the parse has
            // already failed - walking the remaining elements only burns the event loop.
            if (stopCollecting(collector))
            {
                break;
            }
        }
        return collector.issues.length > before ? undefined : out as T[];
    }, { kind: 'array', item: item, constraints: options });
}

/** @internal Keys whose schema admits undefined - `.optional()` fields, whose absence parses. */
type OptionalShapeKeys<Shape extends Record<string, Schema<unknown>>> =
    { [K in keyof Shape]: undefined extends Infer<Shape[K]> ? K : never }[keyof Shape];

/**
 * The object type of a shape of schemas. A `.optional()` field becomes an optional KEY, matching
 * what the runtime enforces (absence parses), so a caller constructing a value - a typed client's
 * `query: {}`, a handler's return - may omit it rather than writing `field: undefined`. The value
 * type keeps `| undefined` so an explicit undefined stays assignable under
 * exactOptionalPropertyTypes.
 */
export type ShapeType<Shape extends Record<string, Schema<unknown>>> = Reify<
    { [K in Exclude<keyof Shape, OptionalShapeKeys<Shape>>]: Infer<Shape[K]> }
    & { [K in OptionalShapeKeys<Shape>]?: Infer<Shape[K]> }
>;

/** @internal Flattens the required/optional intersection into one object type (`?` preserved). */
type Reify<T> = { [K in keyof T]: T[K] };

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
            // An OWN-property read, never `record[key]`: a plain member read walks the
            // prototype chain, so a `role`/`isAdmin` polluted onto Object.prototype anywhere
            // in the process would be validated and delivered as if the client had sent it -
            // mass assignment fabricated by the layer that exists to prevent it.
            const fieldValue = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
            if (fieldValue === undefined && (fieldSchema as { [IS_OPTIONAL]?: boolean })[IS_OPTIONAL] === true)
            {
                continue;
            }
            const parsed = fieldSchema.run(fieldValue, fieldPath, collector);
            if (parsed !== undefined)
            {
                out[key] = parsed;
            }
            if (stopCollecting(collector))
            {
                break;
            }
        }
        return collector.issues.length > before ? undefined : out as ShapeType<Shape>;
    }, { kind: 'object', shape: shape });
}

/** A dictionary of arbitrary string keys to `value`-schema values; `__proto__` is stripped. */
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
            // `__proto__` is dropped like an unknown key in object(): JSON.parse creates it as
            // an OWN property, so preserving it would hand the handler a pollution primitive -
            // `Object.assign(target, validatedBody)` then gives the target an attacker-chosen
            // prototype, with nothing to signal that validated input is unsafe to merge.
            if (key === '__proto__')
            {
                continue;
            }
            const parsed = value.run(element, path === '' ? key : `${ path }.${ key }`, collector);
            if (parsed !== undefined)
            {
                // defineProperty, not `out[key] = parsed`: the keys are ATTACKER-controlled, and a
                // plain assignment to `__proto__` invokes the prototype setter (poisoning the parsed
                // object with attacker-supplied inherited properties) instead of adding an own key.
                Object.defineProperty(out, key, { value: parsed, enumerable: true, writable: true, configurable: true });
            }
            if (stopCollecting(collector))
            {
                break;
            }
        }
        return collector.issues.length > before ? undefined : out;
    }, { kind: 'record', item: value });
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
            const probe: Collector = { issues: [], first: true, truncated: false };
            const parsed = option.run(value, path, probe);
            if (probe.issues.length === 0)
            {
                return parsed as Infer<Schemas[number]>;
            }
        }
        return reject(collector, path, overrides, 'union', 'No union variant matched');
    }, { kind: 'union', options: options });
}
