/**
 * MODULE: cron/expression - the 5-field cron parser and the next-occurrence engine
 *
 * `parseExpression` turns `minute hour day-of-month month day-of-week` (ranges, steps, lists,
 * month/day names, and the @daily-style aliases) into sets of allowed values, VALIDATING at
 * parse time - a malformed expression throws with the exact field and token, so a bad job
 * fails the boot instead of silently never running.
 *
 * `nextOccurrence` finds the next wall-clock match in a given IANA timezone (via Intl - zero
 * dependencies). It scans the epoch FORWARD, minute-aligned, reading each candidate's LOCAL
 * parts and jumping by day/hour when a level cannot match. Because it walks real epoch time
 * and tests real local time, DST falls out by construction: a local time that does not exist
 * (spring forward) is never produced, and a repeated local time (fall back) is deduplicated
 * by the caller passing the last-fired local key. Day-of-month vs day-of-week follow the
 * ecosystem rule: when BOTH are restricted, a date matching EITHER runs.
 */

/** The parsed form of one cron expression: the allowed values per field. */
export interface CronFields
{
    minutes: Set<number>;

    hours: Set<number>;

    daysOfMonth: Set<number>;

    months: Set<number>;

    /** 0-6, Sunday = 0 (an input 7 normalizes to 0). */
    daysOfWeek: Set<number>;

    /** Whether the day-of-month field was anything other than `*` (the OR-rule input). */
    domRestricted: boolean;

    /** Whether the day-of-week field was anything other than `*`. */
    dowRestricted: boolean;

    /** The original expression, for error messages and the job table. */
    source: string;
}

const ALIASES: Record<string, string> =
{
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
    '@monthly': '0 0 1 * *',
    '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@hourly': '0 * * * *'
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec
{
    name: string;
    min: number;
    max: number;
    /** Symbolic names, index-mapped starting at `namesBase`. */
    names?: string[];
    namesBase?: number;
    /** Post-parse normalization (day-of-week folds 7 onto 0). */
    normalize?: (value: number) => number;
}

const FIELD_SPECS: readonly [FieldSpec, FieldSpec, FieldSpec, FieldSpec, FieldSpec] =
[
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day-of-month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12, names: MONTH_NAMES, namesBase: 1 },
    { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES, namesBase: 0, normalize: (value) => (value === 7 ? 0 : value) }
];

/** @internal One token ('5', 'fri', 'jan') to its numeric value, bounds-checked. */
function resolveToken(token: string, spec: FieldSpec, expression: string): number
{
    const named = spec.names?.indexOf(token.toLowerCase());
    if (named !== undefined && named !== -1)
    {
        return (spec.namesBase ?? 0) + named;
    }
    if (!/^\d+$/.test(token))
    {
        throw new Error(`Cron "${ expression }": "${ token }" is not a valid ${ spec.name } value.`);
    }
    const value = Number(token);
    if (value < spec.min || value > spec.max)
    {
        throw new Error(`Cron "${ expression }": ${ spec.name } value ${ value } is outside ${ spec.min }-${ spec.max }.`);
    }
    return value;
}

// One field to its allowed-value set: '*', '1-5', 'mon,wed,fri', a '/n' step over '*' or a
// range, or the vixie 'value/n' form meaning value-to-max. @internal

function parseField(field: string, spec: FieldSpec, expression: string): Set<number>
{
    const out = new Set<number>();
    for (const term of field.split(','))
    {
        if (term === '')
        {
            throw new Error(`Cron "${ expression }": empty ${ spec.name } term (a stray comma?).`);
        }
        const [base, stepToken, extra] = term.split('/');
        if (extra !== undefined)
        {
            throw new Error(`Cron "${ expression }": "${ term }" has more than one "/" in the ${ spec.name } field.`);
        }
        if (base === undefined || base === '')
        {
            throw new Error(`Cron "${ expression }": "${ term }" is not a valid ${ spec.name } term.`);
        }
        let step = 1;
        if (stepToken !== undefined)
        {
            if (!/^\d+$/.test(stepToken) || Number(stepToken) < 1)
            {
                throw new Error(`Cron "${ expression }": step "/${ stepToken }" in the ${ spec.name } field must be a positive integer.`);
            }
            step = Number(stepToken);
        }

        let from: number;
        let to: number;
        if (base === '*')
        {
            from = spec.min;
            to = spec.max;
        }
        else if (base.includes('-'))
        {
            const [a, b, more] = base.split('-');
            if (more !== undefined || a === undefined || a === '' || b === undefined || b === '')
            {
                throw new Error(`Cron "${ expression }": "${ base }" is not a valid ${ spec.name } range.`);
            }
            from = resolveToken(a, spec, expression);
            to = resolveToken(b, spec, expression);
            if (from > to)
            {
                throw new Error(`Cron "${ expression }": ${ spec.name } range ${ base } runs backwards.`);
            }
        }
        else
        {
            from = resolveToken(base, spec, expression);
            // A bare value with a step ('10/5') means "from that value to the max" - vixie style.
            to = stepToken !== undefined ? spec.max : from;
        }

        for (let value = from; value <= to; value += step)
        {
            out.add(spec.normalize !== undefined ? spec.normalize(value) : value);
        }
    }
    return out;
}

