/**
 * MODULE: renderer/css
 *
 * Scoped CSS via a tagged template, with no build step. Author plain CSS with simple
 * `.class` selectors; css() hashes the rule text into a short stable scope suffix, rewrites
 * every `.name` to `.name_<scope>`, records the rewritten CSS (app-global outside a render,
 * render-scoped during SSR) and - in the browser - injects it into <head> exactly once per
 * scope, then returns a map so `styles.name` resolves to `'name_<scope>'`. Global class
 * names instead let two components that both define `.card` silently fight; scoping by
 * content hash means different rules get different suffixes (no collisions) and identical
 * rules dedupe to one stylesheet. Hashing is deterministic, so it is stable across reloads
 * and SSR-friendly.
 *
 * SSR: there is no <head> to inject into, so a render's scopes are recorded against that
 * render; after rendering, flush them with {@link collectStyleSheet}.
 */

import { isStringMode, getStoreScope } from '../reactivity/index.ts';

import { STYLE_BREAKOUT } from './ssr.ts';

/** Scope ids already injected into the document, so injection happens once per scope. @internal */
const injectedScopes = new Set<string>();

/**
 * Scopes registered OUTSIDE a string render (module load, client, tests), keyed by scope
 * (deduped). These are the app's static stylesheet: every collected document includes them,
 * and in the browser they are what gets injected into <head>.
 *
 * @internal
 */
const registeredCss = new Map<string, string>();

/**
 * Scopes registered DURING the current string render, keyed by the render's store scope so
 * they belong to exactly one request. Kept OUT of the global registry: recording a
 * per-render interpolation there would serve one request's CSS to every later request and
 * grow the process's memory by one entry per render, forever. {@link collectStyleSheet}
 * drains this frame; a new render (a different store scope) replaces a frame an aborted
 * render left behind.
 *
 * @internal
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
 * Deterministic djb2 string hash to base36 - stable across runs, so the same CSS always
 * yields the same scope (enables dedup and SSR).
 *
 * @internal
 * @param input - The CSS text to hash.
 * @returns A short base36 scope suffix.
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

/** A class-selector identifier after the `.`; sticky so it matches in place. @internal */
const CLASS_IDENT = /-?[_a-zA-Z][\w-]*/y;

/**
 * Rewrites `.name` class selectors to `.name_<scope>`, recording each base->scoped name in
 * `classMap`. Quoted strings, `url(...)` bodies, and comments are copied VERBATIM: a dotted
 * token inside them is content, not a selector - rewriting `url(./logo.png)` or
 * `content: ".done"` would 404 the asset or corrupt the value while the class names still
 * work, so the breakage is silent.
 *
 * @internal
 * @param cssText - The CSS to rewrite.
 * @param scope - The scope suffix.
 * @param classMap - Mutated with base-name -> scoped-name entries.
 * @returns The rewritten CSS.
 */
