/**
 * The hreflang set for one app path, shared by the live render and the prerender pass.
 */

/**
 * @internal One `<link rel="alternate" hreflang>` per language plus `x-default` at the
 * unprefixed path, as root-relative hrefs. Empty outside prefix mode. Root-relative so a
 * prerendered file carries the same set whatever host serves it.
 */
export function alternatesOf(prefixes: readonly string[], path: string, search: string): Array<{ hreflang: string; href: string }>
{
    if (prefixes.length === 0)
    {
        return [];
    }
    const alternates = prefixes.map((tag) => ({
        hreflang: tag,
        href: `${ path === '/' ? `/${ tag }` : `/${ tag }${ path }` }${ search }`
    }));
    alternates.push({ hreflang: 'x-default', href: `${ path }${ search }` });
    return alternates;
}
