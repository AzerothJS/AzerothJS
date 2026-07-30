/**
 * MODULE: api/validate - one schema unification for both sides of the wire
 *
 * The client's pre-flight check and the mount's boundary check run the SAME
 * unification: a schema's capabilities are sniffed, never type-dispatched. A native
 * @azerothjs/schema value keeps its one-pass `safeParse` (issue codes included); any
 * other Standard Schema validator runs `~standard.validate`, its issues mapped to the
 * flat field-path errors the whole framework speaks. Failures are returned, never
 * thrown - each caller raises its own dialect (SchemaError in the browser,
 * ValidationError on the server).
 */

/** A validation success: the parsed (normalized) value. */
export interface ParseOk { ok: true; value: unknown }

/** A validation failure: the flat field-path map plus the ordered issue list. */
export interface ParseErr { ok: false; errors: Record<string, string>; issues?: Array<{ path: string; code: string; message: string }> }

/** Validates `value` through a route schema (native fast path, `~standard` otherwise). */
export async function parseAny(schema: unknown, value: unknown): Promise<ParseOk | ParseErr>
{
    const native = schema as { safeParse?: (v: unknown) => ParseOk | ParseErr };
    if (typeof native.safeParse === 'function')
    {
        return native.safeParse(value);
    }
    const standard = (schema as { ['~standard']: { validate: (v: unknown) => unknown } })['~standard'];
    const result = await standard.validate(value) as
        { value: unknown; issues?: undefined } | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };
    if (result.issues === undefined)
    {
        return { ok: true, value: result.value };
    }
    const errors: Record<string, string> = {};
    const issues: Array<{ path: string; code: string; message: string }> = [];
    for (const issue of result.issues)
    {
        const path = (issue.path ?? []).map((seg) => typeof seg === 'object' ? String(seg.key) : String(seg)).join('.') || 'root';
        errors[path] = errors[path] ?? issue.message;
        issues.push({ path, code: 'invalid', message: issue.message });
    }
    return { ok: false, errors, issues };
}
