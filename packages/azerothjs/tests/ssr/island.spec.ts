// Real-execution coverage for island() (island.ts), all three render modes.
//
// Default (happy-dom) environment: the string-mode tests drive island via renderToString /
// runInMode('string') (no DOM needed for those), while the dom-mode transparency test builds
// real elements and the hydrate-mode test exercises the guard via runInMode('hydrate'). One
// file covers the whole mode-dispatch surface.
//
// No mocks: real render-mode stack, real string emitter, real h().
import { describe, it, expect } from 'vitest';
import { island, renderToString, renderToStaticMarkup, h, createSignal, runInMode } from 'azerothjs';

interface CounterProps extends Record<string, unknown>
{
    start: number;
}

const Counter = (props: CounterProps): HTMLElement => h('button', {}, `count:${ props.start }`);

describe('island - SSR (string mode) anchor attributes', () =>
{
    it('rides the anchor attributes on the component\'s OWN root - no wrapper element', () =>
    {
        const html = renderToString(() =>
            island('/islands/counter.azeroth', Counter, { start: 5 }));

        expect(html).toBe(
            '<button data-azeroth-island="/islands/counter.azeroth"' +
            ' data-azeroth-props="{&quot;start&quot;:5}">count:5</button>'
        );
    });

    it('an island rendering a <tr> is a DIRECT, valid child of <tbody> (no-wrapper doctrine)', () =>
    {
        // The old span wrapper was invalid table content and got hoisted by the parser;
        // with root-riding attributes the island root IS the row.
        const Row = (props: CounterProps): HTMLElement => h('tr', {}, h('td', {}, `r${ props.start }`));
        const html = renderToString(() => h('table', {}, h('tbody', {},
            island('/islands/row', Row, { start: 1 }))));
        expect(html).toContain('<tbody><tr data-azeroth-island="/islands/row"');
        expect(html).not.toContain('<span');
    });

    it('throws a descriptive error when the island component does not render an element root', () =>
    {
        const Texty = (() => 'just text') as unknown as (props: CounterProps) => HTMLElement;
        expect(() => renderToString(() => island('/islands/texty', Texty, { start: 0 })))
            .toThrow(/single ELEMENT root/);
    });

    it('escapes the src and the serialized props into their attributes (no breakout)', () =>
    {
        const html = renderToString(() =>
            island('/x" onload="evil', Counter, { label: '"><script>' } as unknown as CounterProps));

        // The src double-quote is escaped, so it cannot terminate the attribute early.
        expect(html).toContain('data-azeroth-island="/x&quot; onload=&quot;evil"');
        // The props JSON is attribute-escaped: JSON.stringify backslash-escapes the inner ",
        // then escapeAttr turns every " into &quot; and < into &lt;, so no real quote survives
        // to terminate the attribute and no '<' can open a tag.
        expect(html).toContain('data-azeroth-props="{&quot;label&quot;:&quot;\\&quot;&gt;&lt;script&gt;&quot;}"');
        // No raw unescaped double-quote-then-> sequence leaks before the inner button.
        expect(html.indexOf('<script>')).toBe(-1);
    });

    it('serializes the island body with the active markers (hole anchors inside)', () =>
    {
        const Live = (props: CounterProps): HTMLElement => h('span', {}, () => `n=${ props.start }`);
        const html = renderToString(() => island('/live', Live, { start: 1 }));
        // The root span carries the island attributes; the hole anchors serialize inside it.
        expect(html).toMatch(/<span data-azeroth-island="\/live"[^>]*><!--\[-->n=1<!--\]--><\/span>/);
    });

    it('renderToStaticMarkup still emits the island anchor (the boundary, not hydration markers)', () =>
    {
        // island() always emits its anchor wrapper in string mode - that anchor is how
        // hydrateIslands() finds the boundary; it is not a hydration co-range marker. The
        // INNER body, however, is serialized marker-free.
        const Live = (props: CounterProps): HTMLElement => h('span', {}, () => `n=${ props.start }`);
        const html = renderToStaticMarkup(() => island('/live', Live, { start: 2 }));
        expect(html).toContain('data-azeroth-island="/live"');
        expect(html).toMatch(/<span data-azeroth-island="\/live"[^>]*>n=2<\/span>/);
        expect(html).not.toContain('<!--[-->');
    });
});

describe('island - JSON prop boundary contract', () =>
{
    it('rejects a function prop with a descriptive error', () =>
    {
        expect(() => runInMode('string', () =>
            island('/bad', Counter, { onClick: () => undefined } as unknown as CounterProps)))
            .toThrow(/prop "onClick" is a function and cannot cross the island boundary/);
    });

    it('rejects a signal getter passed as a prop (it is a function)', () =>
    {
        const [count] = createSignal(0);
        expect(() => runInMode('string', () =>
            island('/bad', Counter, { count } as unknown as CounterProps)))
            .toThrow(/cannot cross the island boundary/);
    });

    it('rejects a bigint prop', () =>
    {
        expect(() => runInMode('string', () =>
            island('/bad', Counter, { big: 10n } as unknown as CounterProps)))
            .toThrow(/prop "big" is a bigint/);
    });

    it('rejects a symbol prop', () =>
    {
        expect(() => runInMode('string', () =>
            island('/bad', Counter, { sym: Symbol('x') } as unknown as CounterProps)))
            .toThrow(/prop "sym" is a symbol/);
    });

    it('accepts plain JSON data (nested objects, arrays, null)', () =>
    {
        const html = runInMode('string', () =>
        {
            const node = island('/ok', Counter, { items: [1, 2], meta: { ok: true }, none: null } as unknown as CounterProps);
            return (node as unknown as { html: string }).html;
        });
        expect(html).toContain('data-azeroth-props="{&quot;items&quot;:[1,2],&quot;meta&quot;:{&quot;ok&quot;:true},&quot;none&quot;:null}"');
    });
});

describe('island - dom mode (transparent)', () =>
{
    it('renders the component inline with no island wrapper in a pure client render', () =>
    {
        // Default mode is 'dom'. The island boundary is transparent: it returns the component's
        // real element so one page component works in both SSR and pure-CSR dev.
        const el = island('/islands/counter.azeroth', Counter, { start: 9 });
        expect(el).toBeInstanceOf(HTMLElement);
        expect(el.tagName.toLowerCase()).toBe('button');
        expect(el.textContent).toBe('count:9');
        // No island anchor span is created in dom mode.
        expect(el.getAttribute('data-azeroth-island')).toBeNull();
    });
});

describe('island - hydrate mode (guarded)', () =>
{
    it('throws in hydrate mode: the shell is not hydrated, use hydrateIslands()', () =>
    {
        expect(() => runInMode('hydrate', () =>
            island('/islands/counter.azeroth', Counter, { start: 1 })))
            .toThrow(/reached hydrate\(\)/);
    });
});
