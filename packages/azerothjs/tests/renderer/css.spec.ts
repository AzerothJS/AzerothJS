// @vitest-environment happy-dom
//
// Behavioral coverage for css/collectStyleSheet/resetStyleSheet (css.ts): scope
// hashing, selector rewriting, the scoped-class proxy, deterministic hashing,
// dedup, <style> injection into <head>, and registry collection/reset.
import { describe, it, expect, beforeEach } from 'vitest';
import { css, collectStyleSheet, resetStyleSheet } from 'azerothjs';

describe('css', () =>
{
    beforeEach(() =>
    {
        // Isolate each test: clear the registry and drop adopted sheets.
        resetStyleSheet();
        document.adoptedStyleSheets = [];
    });

    it('returns a map whose properties resolve to scoped class names', () =>
    {
        const s = css('.btn { color: red; }');
        expect(s.btn).toMatch(/^btn_[0-9a-z]+$/);
        // Scoped name carries the base name as a prefix.
        expect(s.btn?.startsWith('btn_')).toBe(true);
    });

    it('returns an unknown key unchanged (typo degrades to a harmless class)', () =>
    {
        const s = css('.card {}');
        expect(s.missing).toBe('missing');
    });

    it('rewrites every .class selector to its scoped form in the injected CSS', () =>
    {
        const s = css('.a { color: red; } .b:hover { color: blue; }');
        const sheet = collectStyleSheet();
        expect(sheet).toContain(`.${ s.a }`);
        expect(sheet).toContain(`.${ s.b }`);
        // Original unscoped selectors are gone.
        expect(sheet).not.toMatch(/\.a\s*\{/);
    });

    it('is deterministic: identical CSS text yields the same scope and dedups', () =>
    {
        const first = css('.same { color: green; }');
        const second = css('.same { color: green; }');
        expect(first.same).toBe(second.same);
        // Only one stylesheet recorded for identical text.
        expect(collectStyleSheet()).toBe('.' + (first.same ?? '') + ' { color: green; }');
    });

    it('gives different rule text different scope suffixes (no collision)', () =>
    {
        const a = css('.x { color: red; }');
        const b = css('.x { color: blue; }');
        expect(a.x).not.toBe(b.x);
    });

    it('adopts exactly one constructable stylesheet per scope', () =>
    {
        const before = document.adoptedStyleSheets.length;
        const s = css('.inject { padding: 1px; }');
        expect(document.adoptedStyleSheets.length).toBe(before + 1);
        const sheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];
        expect(sheet?.cssRules[0]?.cssText).toContain(`.${ s.inject }`);

        // Re-evaluating identical CSS does not adopt a second sheet.
        css('.inject { padding: 1px; }');
        expect(document.adoptedStyleSheets.length).toBe(before + 1);
    });

    it('never creates an inline <style> element, which a strict CSP would silently refuse', () =>
    {
        // The regression this pins: an injected <style> is blocked by any policy without
        // `style-src 'unsafe-inline'`, and a blocked element still sits in the DOM carrying the
        // right rule text while painting nothing - so only a computed style reveals the failure.
        // A constructable sheet is CSSOM and outside CSP entirely.
        css('.csp-safe { color: rebeccapurple; }');
        expect(document.head.querySelectorAll('style[data-azeroth-css]').length).toBe(0);
    });

    it('leaves non-class selectors (element/id) unscoped', () =>
    {
        css('div { margin: 0; } #main { color: red; }');
        const sheet = collectStyleSheet();
        expect(sheet).toContain('div { margin: 0; }');
        expect(sheet).toContain('#main { color: red; }');
    });

    it('does not rewrite dotted tokens inside url() bodies (asset paths stay intact)', () =>
    {
        css('.logo { background: url(./logo.png); }');
        css('.font { src: url("/fonts/Inter.woff2"); }');
        const sheet = collectStyleSheet();
        // The class selector IS scoped, but the asset path is copied verbatim - a suffix
        // here (`logo.png_<scope>`) would 404 the asset while the class still worked.
        expect(sheet).toContain('url(./logo.png)');
        expect(sheet).toContain('url("/fonts/Inter.woff2")');
        expect(sheet).not.toMatch(/logo\.png_/);
        expect(sheet).not.toMatch(/Inter\.woff2_/);
    });

    it('does not rewrite a dotted token inside a quoted string value', () =>
    {
        const s = css('.done::after { content: ".done"; }');
        const sheet = collectStyleSheet();
        // The selector is scoped; the string literal is not.
        expect(sheet).toContain(`.${ s.done }`);
        expect(sheet).toContain('content: ".done";');
        expect(sheet).not.toMatch(/"\.done_/);
    });

    it('still scopes a class selector that sits next to a url()', () =>
    {
        const s = css('.hero { background: url(./bg.jpg) no-repeat; }');
        expect(s.hero).toMatch(/^hero_[0-9a-z]+$/);
        expect(collectStyleSheet()).toContain(`.${ s.hero }`);
    });
});

describe('collectStyleSheet / resetStyleSheet', () =>
{
    beforeEach(() =>
    {
        resetStyleSheet();
        document.adoptedStyleSheets = [];
    });

    it('returns an empty string when nothing is registered', () =>
    {
        expect(collectStyleSheet()).toBe('');
    });

    it('concatenates all registered scopes with newlines', () =>
    {
        const a = css('.one { color: red; }');
        const b = css('.two { color: blue; }');
        const sheet = collectStyleSheet();
        expect(sheet.split('\n').length).toBe(2);
        expect(sheet).toContain(`.${ a.one }`);
        expect(sheet).toContain(`.${ b.two }`);
    });

    it('clears the registry on reset', () =>
    {
        css('.gone { color: red; }');
        expect(collectStyleSheet()).not.toBe('');
        resetStyleSheet();
        expect(collectStyleSheet()).toBe('');
    });
});

describe('collectStyleSheet cannot close the style element it is embedded in', () =>
{
    it('an interpolated value carrying </style> is neutralised, losslessly for CSS', () =>
    {
        // css() is a tagged template, so an interpolated per-tenant value is the invited use.
        css('.brand::after { content: "</style><script>globalThis.__CSSPWNED__=1</script>"; }');
        const sheet = collectStyleSheet();

        expect(sheet).not.toMatch(/<\/style/i);
        // `\3c` inside a CSS string is still `<`, so the declaration keeps its meaning.
        expect(sheet).toContain('\\3c/style>');
    });
});

describe('resetStyleSheet and the adopted-sheet registry stay in step', () =>
{
    // Found by an adversarial audit of the constructable-stylesheet change: `css()` deduped
    // through TWO independent tables - css.ts's `injectedScopes` and adopt-style.ts's own map -
    // and `resetStyleSheet()` cleared only the first. So a reset followed by the same `css()`
    // adopted NOTHING: the id was still remembered, the rules were silently gone, and a test or
    // a per-request module re-import lost its styles with no error.
    it('the same css() adopts again after a reset', () =>
    {
        document.adoptedStyleSheets = [];
        resetStyleSheet();
        css('.reset-probe { color: rgb(5, 5, 5); }');
        expect(document.adoptedStyleSheets.length).toBe(1);

        resetStyleSheet();
        css('.reset-probe { color: rgb(5, 5, 5); }');
        expect(document.adoptedStyleSheets.length).toBe(1);
    });

    it('a reset removes only the framework sheets, never one the app adopted', () =>
    {
        document.adoptedStyleSheets = [];
        const appSheet = new CSSStyleSheet();
        appSheet.replaceSync('.app-owned { color: rgb(6, 6, 6); }');
        document.adoptedStyleSheets = [appSheet];

        css('.framework-owned { color: rgb(7, 7, 7); }');
        expect(document.adoptedStyleSheets.length).toBe(2);

        resetStyleSheet();
        // The app's sheet survives; only the framework's is gone.
        expect(document.adoptedStyleSheets).toEqual([appSheet]);
    });
});
