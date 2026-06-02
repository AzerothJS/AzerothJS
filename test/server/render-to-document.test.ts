// ============================================================================
// AZEROTHJS — renderToDocument tests
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { h, css, resetStyleSheet } from '@azerothjs/renderer';
import { renderToDocument } from '@azerothjs/server';

describe('renderToDocument', () =>
{
    beforeEach(() =>
    {
        resetStyleSheet();
    });

    it('wraps the body in a full HTML document', () =>
    {
        const html = renderToDocument(() => h('main', {}, 'Hello'));
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('<html lang="en">');
        expect(html).toContain('<meta charset="utf-8">');
        expect(html).toContain('<body><main>Hello</main></body>');
    });

    it('honors title, lang, head, and bodyAttrs (escaping where needed)', () =>
    {
        const html = renderToDocument(() => h('div', {}, 'x'), {
            title: 'A & B',
            lang: 'fr',
            head: '<meta name="viewport" content="width=device-width">',
            bodyAttrs: 'class="dark"'
        });
        expect(html).toContain('<html lang="fr">');
        expect(html).toContain('<title>A &amp; B</title>');
        expect(html).toContain('<meta name="viewport" content="width=device-width">');
        expect(html).toContain('<body class="dark">');
    });

    it('flushes scoped CSS collected during render into the head', () =>
    {
        const html = renderToDocument(() =>
        {
            const styles = css`
                .card { padding: 1rem; }
            `;
            return h('div', { class: styles.card }, 'c');
        });

        expect(html).toContain('<style data-azeroth-css>');
        expect(html).toMatch(/\.card_[a-z0-9]+ \{ padding: 1rem; \}/);
        // The element references the same scoped class name.
        expect(html).toMatch(/<div class="card_[a-z0-9]+">c<\/div>/);
    });

    it('renders marker-free body when static is true', () =>
    {
        const html = renderToDocument(() => h('span', {}, () => 'live'), { static: true });
        expect(html).toContain('<body><span>live</span></body>');
        expect(html).not.toContain('<!--[-->');
    });
});
