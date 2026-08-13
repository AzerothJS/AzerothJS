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
 */

import { isStringMode, getStoreScope } from '../reactivity/index.ts';

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
 * djb2 to base36. Deterministic across runs, which is what lets the same CSS dedupe to one
 * scope and lets server and client agree on the class names.
 */
function hashCss(input: string): string
{
    let hash = 5381;
    for (let i = 0; i < input.length; i++)
    {
        hash = (((hash << 5) + hash) + input.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

/** A class-selector identifier after the `.`; sticky, so it matches in place. */
const CLASS_IDENT = /-?[_a-zA-Z][\w-]*/y;

/**
 * Rewrites `.name` selectors to `.name_<scope>`, recording each mapping in `classMap`.
 *
 * Quoted strings, `url(...)` bodies and comments are copied VERBATIM, because a dotted token
 * inside them is content rather than a selector. Rewriting `url(./logo.png)` or
 * `content: ".done"` would 404 the asset or corrupt the value while the class names kept
 * working, so the breakage would be silent.
 */
function scopeSelectors(cssText: string, scope: string, classMap: Record<string, string>): string
{
    const n = cssText.length;
    let out = '';
    let i = 0;

    // Copies a quoted string verbatim, honouring backslash escapes, and returns the index one
    // past the closing quote.
    const copyString = (from: number): number =>
    {
        const quote = cssText.charAt(from);
        let j = from + 1;
        while (j < n)
        {
            const c = cssText.charAt(j);
            if (c === '\\')
            {
                j += 2;
                continue;
            }
            j++;
            if (c === quote)
            {
                break;
            }
        }
        out += cssText.slice(from, j);
        return j;
    };

    while (i < n)
    {
        const ch = cssText.charAt(i);

        if (ch === '"' || ch === '\'')
        {
            i = copyString(i);
            continue;
        }

        if (ch === '/' && cssText.charAt(i + 1) === '*')
        {
            const end = cssText.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            out += cssText.slice(i, stop);
            i = stop;
            continue;
        }

        // url( token (not the tail of a longer identifier): copy through the closing paren,
        // still honoring a quoted body so `url("a)b.png")` does not end early.
        if ((ch === 'u' || ch === 'U')
            && /^url\(/i.test(cssText.slice(i, i + 4))
            && !/[\w-]/.test(cssText.charAt(i - 1)))
        {
            out += cssText.slice(i, i + 4);
            i += 4;
            while (i < n && cssText.charAt(i) !== ')')
            {
                const inner = cssText.charAt(i);
                if (inner === '"' || inner === '\'')
                {
                    i = copyString(i);
                    continue;
                }
                out += inner;
                i++;
            }
            continue;
        }

        if (ch === '.')
        {
            CLASS_IDENT.lastIndex = i + 1;
            const match = CLASS_IDENT.exec(cssText);
            if (match !== null)
            {
                const name = match[0];
                const scoped = `${ name }_${ scope }`;
                classMap[name] = scoped;
                out += `.${ scoped }`;
                i += 1 + name.length;
                continue;
            }
        }

        out += ch;
        i++;
    }

    return out;
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
    const raw = typeof strings === 'string'
        ? strings
        : strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), '');

    const scope = hashCss(raw);
    const classMap: Record<string, string> = {};
    const scopedCss = scopeSelectors(raw, scope, classMap);

    // Inside a string render the scope is RENDER-SCOPED, going into the current frame keyed by
    // the render's store scope - the same per-request identity runInStoreScope gives createStore
    // - so one request's rules, and anything interpolated into them, never reach another
    // request's document. Outside a render the scope is app-static and lands in the global
    // registry, and in the browser it is injected into <head> once.
    if (isStringMode())
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

    // A missing key returns the key itself, so a typo degrades to a no-op class.
    return new Proxy(classMap, {
        get(target, key: string): string
        {
            return target[key] ?? key;
        }
    });
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
