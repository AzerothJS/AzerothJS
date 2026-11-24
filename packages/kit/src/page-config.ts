/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createHash } from 'node:crypto';
import { isLanguageTag } from 'azerothjs/internal';

function requireLanguageTag(tag: unknown, caller: string): asserts tag is string
{
    if (typeof tag !== 'string' || !isLanguageTag(tag))
    {
        throw new Error(`${ caller }: "${ String(tag) }" is not a language tag - use alphanumeric segments joined by hyphens.`);
    }
}

/** Check the entry's locale configuration before registering routes or writing any files. */
export function validatePageLocales(value: unknown, caller: string): void
{
    if (value === undefined)
    {
        return;
    }
    const locales = value as Record<string, unknown> | null;
    if (locales === null || typeof locales !== 'object' || !Array.isArray(locales.supported))
    {
        throw new Error(`${ caller }: locales must declare a supported array of language tags.`);
    }
    const spellings = new Map<string, string>();
    for (const tag of locales.supported as unknown[])
    {
        requireLanguageTag(tag, caller);
        const key = tag.toLowerCase();
        const previous = spellings.get(key);
        if (previous !== undefined && previous !== tag)
        {
            throw new Error(`${ caller }: supported locale tags "${ previous }" and "${ tag }" name the same artifact on a case-insensitive filesystem.`);
        }
        spellings.set(key, tag);
    }
    if (locales.default !== undefined)
    {
        requireLanguageTag(locales.default, caller);
    }
    if (locales.routing !== undefined && locales.routing !== 'negotiate' && locales.routing !== 'prefix')
    {
        throw new Error(`${ caller }: locale routing must be "negotiate" or "prefix".`);
    }
    if ((locales.cookie !== undefined && locales.cookie !== false && typeof locales.cookie !== 'string')
        || (locales.acceptLanguage !== undefined && typeof locales.acceptLanguage !== 'boolean'))
    {
        throw new Error(`${ caller }: locales.cookie must be a cookie name or false and locales.acceptLanguage must be a boolean.`);
    }
}

/** Only a public origin can prefix alternate links. Never put a rejected credential in an error. */
export function publicOrigin(value: string | undefined): string | undefined
{
    if (value === undefined)
    {
        return undefined;
    }
    // Check the raw spelling first: URL normalizes dot segments, backslashes and some controls.
    if (typeof value !== 'string' || !/^https?:\/\/[^\p{Cc}\s\\/?#@]+\/?$/iu.test(value) || !URL.canParse(value))
    {
        throw new Error('kit: origin must be an absolute public HTTP or HTTPS origin without credentials, path, query or fragment.');
    }
    return new URL(value).origin;
}

/** Handoff and ISR copies from the build and mount must identify the same deployment. */
export function pageBuildId(shell: string, origin: string | undefined, prefixes: readonly string[]): string
{
    const hash = createHash('sha256').update(shell);
    if (origin !== undefined || prefixes.length > 0)
    {
        hash.update('\0').update(JSON.stringify([origin, prefixes]));
    }
    return hash.digest('hex').slice(0, 16);
}
