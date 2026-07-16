/**
 * MODULE: http/config - typed configuration, loud at boot
 *
 * The anti-`app.set('trust proxy', ...)`: configuration is a TYPED OBJECT built once at
 * startup from declared variables, not a string-keyed bag consulted at runtime. Three rules:
 *
 *   - EVERY failure at once. A missing DATABASE_URL and a malformed PORT report together in
 *     one thrown error at boot - not one per restart, which is how a bad deploy burns twenty
 *     minutes discovering variables one at a time.
 *   - TYPES from declarations. `num('PORT')` yields a number, `flag('DEBUG')` a boolean,
 *     `oneOf('MODE', [...])` a union - the config object's type is inferred from its shape,
 *     no interface written twice.
 *   - SECRETS marked at declaration. A `{ secret: true }` variable redacts itself from the
 *     config's own string/JSON representations, so `console.log(config)` in a debugging
 *     panic cannot leak credentials into logs.
 *
 * Reads default to `process.env` when it exists but take any record, so tests inject
 * environments without touching globals and non-Node runtimes pass their own.
 */

/** One declared configuration variable: how to read and parse it. */
export interface ConfigVar<T>
{
    /** The environment variable name, e.g. 'DATABASE_URL'. */
    name: string;

    /** Parses the raw string; throws (or returns an Error message via throw) on bad input. */
    parse: (raw: string) => T;

    /** Used when the variable is absent. Absent + no default = a boot error. */
    defaultValue?: T | undefined;

    /** Redact from the config object's own serializations. */
    secret?: boolean | undefined;
}

/** A string variable. */
export function str(name: string, options: { default?: string; secret?: boolean } = {}): ConfigVar<string>
{
    return { name, parse: (raw) => raw, defaultValue: options.default, secret: options.secret };
}

/** A number variable; rejects anything Number() cannot fully parse. */
export function num(name: string, options: { default?: number; secret?: boolean } = {}): ConfigVar<number>
{
    return {
        name,
        parse: (raw) =>
        {
            const value = Number(raw);
            if (raw.trim() === '' || !Number.isFinite(value))
            {
                throw new Error(`expected a number, got "${ raw }"`);
            }
            return value;
        },
        defaultValue: options.default,
        secret: options.secret
    };
}

/** A boolean flag: true/false/1/0/yes/no (case-insensitive) - anything else is a boot error. */
export function flag(name: string, options: { default?: boolean } = {}): ConfigVar<boolean>
{
    return {
        name,
        parse: (raw) =>
        {
            const normalized = raw.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1' || normalized === 'yes')
            {
                return true;
            }
            if (normalized === 'false' || normalized === '0' || normalized === 'no')
            {
                return false;
            }
            throw new Error(`expected true/false/1/0/yes/no, got "${ raw }"`);
        },
        defaultValue: options.default
    };
}

/** An enumerated variable: the value must be one of `values`, and the TYPE is their union. */
export function oneOf<const V extends readonly string[]>(
    name: string,
    values: V,
    options: { default?: V[number] } = {}
): ConfigVar<V[number]>
{
    return {
        name,
        parse: (raw) =>
        {
            if (!values.includes(raw))
            {
                throw new Error(`expected one of ${ values.join(' | ') }, got "${ raw }"`);
            }
            return raw;
        },
        defaultValue: options.default
    };
}

/** The inferred config type of a shape of ConfigVars. */
export type ConfigOf<Shape extends Record<string, ConfigVar<unknown>>> =
    { readonly [K in keyof Shape]: Shape[K] extends ConfigVar<infer T> ? T : never };

/**
 * Builds the typed config from a shape, reading `env` (default: the process environment).
 * Throws ONE error naming every missing and every malformed variable. Secret values are
 * present on the object but redacted from its own JSON/string forms.
 */
export function loadConfig<Shape extends Record<string, ConfigVar<unknown>>>(
    shape: Shape,
    env: Record<string, string | undefined> =
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
): ConfigOf<Shape>
{
    const problems: string[] = [];
    const values: Record<string, unknown> = {};
    const secrets = new Set<string>();

    for (const [key, variable] of Object.entries(shape))
    {
        const raw = env[variable.name];
        if (raw === undefined || raw === '')
        {
            if (variable.defaultValue !== undefined)
            {
                values[key] = variable.defaultValue;
            }
            else
            {
                problems.push(`${ variable.name } is required and missing`);
            }
        }
        else
        {
            try
            {
                values[key] = variable.parse(raw);
            }
            catch (error)
            {
                problems.push(`${ variable.name }: ${ error instanceof Error ? error.message : String(error) }`);
            }
        }
        if (variable.secret === true)
        {
            secrets.add(key);
        }
    }

    if (problems.length > 0)
    {
        throw new Error(`Configuration is invalid (${ problems.length } problem${ problems.length === 1 ? '' : 's' }):\n`
            + problems.map((line) => `  - ${ line }`).join('\n'));
    }

    // Redaction: the VALUES stay readable (code needs them); only the object's own
    // serializations hide them - the log-the-whole-config accident is the threat model.
    if (secrets.size > 0)
    {
        Object.defineProperty(values, 'toJSON', {
            value(): Record<string, unknown>
            {
                const safe: Record<string, unknown> = { ...values };
                for (const key of secrets)
                {
                    safe[key] = '[redacted]';
                }
                delete (safe as { toJSON?: unknown }).toJSON;
                return safe;
            }
        });
    }
    return values as ConfigOf<Shape>;
}
