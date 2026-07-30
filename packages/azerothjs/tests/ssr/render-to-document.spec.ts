// @vitest-environment node
//
// Real-execution coverage for renderToDocument (render-to-document.ts) and the re-exported CSS
// flush helpers. Runs in the `node` environment so document is undefined: the document shell is
// assembled as a pure string with no DOM, and css() records into its registry (which IS the
// stylesheet on the server) rather than injecting a <style> element.
//
// css() / collectStyleSheet() share a process-global registry, so each test resets it for
// isolation. css comes from azerothjs (the source of truth); collectStyleSheet and
// resetStyleSheet are imported from azerothjs to verify they are genuinely re-exported.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToDocument, collectStyleSheet, resetStyleSheet, h, css, createSignal } from 'azerothjs';

beforeEach(() =>
{
    resetStyleSheet();
});

afterEach(() =>
{
    resetStyleSheet();
});

describe('renderToDocument - document shell', () =>
{
    it('wraps the body in a full doctype/html/head/body shell with default lang', () =>
    {
        expect(renderToDocument(() => h('main', {}, 'Hello')))
            .toBe('<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main>Hello</main></body></html>');
    });

    it('emits an escaped <title> when title is provided', () =>
    {
        const html = renderToDocument(() => h('main', {}, 'x'), { title: 'Home & Away <ok>' });
        expect(html).toContain('<title>Home &amp; Away &lt;ok&gt;</title>');
    });

    it('omits <title> entirely when no title option is given', () =>
    {
        expect(renderToDocument(() => h('main', {}, 'x'))).not.toContain('<title>');
    });

    it('honours a custom lang and escapes it', () =>
    {
        expect(renderToDocument(() => h('main', {}, 'x'), { lang: 'fr' }))
            .toContain('<html lang="fr">');
        expect(renderToDocument(() => h('main', {}, 'x'), { lang: '"><x' }))
            .toContain('<html lang="&quot;&gt;&lt;x">');
    });

    it('keeps the body hydration-ready (markers on) by default', () =>
    {
        const [v] = createSignal('live');
        const html = renderToDocument(() => h('p', {}, () => v()));
        expect(html).toContain('<body><p><!--[-->live<!--]--></p></body>');
    });

    it('static: true renders a marker-free body', () =>
    {
        const [v] = createSignal('live');
        const html = renderToDocument(() => h('p', {}, () => v()), { static: true });
        expect(html).toContain('<body><p>live</p></body>');
        expect(html).not.toContain('<!--[-->');
    });
});

describe('renderToDocument - raw escape hatches (head / bodyAttrs)', () =>
{
    it('inserts head RAW (NOT escaped) - it is a deliberate escape hatch', () =>
    {
        const head = '<meta name="viewport" content="width=device-width">';
        const html = renderToDocument(() => h('main', {}, 'x'), { head });
        expect(html).toContain(head);
        // The raw markup is appended after the charset meta, inside <head>.
        expect(html).toContain(`<meta charset="utf-8">${ head }</head>`);
    });

    it('inserts bodyAttrs RAW onto the <body> tag', () =>
    {
        const html = renderToDocument(() => h('main', {}, 'x'), { bodyAttrs: 'class="dark" data-theme="night"' });
        expect(html).toContain('<body class="dark" data-theme="night">');
    });

    it('emits a bare <body> when no bodyAttrs are supplied', () =>
    {
        expect(renderToDocument(() => h('main', {}, 'x'))).toContain('<body><main>');
    });

    it('orders head pieces: charset, then title, then styles, then extra head', () =>
    {
        const styles = css`.zz { color: teal; }`;
        const html = renderToDocument(() => h('main', { class: styles.zz }, 'x'), {
            title: 'T',
            head: '<link rel="icon" href="/f.ico">'
        });
        const charsetIdx = html.indexOf('<meta charset="utf-8">');
        const titleIdx = html.indexOf('<title>');
        const styleIdx = html.indexOf('<style data-azeroth-css>');
        const linkIdx = html.indexOf('<link rel="icon"');
        expect(charsetIdx).toBeGreaterThanOrEqual(0);
        expect(charsetIdx).toBeLessThan(titleIdx);
        expect(titleIdx).toBeLessThan(styleIdx);
        expect(styleIdx).toBeLessThan(linkIdx);
    });
});

describe('renderToDocument - scoped CSS collection during SSR', () =>
{
    it('flushes CSS that css() registered DURING the render into a <head> <style>', () =>
    {
        // The scope is a content hash, so the rewritten selector is deterministic.
        const styles = css`.card { color: red; }`;
        const html = renderToDocument(() => h('div', { class: styles.card }, 'hi'));

        // css rewrites `.card` to `.card_<scope>`; the same scoped name lands in the class attr.
        expect(html).toMatch(/<style data-azeroth-css>\.card_[\da-z]+ \{ color: red; \}<\/style>/);
        const scopedClass = styles.card;
        expect(html).toContain(`<div class="${ scopedClass }">hi</div>`);
    });

    it('emits NO <style> when no css() ran during the render', () =>
    {
        expect(renderToDocument(() => h('main', {}, 'no styles'))).not.toContain('<style');
    });

    it('collects CSS registered before the call too (registry is the server stylesheet)', () =>
    {
        void css`.early { display: flex; }`;
        const html = renderToDocument(() => h('main', {}, 'x'));
        expect(html).toMatch(/<style data-azeroth-css>\.early_[\da-z]+ \{ display: flex; \}<\/style>/);
    });

    it('dedupes identical rule text to one scoped stylesheet', () =>
    {
        void css`.dup { margin: 0; }`;
        void css`.dup { margin: 0; }`;
        const sheet = collectStyleSheet();
        expect(sheet.match(/\.dup_/g)).toHaveLength(1);
    });

    it('resetStyleSheet clears the registry so a later collect is empty', () =>
    {
        void css`.gone { opacity: 1; }`;
        expect(collectStyleSheet()).not.toBe('');
        resetStyleSheet();
        expect(collectStyleSheet()).toBe('');
    });

    it('does NOT leak one render\'s per-render CSS into a later render\'s document', () =>
    {
        // css() interpolating request-specific data DURING a render must belong to that
        // render alone. A process-global registry served request A's rule (an IBAN, here a
        // marker) to every later request and grew without bound; the render frame confines it.
        const docA = renderToDocument(() => h('div', { class: css`.acct { --iban: "${ 'SECRET-A' }"; }`.acct }, 'A'));
        const docB = renderToDocument(() => h('div', { class: css`.acct { --iban: "${ 'SECRET-B' }"; }`.acct }, 'B'));

        expect(docA).toContain('SECRET-A');
        expect(docB).toContain('SECRET-B');
        // The crux: request B's document carries none of request A's per-render CSS.
        expect(docB).not.toContain('SECRET-A');
    });

    it('a render with no css() emits no <style> even after an earlier render used one', () =>
    {
        renderToDocument(() => h('div', { class: css`.leak { color: "${ 'ONCE' }"; }`.leak }, 'x'));
        const clean = renderToDocument(() => h('main', {}, 'no styles here'));
        expect(clean).not.toContain('ONCE');
        expect(clean).not.toContain('<style');
    });
});
