/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Wraps a component's body HTML in a full HTML document and flushes the scoped CSS collected
 * during render into a <style> in the <head>. The body is rendered FIRST so every css`` call in
 * the tree has registered its scope before collectStyleSheet() reads the registry.
 */

import { collectStyleSheet } from '../renderer/index.ts';
import { collectHead } from '../renderer/head.ts';
import { escapeText, escapeAttr } from '../reactivity/index.ts';
import { renderToString } from './render-to-string.ts';

/**
 * Options for {@link renderToDocument}.
 */
export interface RenderToDocumentOptions
{
    /** Extra raw HTML appended to the <head> (meta tags, links, scripts). */
    head?: string;

    /** Document title; escaped and emitted as <title>. */
    title?: string;

    /** <html lang> value. Defaults to 'en'. */
    lang?: string;

    /** Raw attribute string for the <body> tag (e.g. class="dark"). */
    bodyAttrs?: string;

    /** When true, render the body with no hydration markers. Defaults to false. */
    static?: boolean;
}

/**
 * Renders a component into a complete HTML document, flushing the scoped CSS the render
 * collected into a `<style>` in the head.
 *
 * The body is rendered BEFORE the CSS is collected, which is the ordering that matters:
 * css`` registers its scopes during the render, so reading the registry any earlier yields an
 * empty stylesheet. With no css`` in the tree, no `<style>` is emitted at all.
 *
 * `head` and `bodyAttrs` are inserted RAW, so never pass unescaped user input through them.
 * `title` and `lang` are escaped for you.
 *
 * @param component - A thunk building the root element.
 * @param options - Document-level settings. `static: true` emits marker-free body HTML, which
 *                  is not hydratable.
 * @returns A full `<!doctype html>` document.
 * @example
 * const html = renderToDocument(() => App({}), {
 *     title: 'My App',
 *     head: '<meta name="viewport" content="width=device-width, initial-scale=1">'
 * });
 *
 * @see {@link renderToString} when you only need the body.
 */
export function renderToDocument(component: () => HTMLElement | DocumentFragment, options: RenderToDocumentOptions = {}): string
{
    const lang = options.lang ?? 'en';

    // Render the body FIRST so css``/useHead register before we collect them.
    const body = renderToString(component, { markers: options.static !== true });
    const styles = collectStyleSheet();
    const collected = collectHead();

    let head = '<meta charset="utf-8">';

    // A useHead-collected title WINS over the static option; the option is the fallback.
    if (collected.titleText !== null)
    {
        head += collected.titleElementHtml ?? '';
    }
    else if (options.title !== undefined)
    {
        head += `<title>${ escapeText(options.title) }</title>`;
    }

    if (styles)
    {
        head += `<style data-azeroth-css>${ styles }</style>`;
    }

    if (options.head)
    {
        head += options.head;
    }

    // The collected singletons and additions: this head is self-built (no shell), so
    // there is nothing to replace - everything appends.
    for (const item of collected.replacements)
    {
        head += item.html;
    }
    head += collected.additions;

    const bodyAttrs = options.bodyAttrs ? ` ${ options.bodyAttrs }` : '';

    return `<!doctype html><html lang="${ escapeAttr(lang) }"><head>${ head }</head><body${ bodyAttrs }>${ body }</body></html>`;
}
