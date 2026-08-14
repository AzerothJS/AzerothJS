// @vitest-environment node
//
// `registerStyle` is the compiled `style { }` section's registration call, and the one thing
// that separates it from `css` is where the scope lands: ALWAYS the app-static registry, never
// the per-render frame.
//
// That is not a preference. A component module reached by a dynamic import - a lazy route - is
// evaluated DURING a request, so a render-scoped registration would be drained with that
// response and never run again, because the module is only evaluated once. Every LATER request
// would then serve the scoped class names with none of the rules: correct-looking markup that
// paints unstyled, with nothing in the HTML to reveal it.
//
// A section cannot interpolate a per-request value - its text is a compile-time literal - so
// there is nothing for the frame to isolate, and the leak the frame exists to prevent cannot
// arise here.
import { describe, expect, it, beforeEach } from 'vitest';

import { collectStyleSheet, css, h, renderToString, resetStyleSheet } from '../../src/index.ts';
import { registerStyle } from '../../src/internal.ts';

describe('registerStyle', () =>
{
    beforeEach(() =>
    {
        resetStyleSheet();
    });

    it('scopes class selectors exactly as css`` does', () =>
    {
        // Two front doors, one algorithm. If these ever disagreed, a section's markup would
        // name a class its own stylesheet does not define.
        const rules = '.shared { color: rgb(4, 5, 6); }';
        const viaTemplate = css(rules).shared;
        resetStyleSheet();
        registerStyle(rules);

        expect(collectStyleSheet()).toContain(`.${ viaTemplate } {`);
    });

    it('leaves element, id and attribute selectors global', () =>
    {
        registerStyle('div { margin: 0 } #main { padding: 0 } [hidden] { display: none }');
        const sheet = collectStyleSheet();

        expect(sheet).toContain('div { margin: 0 }');
        expect(sheet).toContain('#main { padding: 0 }');
        expect(sheet).toContain('[hidden] { display: none }');
    });

    it('registered DURING a render, it still reaches the NEXT render', () =>
    {
        // The lazy-route shape: the module is evaluated inside request 1's render, and request 2
        // reuses the cached module, so the call never runs again.
        let registered = false;
        const html = renderToString(() =>
        {
            if (!registered)
            {
                registered = true;
                registerStyle('.lazy { color: rgb(7, 7, 7); }');
            }
            return h('p', { class: 'lazy_x' }, 'first');
        }, { markers: false });
        expect(html).toContain('first');

        const first = collectStyleSheet();
        expect(first).toContain('rgb(7, 7, 7)');

        renderToString(() => h('p', {}, 'second'), { markers: false });
        const second = collectStyleSheet();

        expect(second, 'a second request must still get the section\'s rules').toContain('rgb(7, 7, 7)');
    });

    it('an interpolated css`` registered during a render still does NOT leak to the next', () =>
    {
        // The other half of the same rule: what makes registerStyle safe to keep app-static is
        // that it has no per-request input. `css` does, and its isolation is untouched.
        renderToString(() =>
        {
            const tenant = css('.brand { color: rgb(1, 1, 1); }');
            return h('p', { class: tenant.brand }, 'tenant A');
        }, { markers: false });
        expect(collectStyleSheet()).toContain('rgb(1, 1, 1)');

        renderToString(() => h('p', {}, 'tenant B'), { markers: false });

        expect(collectStyleSheet()).not.toContain('rgb(1, 1, 1)');
    });

    it('identical rule text registers one scope, however many modules declare it', () =>
    {
        registerStyle('.dupe { color: red }');
        registerStyle('.dupe { color: red }');

        expect(collectStyleSheet().match(/\.dupe_/g)).toHaveLength(1);
    });
});
