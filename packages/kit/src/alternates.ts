/**
 * The hreflang set for one app path, shared by the live render and the prerender pass.
 */

/**
 * @internal A decoded path as an href: re-escapes only `%`, `?` and `#`, which would change
 * the url it names, and leaves every other character as it is.
 */
export function hrefPathOf(path: string): string
{
    return path.replace(/[%?#]/g, encodeURIComponent);
}

/**
 * @internal One `<link rel="alternate" hreflang>` per language plus `x-default` at the
 * unprefixed path. Without an origin the hrefs are relative to the site's root, so the
 * artifact works on every host.
 */
export function alternatesOf(prefixes: readonly string[], path: string, search: string, origin = ''): Array<{ hreflang: string; href: string }>
{
    if (prefixes.length === 0)
    {
        return [];
    }
    const alternates = prefixes.map((tag) => ({
        hreflang: tag,
        href: `${ origin }/${ tag }${ path === '/' ? '' : path }${ search }`
    }));
    alternates.push({ hreflang: 'x-default', href: `${ origin }${ path }${ search }` });
    return alternates;
}
