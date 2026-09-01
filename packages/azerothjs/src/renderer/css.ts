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

import { isStringMode } from '../reactivity/index.ts';
import { currentFrame, resetSlotCss, strayWriteFrame, takeSlotCss } from './frame.ts';
import type { RenderFrame } from './frame.ts';
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
// The per-render frame lives in renderer/frame.ts as a VALUE the render's host owns -
// the module-global map keyed on a store scope is gone (a scope could never say WHICH
// window's frame it was, and the drain had no identity at all).

/**
 * The class-name map returned by {@link css}. Reading any property returns the scoped class
 * name; an unknown key returns the key unchanged, so a typo degrades to a harmless no-op
 * class rather than `undefined`.
 */
export type ScopedClasses = Record<string, string>;

/**
 * The characters by which an interpolated VALUE could stop being a value: the block braces, the
 * declaration terminator, the backslash that would otherwise consume the escapes below, and `<`
 * as defence in depth for the `</style` case, so this guarantee does not depend on a later HTML
 * pass. Everything else is left exactly as written.
 */
const CSS_VALUE_BREAKOUT = /[\\{};<]/g;

/**
 * Escapes one interpolated value so it cannot leave its declaration.
 *
 * `css` puts DATA into CSS SOURCE. Concatenated raw, a value containing `}` closes the
 * declaration and the rule and opens new ones, injecting live rules - a `url()` is a network
 * request, so that is an exfiltration channel, and attribute selectors make it a
 * character-at-a-time one. It never has to leave the style element, so the `</style` breakout
 * guard downstream never sees it; and the registered text feeds BOTH the server prelude and the
 * client stylesheet, so the escape belongs here rather than at either consumer.
 *
 * CSS hex escapes rather than stripping, because they are FAITHFUL where the value is legitimate:
 * inside a quoted string the escape still renders the character, so a value carrying one of these
 * keeps its meaning while losing its structure. The trailing space terminates the escape so a
 * following hex digit is not swallowed into it.
 *
 * An interpolation is a VALUE, not CSS source. Compose rule text with a `style { }` section or a
 * CSS import, which are parsed as CSS rather than spliced into it.
 */
function escapeCssValue(value: string): string
{
    return value.replace(CSS_VALUE_BREAKOUT, (char) => '\\' + (char.codePointAt(0) ?? 0).toString(16) + ' ');
}

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
    // The template PARTS are the author's own CSS source; the VALUES are data, and are escaped.
    // A plain-string call is entirely author source and is left alone - there is no author/data
    // split to draw in it.
    const raw = typeof strings === 'string'
        ? strings
        : strings.reduce((acc, part, i) => acc + part + (i < values.length ? escapeCssValue(String(values[i])) : ''), '');

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
        (currentFrame() ?? strayWriteFrame('css')).css.set(scope, scopedCss);
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
 * With a `frame` (the one this render's host passed through the render options): a PURE
 * read of exactly that render's scopes - drain as often as needed, identical every time.
 * Without one: the legacy slot's css payload is CONSUMED - those scopes belong to one
 * response, and a later zero-argument collect never re-serves them.
 *
 * @param frame - The render frame to read; omit for the legacy one-render-at-a-time slot.
 * @returns The concatenated CSS, empty when nothing was registered.
 * @example
 * const head = `<style data-azeroth-css>${ collectStyleSheet() }</style>`;
 *
 * @see {@link css}
 */
export function collectStyleSheet(frame?: RenderFrame): string
{
    // With a frame: a pure read of exactly that render's scopes - drain as often as you
    // like. Without one: the legacy slot's css payload is consumed (its head payload
    // belongs to collectHead; an empty payload counts as consumed, so a styles-only host
    // never strands the slot).
    const scopes = frame !== undefined ? frame.css : takeSlotCss();

    const parts = [...registeredCss.values()];
    if (scopes !== null)
    {
        for (const [scope, scoped] of scopes)
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
    // Per-payload: only the legacy slot's CSS clears here - the head payload belongs to
    // resetHead - and a live render window keeps its frame (diagnosed in DEV).
    resetSlotCss();
    // The adopted-sheet registry is a SECOND dedupe table. Clearing only this module's left
    // adopt-style still remembering every scope, so a reset followed by the same css() adopted
    // nothing and the rules vanished silently. Reset is one operation across both.
    resetAdoptedStyleSheets();
}
