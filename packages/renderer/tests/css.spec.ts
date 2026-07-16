// @vitest-environment happy-dom
//
// Behavioral coverage for css/collectStyleSheet/resetStyleSheet (css.ts): scope
// hashing, selector rewriting, the scoped-class proxy, deterministic hashing,
// dedup, <style> injection into <head>, and registry collection/reset.
import { describe, it, expect, beforeEach } from 'vitest';
import { css, collectStyleSheet, resetStyleSheet } from '@azerothjs/renderer';

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
