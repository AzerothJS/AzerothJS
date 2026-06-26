// @vitest-environment happy-dom
//
// Behavioral coverage for the hydration primitives (hydration.ts): the mismatch error,
// hydration-node branding, and the HydrationCursor's node-claiming walk over real DOM.
// The comment-anchor walk methods are exercised end-to-end by the server package's
// SSR -> hydrate tests; here we cover the element/text claiming and exhaustion checks.
import { describe, it, expect } from 'vitest';
import {
    HydrationCursor,
    HydrationMismatchError,
    isHydrationNode,
    hydrationNode
} from '@azerothjs/reactivity';

function container(html: string): HTMLElement
{
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
}

describe('HydrationMismatchError', () =>
{
    it('is an Error subclass with a stable name and message', () =>
    {
        const err = new HydrationMismatchError('nope');
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('HydrationMismatchError');
        expect(err.message).toContain('nope');
    });
});

describe('hydrationNode / isHydrationNode', () =>
{
    it('brands a descriptor recognized by isHydrationNode', () =>
    {
        const node = hydrationNode(() => undefined);
        expect(isHydrationNode(node)).toBe(true);
    });

    it('rejects plain objects, null, and real DOM nodes', () =>
    {
        expect(isHydrationNode({})).toBe(false);
        expect(isHydrationNode(null)).toBe(false);
        expect(isHydrationNode(document.createElement('div'))).toBe(false);
    });
});

describe('HydrationCursor', () =>
{
    it('claims elements and text nodes in document order', () =>
    {
        const cursor = new HydrationCursor(container('<span>a</span>between<b>c</b>'));
        expect(cursor.peekElement()?.tagName.toLowerCase()).toBe('span');
        expect(cursor.takeElement('span').textContent).toBe('a');
        expect(cursor.takeText().textContent).toBe('between');
        expect(cursor.takeElement('b').textContent).toBe('c');
        expect(cursor.peek()).toBeNull();
    });

    it('peek/peekElement do not advance the cursor', () =>
    {
        const cursor = new HydrationCursor(container('<i>x</i>'));
        const first = cursor.peek();
        expect(cursor.peek()).toBe(first);
        expect(cursor.peekElement()).toBe(first);
        cursor.takeElement('i');
        expect(cursor.peek()).toBeNull();
        expect(cursor.peekElement()).toBeNull();
    });

    it('throws HydrationMismatchError on an unexpected tag', () =>
    {
        const cursor = new HydrationCursor(container('<span></span>'));
        expect(() => cursor.takeElement('div')).toThrow(HydrationMismatchError);
    });

    it('throws HydrationMismatchError when expecting text but finding an element', () =>
    {
        const cursor = new HydrationCursor(container('<span></span>'));
        expect(() => cursor.takeText()).toThrow(HydrationMismatchError);
    });

    it('walks an explicit node list instead of the parent children when given one', () =>
    {
        const parent = container('<p></p>');
        const a = document.createElement('a');
        const b = document.createElement('b');
        const cursor = new HydrationCursor(parent, [a, b]);
        expect(cursor.takeElement('a')).toBe(a);
        expect(cursor.takeElement('b')).toBe(b);
    });

    it('assertExhausted passes when fully consumed and throws on leftover nodes', () =>
    {
        const consumed = new HydrationCursor(container('<span></span>'));
        consumed.takeElement('span');
        expect(() => consumed.assertExhausted('root')).not.toThrow();

        const leftover = new HydrationCursor(container('<span></span><span></span>'));
        leftover.takeElement('span');
        expect(() => leftover.assertExhausted('root')).toThrow();
    });
});
