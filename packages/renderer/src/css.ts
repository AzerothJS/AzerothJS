// ============================================================================
// AZEROTHJS — Scoped CSS (css``)
// ============================================================================
//
// A tagged-template that gives component-scoped styles without a
// build step. Author plain CSS with simple `.class` selectors; the
// helper:
//
//   1. Hashes the CSS text into a short, stable scope suffix.
//   2. Rewrites every `.name` selector to `.name_<scope>`.
//   3. Records the rewritten CSS in a registry (every environment),
//      and in the browser injects it into <head> exactly ONCE
//      (deduped by scope, so re-rendering never re-injects).
//   4. Returns a map so `styles.name` → `'name_<scope>'`.
//
//   const styles = css`
//     .card  { padding: 1rem; background: #111; }
//     .title { font-weight: 700; }
//   `;
//   h('div', { class: styles.card }, h('h1', { class: styles.title }, 'Hi'));
//
// Scoping is by content hash: two components with different rules
// for `.card` get different suffixes (no collisions); two with the
// SAME rules share one injected stylesheet (dedup). Hashing is
// deterministic, so it's stable across reloads and SSR-friendly.
//
// SSR: on the server there's no <head> to inject into, so every
// scope's CSS is also recorded in a registry. After rendering, flush
// it into the document head with collectStyleSheet() — see below.
//
// ============================================================================

/** Scope ids already injected into the document, so we inject once. */
const injectedScopes = new Set<string>();

/**
 * Every scope's rewritten CSS, recorded in ALL environments (browser
 * and server alike), keyed by scope so it stays deduped. On the server
 * this registry IS the stylesheet — there's no <head> to inject into —
 * so {@link collectStyleSheet} reads it to flush styles into the
 * server-rendered HTML.
 *
 * @internal
 */
const registeredCss = new Map<string, string>();

/**
 * A class-name map returned by {@link css}. Reading any property
 * returns the scoped class name; unknown keys return the key
 * unchanged (so a typo degrades to a harmless no-op class rather
 * than `undefined`).
 */
export type ScopedClasses = Record<string, string>;

/**
 * Deterministic djb2 string hash → base36. Stable across runs, so
 * the same CSS always yields the same scope (enables dedup + SSR).
 *
 * @internal
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
 * Rewrites `.name` class selectors to `.name_<scope>`, recording
 * each base name → scoped name in `classMap`.
 *
 * @internal
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
 * Component-scoped styles. Use as a tagged template (or pass a CSS
 * string). Returns a map of base class name → scoped class name.
 *
 * @param strings - Template strings (or a plain CSS string)
 * @param values - Interpolated values (stringified into the CSS)
 *
 * @returns A {@link ScopedClasses} map: `styles.foo` → `'foo_<scope>'`
 *
 * @example
 * ```ts
 * const s = css`
 *   .btn { padding: .5rem 1rem; border-radius: 8px; }
 *   .btn:hover { filter: brightness(1.1); }
 * `;
 * h('button', { class: s.btn }, 'Click');
 * ```
 */
export function css(strings: TemplateStringsArray | string, ...values: unknown[]): ScopedClasses
{
    const raw = typeof strings === 'string'
        ? strings
        : strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), '');

    const scope = hashCss(raw);
    const classMap: Record<string, string> = {};
    const scopedCss = scopeSelectors(raw, scope, classMap);

    // Record in every environment (idempotent by scope) so SSR can
    // collect it; in the browser, also inject a <style> once per scope.
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
 * Returns every scoped stylesheet registered by {@link css} so far,
 * concatenated into one CSS string. This is the SSR counterpart to the
 * browser's automatic `<style>` injection: render your app, then flush
 * the collected styles into the document `<head>`.
 *
 * @example
 * ```ts
 * const body = renderAppToString();
 * const head = `<style data-azeroth-css>${ collectStyleSheet() }</style>`;
 * return `<!doctype html><html><head>${ head }</head><body>${ body }</body></html>`;
 * ```
 *
 * In the browser these styles are already in the DOM, so this is
 * primarily a server-side helper (and useful for tests).
 */
export function collectStyleSheet(): string
{
    return [...registeredCss.values()].join('\n');
}

/**
 * Clears the scoped-CSS registry and DOM-injection bookkeeping. The
 * common pattern — `css\`\`` evaluated once at module load — needs no
 * reset, since the registry is the same for every request. Call this
 * only if your server genuinely re-imports component modules per
 * request, or to isolate tests.
 */
export function resetStyleSheet(): void
{
    registeredCss.clear();
    injectedScopes.clear();
}
