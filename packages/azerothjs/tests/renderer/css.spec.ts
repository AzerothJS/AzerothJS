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
        // Isolate each test: clear the registry and remove injected <style> tags.
        resetStyleSheet();
        for (const style of Array.from(document.head.querySelectorAll('style[data-azeroth-css]')))
        {
            style.remove();
        }
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

    it('injects exactly one <style data-azeroth-css> per scope into <head>', () =>
    {
        const s = css('.inject { padding: 1px; }');
        const tags = document.head.querySelectorAll('style[data-azeroth-css]');
        expect(tags.length).toBe(1);
        const scope = s.inject?.split('_')[1];
        expect(tags[0]?.getAttribute('data-azeroth-css')).toBe(scope);
        expect(tags[0]?.textContent).toContain(`.${ s.inject }`);

        // Re-evaluating identical CSS does not inject a second tag.
        css('.inject { padding: 1px; }');
        expect(document.head.querySelectorAll('style[data-azeroth-css]').length).toBe(1);
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
        for (const style of Array.from(document.head.querySelectorAll('style[data-azeroth-css]')))
        {
            style.remove();
        }
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
