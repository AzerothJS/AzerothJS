import { describe, it, expect, beforeEach } from 'vitest';
import { css, h, collectStyleSheet, resetStyleSheet } from '@azerothjs/core';

describe('css()', () =>
{
    beforeEach(() =>
    {
        document.head.querySelectorAll('[data-azeroth-css]').forEach(n => n.remove());
    });

    it('returns scoped class names and injects a stylesheet', () =>
    {
        const s = css`.card { padding: 1rem; }`;

        // Scoped: base name plus a hash suffix.
        expect(s.card).toMatch(/^card_[a-z0-9]+$/);

        const styleEl = document.head.querySelector('[data-azeroth-css]');
        expect(styleEl).not.toBeNull();
        expect(styleEl!.textContent).toContain(`.${ s.card } {`);
    });

    it('scopes every class consistently within one block', () =>
    {
        const s = css`
            .a { color: red; }
            .b { color: blue; }
            .a:hover { color: pink; }
        `;
        expect(s.a).toMatch(/^a_/);
        expect(s.b).toMatch(/^b_/);
        // Same suffix across both classes (one scope per block).
        expect(s.a.split('_')[1]).toBe(s.b.split('_')[1]);
    });

    it('gives different scopes to different CSS, same scope to identical CSS', () =>
    {
        const a = css`.x { color: red; }`;
        const b = css`.x { color: blue; }`;
        const c = css`.x { color: red; }`;

        expect(a.x).not.toBe(b.x);   // different rules -> different scope
        expect(a.x).toBe(c.x);       // identical rules -> shared scope
    });

    it('injects each unique scope exactly once', () =>
    {
        const a = css`.dup { color: red; }`;
        const b = css`.dup { color: red; }`;
        const c = css`.dup { color: red; }`;
        expect(a.dup).toBe(b.dup);
        expect(b.dup).toBe(c.dup);

        const tags = document.head.querySelectorAll('[data-azeroth-css]');
        expect(tags.length).toBe(1);
    });

    it('returns the key unchanged for unknown class names', () =>
    {
        const s = css`.known { color: red; }`;
        expect(s.unknown).toBe('unknown');
    });

    it('plugs straight into h()', () =>
    {
        const s = css`.box { padding: 8px; }`;
        const el = h('div', { class: s.box }, 'hi');
        expect(el.className).toBe(s.box);
        expect(el.className).toMatch(/^box_/);
    });
});

describe('collectStyleSheet() / resetStyleSheet() - SSR collection', () =>
{
    beforeEach(() =>
    {
        resetStyleSheet();
        document.head.querySelectorAll('[data-azeroth-css]').forEach(n => n.remove());
    });

    it('collects every scope as one flushable CSS string', () =>
    {
        const a = css`.alpha { color: red; }`;
        const b = css`.beta { color: blue; }`;

        const sheet = collectStyleSheet();
        expect(sheet).toContain(`.${ a.alpha } {`);
        expect(sheet).toContain(`.${ b.beta } {`);
    });

    it('records identical CSS only once', () =>
    {
        const first = css`.same { color: red; }`;
        const second = css`.same { color: red; }`;
        expect(first.same).toBe(second.same);

        const sheet = collectStyleSheet();
        // One occurrence of the rule (deduped by scope).
        expect(sheet.match(/color: red;/g)?.length).toBe(1);
    });

    it('resetStyleSheet() empties the registry', () =>
    {
        const s = css`.gone { color: red; }`;
        expect(collectStyleSheet()).toContain(s.gone);
        resetStyleSheet();
        expect(collectStyleSheet()).toBe('');
    });
});
