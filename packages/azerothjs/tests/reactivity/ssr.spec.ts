// @vitest-environment node
//
// Full behavioral coverage for the SSR string-emission helpers (ssr.ts): escaping,
// SSRNode branding, child serialization (incl. reactive-hole resolution and the
// getter-chain collapse), and co-range anchoring. Hydration markers are RENDER-SCOPED
// state riding the runInMode window (`runInMode('string', fn, { markers: true })`) -
// there is no marker global to set, leak, or restore.
import { describe, it, expect } from 'vitest';
import { ssr, isSSRNode, escapeText, escapeAttr, runInMode } from 'azerothjs';
import type { SSRNode } from 'azerothjs';
import { serializeChild, wrapContentsAnchored } from 'azerothjs/internal';

/** Runs `fn` in a string-mode window with markers on - the renderToString shape. */
function withMarkers<T>(fn: () => T): T
{
    return runInMode('string', fn, { markers: true });
}

describe('escapeText', () =>
{
    it('escapes &, <, > for text context', () =>
    {
        expect(escapeText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    });

    it('leaves double quotes untouched (text context, not attributes)', () =>
    {
        expect(escapeText('say "hi"')).toBe('say "hi"');
    });
});

describe('escapeAttr', () =>
{
    it('escapes &, ", <, > for a quoted attribute value', () =>
    {
        expect(escapeAttr('x" onload="evil')).toBe('x&quot; onload=&quot;evil');
        expect(escapeAttr('a & <b>')).toBe('a &amp; &lt;b&gt;');
    });
});

describe('ssr / isSSRNode', () =>
{
    it('brands finished html as an SSRNode that isSSRNode recognizes', () =>
    {
        const node = ssr('<b>x</b>');
        expect(isSSRNode(node)).toBe(true);
        expect(node.html).toBe('<b>x</b>');
    });

    it('rejects raw strings and other values', () =>
    {
        expect(isSSRNode('<b>x</b>')).toBe(false);
        expect(isSSRNode(null)).toBe(false);
        expect(isSSRNode({})).toBe(false);
    });

    it('trusts only the node ssr() made: data, copies and wrappers are not finished markup', () =>
    {
        const node = ssr('<b>x</b>');
        const lookalikes: Record<string, unknown> = {
            json: JSON.parse('{"__ssr":true,"html":"<img src=x onerror=alert(1)>"}'),
            roundTrip: JSON.parse(JSON.stringify(node)),
            // eslint-disable-next-line @typescript-eslint/no-misused-spread -- a spread copy is the case under test
            spread: { ...node },
            assign: Object.assign({}, node),
            clone: structuredClone(node),
            proxy: new Proxy(node, {}),
            derived: Object.create(node),
            reproto: Object.setPrototypeOf({ html: '<i>y</i>' }, Object.getPrototypeOf(node) as object)
        };
        expect(Object.keys(lookalikes).filter((key) => isSSRNode(lookalikes[key]))).toEqual([]);
        expect(isSSRNode(Object.freeze(ssr('<b>f</b>')))).toBe(true);
    });

    it('is not fooled by Object.prototype.__ssr', () =>
    {
        const proto = Object.prototype as Record<string, unknown>;
        proto.__ssr = true;
        try
        {
            expect(isSSRNode({ html: '<b>x</b>' })).toBe(false);
            expect(serializeChild({ html: '<b>x</b>' })).toBe('[object Object]');
        }
        finally
        {
            delete proto.__ssr;
        }
    });

    it('only the private brand makes an SSRNode, which has no __ssr member', () =>
    {
        const members: Pick<SSRNode, keyof SSRNode> = ssr('x');
        // @ts-expect-error the public members without the private brand are not an SSRNode
        const picked: SSRNode = members;
        // @ts-expect-error a literal is not finished markup
        const literal: SSRNode = { __ssr: true, html: 'x' };
        // @ts-expect-error SSRNode has no __ssr member
        const member: unknown = ssr('x').__ssr;
        expect([isSSRNode(picked), isSSRNode(literal), member]).toEqual([true, false, undefined]);
    });

    it('serializes as plain data', () =>
    {
        expect(JSON.stringify(ssr('<b>x</b>'))).toBe('{"html":"<b>x</b>"}');
    });
});

describe('serializeChild', () =>
{
    it('escapes primitive text and stringifies numbers', () =>
    {
        expect(serializeChild('a < b')).toBe('a &lt; b');
        expect(serializeChild(42)).toBe('42');
    });

    it('emits SSRNode html verbatim (already escaped)', () =>
    {
        expect(serializeChild(ssr('<b>x</b>'))).toBe('<b>x</b>');
    });

    it('skips null, undefined, and false', () =>
    {
        expect(serializeChild(null)).toBe('');
        expect(serializeChild(undefined)).toBe('');
        expect(serializeChild(false)).toBe('');
    });

    it('concatenates arrays of mixed children', () =>
    {
        expect(serializeChild(['a', ssr('<i>b</i>'), 1])).toBe('a<i>b</i>1');
    });

    it('resolves a function hole without subscribing (no marker window => no anchors)', () =>
    {
        expect(serializeChild(() => 'live')).toBe('live');
    });

    it('collapses a getter-returning-a-getter to its concrete value', () =>
    {
        const inner = (): string => 'deep';
        expect(serializeChild(() => inner)).toBe('deep');
    });

    it('wraps a function hole in a single reactive-hole anchor pair inside a markers window', () =>
    {
        expect(withMarkers(() => serializeChild(() => 'v'))).toBe('<!--[-->v<!--]-->');
    });

    it('escapes the resolved hole value as text', () =>
    {
        expect(serializeChild(() => '<script>')).toBe('&lt;script&gt;');
    });

    it('escapes an object carrying __ssr instead of writing its html', () =>
    {
        const forged: unknown = JSON.parse('{"__ssr":true,"html":"<img src=x onerror=alert(1)>"}');
        expect(serializeChild(forged)).toBe('[object Object]');
        expect(serializeChild([forged])).toBe('[object Object]');
        expect(serializeChild(() => forged)).toBe('[object Object]');
    });
});

describe('markers ride the runInMode window', () =>
{
    it('markers are scoped: on inside the window, off outside - even after a throw', () =>
    {
        expect(withMarkers(() => serializeChild(() => 'x'))).toBe('<!--[-->x<!--]-->');
        expect(serializeChild(() => 'x')).toBe('x'); // the window closed with its state

        expect(() => withMarkers(() =>
        {
            throw new Error('render exploded');
        })).toThrow('render exploded');
        expect(serializeChild(() => 'x')).toBe('x'); // a throw cannot leak marker state
    });

    it('a nested mode switch inherits the render\'s marker choice', () =>
    {
        const html = withMarkers(() => runInMode('string', () => serializeChild(() => 'n')));
        expect(html).toBe('<!--[-->n<!--]-->'); // inner window inherited markers: true
    });

    it('a nested window can opt out explicitly (the renderToStaticMarkup shape)', () =>
    {
        const html = withMarkers(() =>
            runInMode('string', () => serializeChild(() => 'n'), { markers: false }));
        expect(html).toBe('n');
    });
});

describe('wrapContentsAnchored', () =>
{
    it('wraps inner in balanced co-range comment anchors inside a markers window', () =>
    {
        const node = withMarkers(() => wrapContentsAnchored('for', '<li>a</li>'));
        expect(isSSRNode(node)).toBe(true);
        expect(node.html).toBe('<!--azc:for--><li>a</li><!--/azc-->');
    });

    it('returns the inner verbatim (as an SSRNode) outside any markers window', () =>
    {
        const node = wrapContentsAnchored('for', '<li>a</li>');
        expect(isSSRNode(node)).toBe(true);
        expect(node.html).toBe('<li>a</li>');
    });
});
