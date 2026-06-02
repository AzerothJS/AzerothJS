// ============================================================================
// AZEROTHJS — renderToDocument
// ============================================================================
//
// Wraps a component's body HTML in a full HTML document and flushes the
// scoped CSS collected during render into a <style> tag in the <head>.
//
// The body is rendered FIRST so that every `css\`\`` call in the tree has
// registered its scope before collectStyleSheet() reads the registry.
//
// ============================================================================

import { collectStyleSheet } from '@azerothjs/renderer';
import { escapeText, escapeAttr } from '@azerothjs/reactivity';
import { renderToString, renderToStaticMarkup } from './render-to-string.ts';

/**
 * Options for {@link renderToDocument}.
 */
export interface RenderToDocumentOptions
{
    /** Extra raw HTML appended to the `<head>` (meta tags, links, scripts). */
    head?: string;

    /** Document title; escaped and emitted as `<title>`. */
    title?: string;

    /** `<html lang>` value. Defaults to `'en'`. */
    lang?: string;

    /** Raw attribute string for the `<body>` tag (e.g. `class="dark"`). */
    bodyAttrs?: string;

    /**
     * When true, render the body with {@link renderToStaticMarkup} (no
     * hydration markers). Defaults to false (hydration-ready markup).
     */
    static?: boolean;
}

/**
 * Renders a component into a complete HTML document string, with scoped CSS
 * flushed into the `<head>`.
 *
 * @param component - A thunk that builds the root element
 * @param options - Document-level {@link RenderToDocumentOptions}
 * @returns A full `<!doctype html>` document string
 *
 * @example
 * ```ts
 * const html = renderToDocument(() => App({}), {
 *     title: 'My App',
 *     lang: 'en',
 *     head: '<meta name="viewport" content="width=device-width, initial-scale=1">'
 * });
 * ```
 */
export function renderToDocument(component: () => HTMLElement, options: RenderToDocumentOptions = {}): string
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
