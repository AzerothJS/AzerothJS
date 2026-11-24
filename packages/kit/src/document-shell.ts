/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

interface ShellAttribute
{
    name: string;
    value: string;
    source: string;
}

interface ShellElement
{
    start: number;
    end: number;
    attributes: ShellAttribute[];
}

/**
 * Reads the explicit document element of a built HTML shell, including its literal
 * attribute spans. Stop at the first element. A tag-shaped string in a comment,
 * document body, script or quoted attribute does not declare the document language.
 */
export function documentElement(shell: string): ShellElement | undefined
{
    const preamble = /[\t\n\f\r ]+|<!--[\s\S]*?--!?>|<!doctype(?=[\t\n\f\r >])(?:[^>"']|"[^"]*"|'[^']*')*>/iy;
    preamble.lastIndex = shell.startsWith('\uFEFF') ? 1 : 0;
    let start = preamble.lastIndex;
    while (preamble.test(shell))
    {
        start = preamble.lastIndex;
    }
    const opener = /<html(?=[\t\n\f\r />])/iy;
    opener.lastIndex = start;
    if (!opener.test(shell))
    {
        return undefined;
    }

    const end = /[\t\n\f\r ]*\/?>/y;
    const attribute = /[\t\n\f\r ]*([^\t\n\f\r /"'<>=]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'<=>`]*)))?/y;
    const attributes: ShellAttribute[] = [];
    let position = opener.lastIndex;
    for (;;)
    {
        end.lastIndex = position;
        if (end.test(shell))
        {
            return { start, end: end.lastIndex, attributes };
        }
        attribute.lastIndex = position;
        const token = attribute.exec(shell);
        if (!token?.[1])
        {
            return undefined;
        }
        attributes.push({
            name: token[1].toLowerCase(),
            value: token[2] ?? token[3] ?? token[4] ?? '',
            source: token[0].replace(/^[\t\n\f\r ]+/, '')
        });
        position = attribute.lastIndex;
    }
}

/** Decode HTML character references that can spell a BCP 47 language tag. */
export function shellLanguage(element: ShellElement | undefined): string | undefined
{
    const value = element?.attributes.find(attr => attr.name === 'lang')?.value;
    if (!value)
    {
        return undefined;
    }
    // fjlig is the only named HTML reference made entirely of language-tag characters.
    return value.replace(/&fjlig;|&#(?:[xX]([\da-fA-F]+)|(\d+));?/g, (raw, hex: string | undefined, decimal: string | undefined) =>
    {
        if (raw === '&fjlig;')
        {
            return 'fj';
        }
        const point = hex !== undefined ? parseInt(hex, 16) : Number(decimal);
        return point > 0 && point <= 0x10FFFF && (point < 0xD800 || point > 0xDFFF) ? String.fromCodePoint(point) : '\uFFFD';
    });
}
