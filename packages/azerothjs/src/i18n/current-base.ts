/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The url prefix the document lives under, held the way the language is: pinned for a server
 * render, read from `<html data-azeroth-base>` on the client. A router built with no explicit
 * base adopts it, so `/fa/about` matches `/about` on both sides.
 */

import { isStringMode } from '../reactivity/index.ts';
import { isLanguageTag } from './locale.ts';

/** SERVER: the base this synchronous render is pinned to. */
let renderBase: string | null = null;

/** Whether text is a prefix a document may carry: `/` followed by one language tag. */
export function isBasePrefix(text: string): boolean
{
    return text.startsWith('/') && isLanguageTag(text.slice(1));
}

/**
 * SERVER: pins one render to a url prefix. The shape is checked here, where every pin is set,
 * so no renderer option can pin an authority or a scheme onto the page's anchors.
 *
 * @internal Used by the SSR host.
 */
export function renderWithBase<T>(base: string, render: () => T): T
{
    if (!isBasePrefix(base))
    {
        throw new Error(`azeroth: a render base is "/" followed by one language tag, got ${ JSON.stringify(base) }. `
            + 'The host derives it from the url\'s own language prefix; it never comes from request text.');
    }
    const previous = renderBase;
    renderBase = base;
    try
    {
        return render();
    }
    finally
    {
        renderBase = previous;
    }
}

/** The prefix the served document declares, or undefined when there is none or it is malformed. */
export function documentBase(): string | undefined
{
    if (typeof document === 'undefined')
    {
        return undefined;
    }
    const declared = document.documentElement.getAttribute('data-azeroth-base');
    return declared !== null && isBasePrefix(declared) ? declared : undefined;
}

/**
 * The prefix a router built now should adopt: the render pin during a server render, the
 * document's stamp on the client, nothing anywhere else.
 */
export function currentBase(): string | undefined
{
    return isStringMode() ? renderBase ?? undefined : documentBase();
}
