// @vitest-environment node
//
// Full behavioral coverage for the SSR string-emission helpers (ssr.ts): escaping,
// SSRNode branding, child serialization (incl. reactive-hole resolution and the
// getter-chain collapse), marker toggling, and co-range anchoring.
import { describe, it, expect, afterEach } from 'vitest';
import {
    ssr,
    isSSRNode,
    escapeText,
    escapeAttr,
    serializeChild,
    setSSRMarkers,
    getSSRMarkers,
    wrapContentsAnchored
} from '@azerothjs/reactivity';

// Marker state is module-global; restore it after each test for isolation.
const initialMarkers = getSSRMarkers();
afterEach(() =>
{
    setSSRMarkers(initialMarkers);
});

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

    it('resolves a function hole without subscribing (markers off => no anchors)', () =>
    {
        setSSRMarkers(false);
        expect(serializeChild(() => 'live')).toBe('live');
    });

    it('collapses a getter-returning-a-getter to its concrete value', () =>
    {
        setSSRMarkers(false);
        const inner = (): string => 'deep';
        expect(serializeChild(() => inner)).toBe('deep');
    });

    it('wraps a function hole in a single reactive-hole anchor pair when markers are on', () =>
    {
        setSSRMarkers(true);
        expect(serializeChild(() => 'v')).toBe('<!--[-->v<!--]-->');
    });

    it('escapes the resolved hole value as text', () =>
    {
        setSSRMarkers(false);
        expect(serializeChild(() => '<script>')).toBe('&lt;script&gt;');
    });
});

describe('setSSRMarkers / getSSRMarkers', () =>
{
    it('toggles the global marker flag', () =>
    {
        setSSRMarkers(true);
        expect(getSSRMarkers()).toBe(true);
        setSSRMarkers(false);
        expect(getSSRMarkers()).toBe(false);
    });
});

describe('wrapContentsAnchored', () =>
{
    it('wraps inner in balanced co-range comment anchors when markers are on', () =>
    {
        setSSRMarkers(true);
        const node = wrapContentsAnchored('for', '<li>a</li>');
        expect(isSSRNode(node)).toBe(true);
        expect(node.html).toBe('<!--azc:for--><li>a</li><!--/azc-->');
    });

    it('returns the inner verbatim (as an SSRNode) when markers are off', () =>
    {
        setSSRMarkers(false);
        const node = wrapContentsAnchored('for', '<li>a</li>');
        expect(isSSRNode(node)).toBe(true);
        expect(node.html).toBe('<li>a</li>');
    });
});
