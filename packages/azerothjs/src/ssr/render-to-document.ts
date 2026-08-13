/**
 * Wraps a component's body HTML in a full HTML document and flushes the scoped CSS collected
 * during render into a <style> in the <head>. The body is rendered FIRST so every css`` call in
 * the tree has registered its scope before collectStyleSheet() reads the registry.
 */

import { collectStyleSheet } from '../renderer/index.ts';
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

    // Render the body FIRST so css`` scopes register before we collect them.
    const body = renderToString(component, { markers: options.static !== true });
    const styles = collectStyleSheet();

    let head = '<meta charset="utf-8">';

    if (options.title !== undefined)
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

    const bodyAttrs = options.bodyAttrs ? ` ${ options.bodyAttrs }` : '';

    return `<!doctype html><html lang="${ escapeAttr(lang) }"><head>${ head }</head><body${ bodyAttrs }>${ body }</body></html>`;
}
