/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Scoped CSS through a tagged template, with no build step. The rule text is hashed into a
 * short scope suffix, every `.name` selector is rewritten to `.name_<scope>`, and the
 * returned map resolves `styles.name` to the scoped name.
 *
 * Scoping by CONTENT HASH is what makes two components that both define `.card` stop
 * fighting: different rules get different suffixes, identical rules dedupe to one stylesheet,
 * and the hash is deterministic, so it is stable across reloads and identical on server and
 * client.
 *
 * In the browser the rewritten CSS is injected into `<head>` once per scope. Under SSR there
 * is no head to inject into, so a render's scopes are recorded against that render and
 * flushed afterwards with {@link collectStyleSheet}.
 *
 * The hash and the selector rewrite themselves live in azerothjs/semantics, because a
 * `.azeroth` file's `style { }` section runs the SAME two functions at compile time to learn
 * which scoped name each class in the markup must become. Two implementations of that rewrite
 * would disagree on a name and the page would render unstyled with nothing to see in a diff.
 */

import { isStringMode, getStoreScope } from '../reactivity/index.ts';
import { DEV } from '../reactivity/dev.ts';
import { hashCss, scopeSelectors } from '../semantics.ts';

import { adoptStyleSheet, resetAdoptedStyleSheets } from './adopt-style.ts';
import { STYLE_BREAKOUT } from './ssr.ts';

/** Scopes already injected into the document, so injection happens once per scope. */
const injectedScopes = new Set<string>();

/**
 * Scopes registered OUTSIDE a string render - at module load, on the client, in tests. These
 * are the app's static stylesheet: every collected document includes them, and in the browser
 * they are what reaches `<head>`.
 */
const registeredCss = new Map<string, string>();

/**
 * Scopes registered DURING the current string render, keyed by that render's store scope so
 * they belong to exactly one request.
 *
 * Deliberately kept out of the global registry: recording a per-render interpolation there
 * would serve one request's CSS to every later request, and grow the process's memory by an
 * entry per render forever. {@link collectStyleSheet} drains this frame, and a new render
 * under a different store scope replaces whatever frame an aborted render left behind.
 */
let frameCss: Map<string, string> | null = null;
let frameOwner: object | null = null;

/**
 * The class-name map returned by {@link css}. Reading any property returns the scoped class
 * name; an unknown key returns the key unchanged, so a typo degrades to a harmless no-op
 * class rather than `undefined`.
 */
export type ScopedClasses = Record<string, string>;

/**
 * Component-scoped styles from a tagged template or a plain string. The rules are hashed and
 * rewritten into a unique scope, recorded once, and a map from base to scoped class name is
 * returned.
 *
 * Only `.class` selectors are scoped. Element, id and attribute selectors stay GLOBAL, so
 * `div { margin: 0 }` inside a css`` block still applies to the whole page.
 *
 * Identical rule text anywhere in the app shares one injected scope, since the scope is a
 * content hash. Reading an unknown key returns the key unchanged rather than `undefined`, so
 * a typo degrades to a harmless no-op class instead of `class="undefined"`.
 *
 * Evaluate it once, typically at module load. Calling it per render recomputes a scope that
 * is already cached.
 *
 * @param strings - A tagged template, or a plain CSS string.
 * @param values - Interpolations, stringified into the CSS before hashing.
 * @returns A map whose properties resolve to scoped class names.
 * @example
 * const styles = css`
 *     .btn { padding: .5rem 1rem; }
 *     .btn:hover { filter: brightness(1.1); }
 * `;
 *
 * h('button', { class: styles.btn }, 'Click'); // class="btn_1a2b3c"
 *
 * @see {@link collectStyleSheet} to emit the CSS during SSR.
 * @see {@link styleMap} for one-off dynamic values and {@link classList} for class toggles.
 */
export function css(strings: TemplateStringsArray | string, ...values: unknown[]): ScopedClasses
{
    const raw = typeof strings === 'string'
        ? strings
        : strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), '');

    // A missing key returns the key itself, so a typo degrades to a no-op class.
    return new Proxy(register(raw, true), {
        get(target, key: string): string
        {
            return target[key] ?? key;
        }
    });
}

/**
 * Registers a compiled `style { }` section's CSS. The compiled-output counterpart of
 * {@link css}, and the reason it is separate is the ONE way the two genuinely differ:
 * a section's text is a compile-time literal, so it is app-static by construction and is
 * never recorded per render.
 *
 * That distinction is load-bearing. A component module reached by a dynamic import - a lazy
 * route - is evaluated DURING a request, so a render-scoped registration would be drained with
 * that response and never run again, leaving every later request unstyled with nothing to see
 * in the emitted code. A section cannot interpolate a per-request value, so there is nothing
 * for the frame to isolate.
 *
 * Takes the section's RAW text and derives the scope here, so the class names the compiler
 * wrote into the markup and the class names this defines come from one algorithm over one
 * input.
 *
 * @param cssText - The section's CSS, verbatim.
 * @see {@link css} for hand-written scoped styles, including interpolated ones.
 * @internal Emitted by the compiler; part of the compiled-output contract, not application API.
 */
