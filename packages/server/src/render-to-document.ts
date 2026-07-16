/**
 * MODULE: server/render-to-document
 *
 * Wraps a component's body HTML in a full HTML document and flushes the scoped CSS collected
 * during render into a <style> in the <head>. The body is rendered FIRST so every css`` call in
 * the tree has registered its scope before collectStyleSheet() reads the registry.
 */

import { collectStyleSheet } from '@azerothjs/renderer';
import { escapeText, escapeAttr } from '@azerothjs/reactivity';
import { renderToString, renderToStaticMarkup } from './render-to-string.ts';

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

    /** When true, render the body with {@link renderToStaticMarkup} (no hydration markers). Defaults to false. */
    static?: boolean;
}

/**
 * renderToDocument
 *
 * PURPOSE:
 * Renders a component into a COMPLETE HTML document string, with the scoped CSS collected during
 * render flushed into a <head> <style>.
 *
 * WHY IT EXISTS:
 * A server response needs the full doctype/html/head/body shell, AND the scoped CSS must be read
 * AFTER the body renders (css`` registers its scopes during render). Hand-assembling that in the
 * right order is easy to get wrong (collecting CSS too early yields an empty stylesheet). This
 * does the ordering and the <style> flush for you.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, server; the top-level SSR entry that produces a whole page. Delegates the body to
 * {@link renderToString}/{@link renderToStaticMarkup} and the CSS flush to collectStyleSheet().
 *
 * INPUT CONTRACT:
 * - component: a thunk building the root element.
 * - options: document-level settings ({@link RenderToDocumentOptions}) - head, title, lang,
 *   bodyAttrs, and `static` to render marker-free.
 *
 * OUTPUT CONTRACT:
 * - A full `<!doctype html>` document string: charset, optional title, the collected scoped CSS,
 *   any extra head HTML, then the rendered body.
 *
 * WHY THIS DESIGN:
 * Rendering the body before collecting CSS is the crucial ordering - collectStyleSheet() reads the
 * registry css`` populated during the render, so an early read would miss styles. title/lang are
 * escaped to avoid injection; head/bodyAttrs are raw (caller-controlled).
 *
 * WHEN TO USE:
 * As the server response builder for a full page (hydration-ready by default, or `static: true`
 * for non-hydrated pages).
 *
 * WHEN NOT TO USE:
 * When you only need a fragment (use {@link renderToString}) or are assembling the shell yourself.
 *
 * EDGE CASES:
 * - `static: true` emits marker-free body HTML (not hydratable).
 * - With no css`` used, no <style> is emitted.
 *
 * PERFORMANCE NOTES:
 * One body render plus a string concat of the shell; the CSS is a single registry read.
 *
 * DEVELOPER WARNING:
 * `head` and `bodyAttrs` are inserted RAW - do not pass unescaped user input into them. Use
 * `title` for the document title (it is escaped for you).
 *
 * @param component - A thunk that builds the root element.
 * @param options - Document-level {@link RenderToDocumentOptions}.
 * @returns A full `<!doctype html>` document string.
 * @see {@link renderToString}
 * @example
 * const html = renderToDocument(() => App({}), {
 *   title: 'My App',
 *   head: '<meta name="viewport" content="width=device-width, initial-scale=1">'
 * });
 */
export function renderToDocument(component: () => HTMLElement | DocumentFragment, options: RenderToDocumentOptions = {}): string
{
    const lang = options.lang ?? 'en';

    // Render the body FIRST so css`` scopes register before we collect them.
    const body = options.static ? renderToStaticMarkup(component) : renderToString(component);
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
