/**
 * MODULE: renderer/css
 *
 * Scoped CSS via a tagged template, with no build step. Author plain CSS with simple
 * `.class` selectors; css() hashes the rule text into a short stable scope suffix, rewrites
 * every `.name` to `.name_<scope>`, records the rewritten CSS in a registry (every
 * environment) and - in the browser - injects it into <head> exactly once per scope, then
 * returns a map so `styles.name` resolves to `'name_<scope>'`. Global class names instead let
 * two components that both define `.card` silently fight; scoping by content hash means
 * different rules get different suffixes (no collisions) and identical rules dedupe to one
 * stylesheet. Hashing is deterministic, so it is stable across reloads and SSR-friendly.
 *
 * SSR: there is no <head> to inject into, so every scope's CSS is recorded in the registry;
 * after rendering, flush it with {@link collectStyleSheet}.
 */

/** Scope ids already injected into the document, so injection happens once per scope. @internal */
const injectedScopes = new Set<string>();

/**
 * Every scope's rewritten CSS, recorded in ALL environments and keyed by scope (deduped). On
 * the server this registry IS the stylesheet (no <head> to inject into); {@link collectStyleSheet}
 * reads it to flush styles into the server-rendered HTML.
 *
 * @internal
 */
const registeredCss = new Map<string, string>();

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

/**
 * Rewrites `.name` class selectors to `.name_<scope>`, recording each base->scoped name in
 * `classMap`.
 *
 * @internal
 * @param cssText - The CSS to rewrite.
 * @param scope - The scope suffix.
 * @param classMap - Mutated with base-name -> scoped-name entries.
 * @returns The rewritten CSS.
 */
function scopeSelectors(cssText: string, scope: string, classMap: Record<string, string>): string
{
    // Matches a class selector: a `.` followed by an identifier.
    return cssText.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (_match, name: string) =>
    {
        const scoped = `${ name }_${ scope }`;
        classMap[name] = scoped;
        return `.${ scoped }`;
    });
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

    // Record in every environment (idempotent by scope) so SSR can collect it; in the
    // browser, also inject a <style> once per scope.
    registeredCss.set(scope, scopedCss);

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
            return key in target ? target[key] : key;
        }
    });
}

/**
 * collectStyleSheet
 *
 * PURPOSE:
 * Returns every scoped stylesheet registered by {@link css} so far, concatenated into one CSS
 * string - the SSR counterpart to the browser's automatic <style> injection.
 *
 * WHY IT EXISTS:
 * On the server there is no <head> to inject into, so scoped CSS accumulates in the registry;
 * after rendering the body you need one call to emit all of it into the document head.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime; an SSR helper (and useful in tests). Reads the registry css() populates.
 *
 * OUTPUT CONTRACT:
 * - The newline-joined CSS of all registered scopes (deduped). Empty when nothing registered.
 *
 * WHEN TO USE:
 * On the server, after rendering, to build the <style> for the document head.
 *
 * WHEN NOT TO USE:
 * In the browser for styling - those styles are already injected; this is mainly for SSR/tests.
 *
 * PERFORMANCE NOTES:
 * O(total CSS length); a join over the registry values.
 *
 * @returns All registered scoped CSS, concatenated.
 * @see {@link css}
 * @example
 * const head = `<style data-azeroth-css>${ collectStyleSheet() }</style>`;
 */
export function collectStyleSheet(): string
{
    return [...registeredCss.values()].join('\n');
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
}