export function registerStyle(cssText: string): void
{
    register(cssText, false);
}

/**
 * Hashes, rewrites and records one block of CSS, returning its base-to-scoped class map.
 *
 * `perRender` is what separates the two callers. Inside a string render an interpolated
 * `css``` is RENDER-SCOPED, going into the current frame keyed by the render's store scope -
 * the same per-request identity runInStoreScope gives createStore - so one request's rules,
 * and anything interpolated into them, never reach another request's document. Everything else
 * is app-static and lands in the global registry. In the browser either is injected into
 * `<head>` once per scope.
 */
function register(raw: string, perRender: boolean): Record<string, string>
{
    const scope = hashCss(raw);
    const classMap: Record<string, string> = {};
    const scopedCss = scopeSelectors(raw, scope, classMap);

    if (perRender && isStringMode())
    {
        const owner = getStoreScope();
        if (frameCss === null || frameOwner !== owner)
        {
            frameOwner = owner;
            frameCss = new Map();
        }
        frameCss.set(scope, scopedCss);
    }
    else
    {
        registeredCss.set(scope, scopedCss);
    }

    if (typeof document !== 'undefined' && !injectedScopes.has(scope))
    {
        injectedScopes.add(scope);
        adoptStyleSheet(`css:${ scope }`, scopedCss, 'data-azeroth-css', scope);
    }

    return classMap;
}

/**
 * The CSS for the render that just finished: every app-static scope plus the scopes
 * {@link css} recorded during that render, deduped and joined. Call it on the server
 * immediately after rendering the body, to build the document head's `<style>`.
 *
 * The render frame is DRAINED. Those scopes belong to one response, so a later collect never
 * re-serves them.
 *
 * @returns The concatenated CSS, empty when nothing was registered.
 * @example
 * const head = `<style data-azeroth-css>${ collectStyleSheet() }</style>`;
 *
 * @see {@link css}
 */
/**
 * Discards the per-render frame if `owner` still holds it. The streaming session calls
 * this at finalize: a css`` evaluated inside a Suspense CONTINUATION registers into a
 * fresh frame AFTER the response's one collectStyleSheet() drain, and that orphan frame
 * would otherwise be served to whichever LATER render collects next - one response's
 * rules inside another response's document. Late rules cannot reach the already-flushed
 * head, so the honest behavior is a deterministic drop with a DEV diagnostic.
 *
 * @internal
 */
export function discardStyleFrame(owner: object): void
{
    if (frameOwner !== owner)
    {
        return;
    }
    if (DEV && frameCss !== null && frameCss.size > 0)
    {
        console.warn('azeroth: css`` evaluated inside a streamed Suspense continuation cannot reach the '
            + 'already-flushed document head; its rules were dropped for this response. Move the css`` '
            + 'call to the main pass, or use a style { } section (app-static).');
    }
    frameCss = null;
    frameOwner = null;
}

export function collectStyleSheet(): string
{
    const frame = frameCss;
    frameCss = null;
    frameOwner = null;

    const parts = [...registeredCss.values()];
    if (frame !== null)
    {
        for (const [scope, scoped] of frame)
        {
            if (!registeredCss.has(scope))
            {
                parts.push(scoped);
            }
        }
    }
    // The one consumer of this string embeds it in a `<style>` element, and `css` is a tagged
    // template whose signature invites an interpolated value (a per-tenant brand colour, a
    // `content:` label). A value carrying `</style>` would close the element and everything after
    // it would parse as markup, so the terminating sequence is neutralised with the CSS escape,
    // which is lossless for every legitimate use: `\3c` inside a CSS string is still `<`.
    return parts.join('\n').replace(STYLE_BREAKOUT, '\\3c');
}

/**
 * Clears the scoped-CSS registry and the DOM-injection bookkeeping.
 *
 * For isolating tests, and for the rare server that genuinely re-imports component modules
 * per request. An ordinary app should not call it: css`` evaluated once at module load
 * shares one registry safely across requests, and clearing it mid-session makes
 * {@link collectStyleSheet} miss styles that were already injected.
 *
 * @example
 * css`.box { color: red; }`;
 * resetStyleSheet();
 * collectStyleSheet(); // ''
 */
export function resetStyleSheet(): void
{
    registeredCss.clear();
    injectedScopes.clear();
    frameCss = null;
    frameOwner = null;
    // The adopted-sheet registry is a SECOND dedupe table. Clearing only this module's left
    // adopt-style still remembering every scope, so a reset followed by the same css() adopted
    // nothing and the rules vanished silently. Reset is one operation across both.
    resetAdoptedStyleSheets();
}
