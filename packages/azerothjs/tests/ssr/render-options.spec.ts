// @vitest-environment happy-dom
//
// One SSR entry point, one option. This used to be two exports - `renderToString` and
// `renderToStaticMarkup` - which were the same private function called with `true` and `false`.
// Two names for one boolean is a choice a reader can make wrongly in both directions: shipping
// marker-laden HTML into an email, or marker-free HTML into a page that then fails to hydrate.
import { describe, expect, it } from 'vitest';
import { createSignal, h, renderToString } from 'azerothjs';

/** A REACTIVE hole: markers exist to mark these, so a static tree cannot tell the modes apart. */
function Page(): HTMLElement
{
    const [name] = createSignal('hello');
    return h('div', { class: 'page' }, h('p', null, () => name()));
}

describe('renderToString', () =>
{
    it('emits hydration markers by default', () =>
    {
        const html = renderToString(() => Page());
        expect(html).toContain('hello');
        // The anchors hydrate() adopts around a reactive hole. Their spelling is internal; their
        // PRESENCE is the contract.
        expect(html).toMatch(/<!--/);
    });

    it('emits clean HTML when markers are switched off', () =>
    {
        const html = renderToString(() => Page(), { markers: false });
        expect(html).toContain('hello');
        expect(html).not.toMatch(/<!--/);
    });

    it('an explicit `markers: true` matches the default', () =>
    {
        expect(renderToString(() => Page(), { markers: true })).toBe(renderToString(() => Page()));
    });

    it('still refuses an already-built tree, naming the thunk requirement', () =>
    {
        // The ordering constraint survives the merge: the tree must build INSIDE string mode.
        expect(() => renderToString(Page() as unknown as () => HTMLElement, { markers: false }))
            .toThrow(/THUNK/);
    });
});
