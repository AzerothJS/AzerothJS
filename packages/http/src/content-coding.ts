/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** @internal The `q` weight of one Accept-Encoding entry, from its parameters (default 1). */
function qualityOf(parameters: string[]): number
{
    for (const parameter of parameters)
    {
        const equals = parameter.indexOf('=');
        if (parameter.slice(0, equals === -1 ? undefined : equals).trim().toLowerCase() !== 'q')
        {
            continue;
        }
        const quality = Number(parameter.slice(equals + 1).trim());
        // An unparseable weight counts as a refusal: identity is always acceptable, so
        // guessing "acceptable" is the only reading that can put an undecodable body on the wire.
        return Number.isFinite(quality) ? Math.min(Math.max(quality, 0), 1) : 0;
    }
    return 1;
}

/**
 * @internal The client's pick among what we implement, by the Accept-Encoding header.
 * `q=0` is a REFUSAL, not a listing (RFC 9110 12.5.3), so a coding named only to reject it is
 * never used. `*` stands for the codings the client did not name and authorizes gzip - the
 * universally safe pick - never brotli, which a client that wanted it would have named.
 */
export function negotiateEncodings(acceptEncoding: string): Array<'br' | 'gzip' | 'deflate'>
{
    const quality = new Map<string, number>();
    for (const entry of acceptEncoding.split(','))
    {
        const semicolon = entry.indexOf(';');
        const coding = entry.slice(0, semicolon === -1 ? undefined : semicolon).trim().toLowerCase();
        if (coding === '')
        {
            continue;
        }
        const weight = semicolon === -1 ? 1 : qualityOf(entry.slice(semicolon + 1).split(';'));
        // A coding listed twice keeps its LOWEST weight: a refusal anywhere in the field is
        // still a refusal.
        const previous = quality.get(coding);
        quality.set(coding, previous === undefined ? weight : Math.min(previous, weight));
    }

    const wildcard = quality.get('*') ?? 0;
    const codings = ['br', 'gzip', 'deflate'] as const;
    const weight = (coding: typeof codings[number]): number => quality.get(coding) ?? (coding === 'gzip' ? wildcard : 0);
    return codings.filter(coding => weight(coding) > 0).sort((a, b) => weight(b) - weight(a));
}
