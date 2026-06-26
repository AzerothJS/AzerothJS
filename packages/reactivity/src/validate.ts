/**
 * MODULE: reactivity/validate (internal)
 *
 * Tiny argument-validation helpers shared by the reactive primitives. Every public
 * entry point that expects a callback (or a dependency array) guards its input so a
 * mistaken call throws a precise, actionable developer error at the call site rather
 * than a confusing `x is not a function` from deep inside the graph machinery after
 * partial node setup.
 *
 * These run once per primitive construction (not on the reactive hot path), so the
 * check is free in any profile that matters.
 */

/**
 * A short, safe description of a value for an error message: its type, and for objects
 * the constructor name. Never throws (so it is safe on Symbols, null-prototype objects,
 * getters, etc.).
 *
 * @internal
 * @param value - The offending argument.
 * @returns A human-readable tag like `undefined`, `a number`, `null`, `an object`.
 */
export function describeArg(value: unknown): string
{
    if (value === null)
    {
        return 'null';
    }
    const t = typeof value;
    if (t === 'object')
    {
        const name = (value as { constructor?: { name?: string } })?.constructor?.name;
        return name && name !== 'Object' ? `a ${ name }` : 'an object';
    }
    if (t === 'undefined')
    {
        return 'undefined';
    }
    return `a ${ t }`;
}

/**
 * Throws a TypeError unless `fn` is callable.
 *
 * @internal
 * @param fn - The value that must be a function.
 * @param api - The primitive name, e.g. `createEffect`.
 * @param hint - A one-line "pass X instead" hint.
 */
export function assertFunction(fn: unknown, api: string, hint: string): void
{
    if (typeof fn !== 'function')
    {
        throw new TypeError(`${ api } expects a function, received ${ describeArg(fn) }. ${ hint }`);
    }
}
