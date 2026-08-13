/**
 * Argument guards shared by the reactive primitives, so a mistaken call throws at the call
 * site instead of surfacing as `x is not a function` from deep inside the graph machinery
 * after a node was half built.
 *
 * They run once per construction, never on the reactive hot path.
 */

/**
 * A short description of a value for an error message: its type, plus the constructor name
 * for objects. Never throws, so it is safe on symbols, null-prototype objects and exotic
 * getters.
 *
 * @internal
 * @returns A readable tag such as `undefined`, `a number`, `null` or `an Array`.
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
        const name = (value as { constructor?: { name?: string } }).constructor?.name;
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
 * @param api - The primitive's name, used in the message.
 * @param hint - A one-line "pass X instead" correction.
 */
export function assertFunction(fn: unknown, api: string, hint: string): void
{
    if (typeof fn !== 'function')
    {
        throw new TypeError(`${ api } expects a function, received ${ describeArg(fn) }. ${ hint }`);
    }
}