function scopeSelectors(cssText: string, scope: string, classMap: Record<string, string>): string
{
    const n = cssText.length;
    let out = '';
    let i = 0;

    // Copies a quoted string verbatim (honoring backslash escapes); returns the index one
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
 * css
 *
 * PURPOSE:
 * Component-scoped styles as a tagged template (or plain string). Hashes and rewrites the
 * rules to a unique scope, injects/records them once, and returns a base->scoped class map.
 *
 * WHY IT EXISTS:
 * Global class names collide across components and require an external stylesheet and a build
 * step. css() gives collision-proof, deduped, SSR-compatible scoping at runtime with no
 * tooling: the scope is a content hash, so identical rules share one stylesheet and different
 * rules never clash.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; an authoring helper independent of the compiler. In the browser it
 * injects a <style> per scope; on the server it records into the registry for
 * {@link collectStyleSheet} to flush.
 *
 * INPUT CONTRACT:
 * - strings/values: a tagged-template invocation, or a plain CSS string. Interpolations are
 *   stringified into the CSS before hashing.
 *
 * OUTPUT CONTRACT:
 * - Returns a {@link ScopedClasses} proxy: `styles.foo` -> `'foo_<scope>'`; an unknown key
 *   returns the key itself.
 *
 * WHY THIS DESIGN:
 * Content-hash scoping makes dedup and SSR deterministic without a build step. Recording in
 * every environment (and injecting only in the browser) is what lets the same code produce
 * client <style> tags and server-collectable CSS. The Proxy degrades typos gracefully.
 *
 * WHEN TO USE:
 * For component-local styling you want collision-free and dedup'd, authored as plain CSS.
 *
 * WHEN NOT TO USE:
 * For one-off dynamic inline values (use {@link styleMap}) or simple conditional class
 * toggles (use {@link classList}).
 *
 * EDGE CASES:
 * - Identical rule text across components shares ONE injected scope (dedup by hash).
 * - Reading an unscoped/typo'd key returns the key unchanged (no-op class), not undefined.
 *
 * PERFORMANCE NOTES:
 * Hash + rewrite are O(css length), done once per unique rule text; injection happens once
 * per scope. Re-rendering never re-injects.
 *
 * DEVELOPER WARNING:
 * Only `.class` selectors are scoped - element/id/attribute selectors stay global. Evaluate
 * css`` once (e.g. at module load); calling it per render recomputes the (cached) scope
 * needlessly.
 *
 * @param strings - Template strings (or a plain CSS string).
 * @param values - Interpolated values, stringified into the CSS.
 * @returns A {@link ScopedClasses} map.
 * @see {@link collectStyleSheet}
 * @example
 * const s = css`.btn { padding: .5rem 1rem; } .btn:hover { filter: brightness(1.1); }`;
 * h('button', { class: s.btn }, 'Click');
 */
export function css(strings: TemplateStringsArray | string, ...values: unknown[]): ScopedClasses
{
    const raw = typeof strings === 'string'
        ? strings
        : strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), '');

    const scope = hashCss(raw);
    const classMap: Record<string, string> = {};
    const scopedCss = scopeSelectors(raw, scope, classMap);

    // Record where the call happened. Inside a string render the scope is RENDER-SCOPED:
    // it goes into the current frame (keyed by the render's store scope, the same
    // per-request identity runInStoreScope gives createStore) so one request's rules -
    // and anything interpolated into them - never reach another request's document.
    // Outside a render (module load, client, tests) the scope is app-static and lands in
    // the global registry; in the browser, it is also injected into <head> once.
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
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-azeroth-css', scope);
        styleEl.textContent = scopedCss;
        document.head.appendChild(styleEl);
    }

    // Proxy so a missing key returns the key itself (degrade gracefully).
    return new Proxy(classMap, {
        get(target, key: string): string
        {
            return target[key] ?? key;
        }
    });
}

/**
 * collectStyleSheet
 *
 * PURPOSE:
 * Returns the CSS for the render that just finished - the global registry (module-load /
 * client scopes) plus the scopes {@link css} recorded DURING that render - concatenated
 * into one CSS string: the SSR counterpart to the browser's automatic <style> injection.
 *
 * WHY IT EXISTS:
 * On the server there is no <head> to inject into, so scoped CSS accumulates for the flush;
 * after rendering the body you need one call to emit it into the document head.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime; an SSR helper (and useful in tests). Reads the registry and drains the render
 * frame css() populated.
 *
 * OUTPUT CONTRACT:
 * - The newline-joined CSS of every global scope plus the just-finished render's scopes
 *   (deduped). Empty when nothing registered. The render frame is DRAINED: its scopes
 *   belong to one response, so a later collect never re-serves them.
 *
 * WHEN TO USE:
 * On the server, immediately after rendering, to build the <style> for the document head.
 *
 * WHEN NOT TO USE:
 * In the browser for styling - those styles are already injected; this is mainly for SSR/tests.
 *
 * PERFORMANCE NOTES:
 * O(total CSS length); a join over the registry and frame values.
 *
 * @returns The registered scoped CSS for this render, concatenated.
 * @see {@link css}
 * @example
 * const head = `<style data-azeroth-css>${ collectStyleSheet() }</style>`;
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
 * resetStyleSheet
 *
 * PURPOSE:
 * Clears the scoped-CSS registry and DOM-injection bookkeeping.
 *
 * WHY IT EXISTS:
 * The common pattern (css`` evaluated once at module load) shares one registry across
 * requests and needs no reset. This exists for the rare server that genuinely re-imports
 * component modules per request, and for isolating tests.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime; a test/SSR-isolation helper.
 *
 * OUTPUT CONTRACT:
 * - Returns void; empties both the registry and the injected-scope set.
 *
 * WHEN NOT TO USE:
 * In normal apps - clearing the registry mid-session would make {@link collectStyleSheet}
 * miss already-injected styles.
 *
 * @returns void
 * @see {@link collectStyleSheet}
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
}
