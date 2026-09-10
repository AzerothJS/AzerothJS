/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The url prefix a router works under: stripped from what history holds, joined onto what
 * the router writes. One rule shared by the router, the server renderer and the language
 * switch, so the two sides of a page agree on every spelling.
 */

import { isExternalUrl } from '../semantics.ts';

/**
 * Canonicalizes a configured base: `undefined`, `''` and `'/'` are no base; anything else
 * starts with `/` and has no trailing slash, so it can sit directly in front of an app path.
 */
export function normalizeBase(base: string | undefined): string
{
    if (!base || base === '/')
    {
        return '';
    }
    let b = base;
    if (!b.startsWith('/'))
    {
        b = '/' + b;
    }
    if (b.endsWith('/'))
    {
        b = b.slice(0, -1);
    }
    return b;
}

/**
 * Strips the base off a raw pathname: the base-relative path, or `null` outside the base.
 *
 * Compared one segment at a time, the pathname's segment decoded against the base's segment
 * as configured, so `/%66a/about` under `/fa` strips exactly as `/fa/about` does; the rest of
 * the pathname keeps its own spelling. The empty base is the identity.
 */
export function stripBasePrefix(pathname: string, base: string): string | null
{
    if (base === '')
    {
        return pathname;
    }
    const wanted = base.split('/').slice(1);
    const parts = pathname.split('/');
    if (parts[0] !== '')
    {
        return null;
    }
    for (let i = 0; i < wanted.length; i++)
    {
        const raw = parts[i + 1];
        if (raw === undefined)
        {
            return null;
        }
        let decoded: string;
        try
        {
            decoded = decodeURIComponent(raw);
        }
        catch
        {
            return null;
        }
        if (decoded !== wanted[i])
        {
            return null;
        }
    }
    const rest = parts.slice(wanted.length + 1);
    if (rest.length === 0 || (rest.length === 1 && rest[0] === ''))
    {
        return '/';
    }
    // A remainder that reads as an authority (an empty or a backslash segment after the base)
    // is outside the base: the router must never publish it as a base-relative path.
    const remainder = '/' + rest.join('/');
    return isExternalUrl(remainder) ? null : remainder;
}

/**
 * Joins the base onto a base-relative full path (pathname, search and hash). A lone `/`
 * collapses onto the base itself so the root has one spelling; the empty base is the identity.
 */
export function joinBase(base: string, fullPath: string): string
{
    if (base === '')
    {
        return fullPath;
    }
    const hashAt = fullPath.indexOf('#');
    const beforeHash = hashAt < 0 ? fullPath : fullPath.slice(0, hashAt);
    const hash = hashAt < 0 ? '' : fullPath.slice(hashAt);
    const queryAt = beforeHash.indexOf('?');
    const pathname = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
    const search = queryAt < 0 ? '' : beforeHash.slice(queryAt);
    return base + (pathname === '/' ? '' : pathname) + search + hash;
}