/** Parses a 5-field cron expression (or an @alias). Throws with the exact problem on any error. */
export function parseExpression(expression: string): CronFields
{
    const trimmed = expression.trim();
    const lowered = trimmed.toLowerCase();
    if (lowered.startsWith('@'))
    {
        const resolved = ALIASES[lowered];
        if (resolved === undefined)
        {
            throw new Error(`Cron "${ expression }": unknown alias (known: ${ Object.keys(ALIASES).join(', ') }).`);
        }
        return { ...parseExpression(resolved), source: trimmed };
    }

    const [minuteField, hourField, domField, monthField, dowField, ...extra] = trimmed.split(/\s+/);
    if (minuteField === undefined || hourField === undefined || domField === undefined
        || monthField === undefined || dowField === undefined || extra.length > 0)
    {
        throw new Error(`Cron "${ expression }": expected 5 fields (minute hour day-of-month month day-of-week), got ${ trimmed.split(/\s+/).length }.`);
    }

    return {
        minutes: parseField(minuteField, FIELD_SPECS[0], trimmed),
        hours: parseField(hourField, FIELD_SPECS[1], trimmed),
        daysOfMonth: parseField(domField, FIELD_SPECS[2], trimmed),
        months: parseField(monthField, FIELD_SPECS[3], trimmed),
        daysOfWeek: parseField(dowField, FIELD_SPECS[4], trimmed),
        domRestricted: domField !== '*',
        dowRestricted: dowField !== '*',
        source: trimmed
    };
}

/** @internal The local wall-clock parts of an epoch instant in a timezone. */
interface LocalParts
{
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    dow: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** @internal A cached Intl formatter per timezone ('' = the system zone). */
function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat
{
    const key = timeZone ?? '';
    let formatter = FORMATTERS.get(key);
    if (formatter === undefined)
    {
        // Throws a RangeError for an unknown IANA name - callers surface that at registration.
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'short'
        });
        FORMATTERS.set(key, formatter);
    }
    return formatter;
}

/** Validates a timezone name eagerly (throws for an unknown one). */
export function assertTimeZone(timeZone: string): void
{
    formatterFor(timeZone);
}

/** @internal */
function partsIn(timeZone: string | undefined, epoch: number): LocalParts
{
    const parts: Record<string, string> = {};
    for (const part of formatterFor(timeZone).formatToParts(epoch))
    {
        parts[part.type] = part.value;
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
        minute: Number(parts.minute),
        dow: DAY_NAMES.indexOf((parts.weekday ?? '').toLowerCase().slice(0, 3))
    };
}

/** The wall-clock identity of one occurrence - what "fires once" is measured against. */
export function localKeyOf(timeZone: string | undefined, epoch: number): string
{
    const p = partsIn(timeZone, epoch);
    return `${ p.year }-${ p.month }-${ p.day }T${ p.hour }:${ p.minute }`;
}

const MINUTE = 60_000;

/** The shortest local day any real timezone produces (a 23-hour spring-forward day, with margin). */
const SAFE_DAY_JUMP_MINUTES = 23 * 60;

/**
 * The next epoch instant STRICTLY AFTER `afterEpoch` whose local wall clock (in `timeZone`)
 * matches `fields`. `skipLocalKey` dedupes a repeated local time (the DST fall-back hour):
 * pass the key of the occurrence that already fired and its wall-clock twin is skipped.
 * Throws when no match exists within ~5 years (a never-matching expression like `0 0 31 2 *`).
 */
export function nextOccurrence(
    fields: CronFields,
    afterEpoch: number,
    timeZone?: string,
    skipLocalKey?: string
): number
{
    let t = Math.floor(afterEpoch / MINUTE) * MINUTE + MINUTE;

    // The scan only ever moves FORWARD and tests the real local parts of every candidate it
    // lands on; the jumps are conservative (a "day" jump undershoots on long days and never
    // overshoots past a matching minute), so correctness never depends on DST arithmetic.
    for (let i = 0; i < 400_000; i++)
    {
        const p = partsIn(timeZone, t);

        const domOk = fields.daysOfMonth.has(p.day);
        const dowOk = fields.daysOfWeek.has(p.dow);
        const dayOk = fields.domRestricted && fields.dowRestricted
            ? (domOk || dowOk)
            : fields.domRestricted ? domOk : fields.dowRestricted ? dowOk : true;

        if (!fields.months.has(p.month) || !dayOk)
        {
            const elapsed = p.hour * 60 + p.minute;
            t += Math.max(60, SAFE_DAY_JUMP_MINUTES - elapsed) * MINUTE;
            continue;
        }
        if (!fields.hours.has(p.hour))
        {
            t += (60 - p.minute) * MINUTE;
            continue;
        }
        if (!fields.minutes.has(p.minute))
        {
            t += MINUTE;
            continue;
        }
        if (skipLocalKey !== undefined && `${ p.year }-${ p.month }-${ p.day }T${ p.hour }:${ p.minute }` === skipLocalKey)
        {
            t += MINUTE; // the fall-back twin of an occurrence that already fired
            continue;
        }
        return t;
    }

    throw new Error(`Cron "${ fields.source }" never matches a real date (searched years ahead).`);
}
