// @vitest-environment happy-dom
//
// Full behavioral coverage for the co-range helpers (co-range.ts): the comment-marker
// placement range every control-flow component (Show, Switch, Dynamic, ErrorBoundary, and
// the router's Routes) uses for its DOM output. These manage a marker-bounded range in an
// arbitrary parent: createCoMarkers builds the marker pair in a carrier fragment, appendToCo
// inserts content before the end marker, clearCo removes the range's content (running
// destroy hooks on each removed element), and adoptCoRange picks up an existing
// server-rendered marker range from a hydration cursor.
//
// setDestroyHooks (package-internal) attaches a node-bound hook so the clearCo->destroyComponent
// teardown path is observable; HydrationCursor is the real cursor adoptCoRange walks.
import { describe, it, expect } from 'vitest';
import {
    createCoMarkers,
    appendToCo,
    clearCo,
    adoptCoRange
} from '@azerothjs/component';
import { HydrationCursor } from '@azerothjs/reactivity';
import { setDestroyHooks } from '../src/destroy-hooks.ts';

describe('createCoMarkers', () =>
{
    it('produces a fragment holding a start/end comment pair', () =>
    {
        const { fragment, target } = createCoMarkers('show');

        expect(fragment).toBeInstanceOf(DocumentFragment);
        expect(fragment.childNodes.length).toBe(2);

        const [start, end] = Array.from(fragment.childNodes);
        expect(start.nodeType).toBe(Node.COMMENT_NODE);
        expect(end.nodeType).toBe(Node.COMMENT_NODE);
        // Marker text encodes the co kind: an opening and a closing comment.
        expect((start as Comment).data).toBe('show');
        expect((end as Comment).data).toBe('/show');

        // The target's markers ARE the fragment's two comment nodes.
        expect(target.start).toBe(start);
        expect(target.end).toBe(end);
    });

    it('exposes a live parent() that follows the markers as the fragment is appended', () =>
    {
        const { fragment, target } = createCoMarkers('switch');

        // Before append, the markers live inside the carrier fragment.
        expect(target.parent()).toBe(fragment);

        const container = document.createElement('div');
        container.appendChild(fragment);

        // Appending the fragment moves the markers into the real container; the
        // getter reads their CURRENT parent, so it now reports the container.
        expect(target.parent()).toBe(container);
        expect(target.start.parentNode).toBe(container);
        expect(target.end.parentNode).toBe(container);
    });
});

describe('appendToCo', () =>
{
    it('inserts content between the start and end markers', () =>
    {
        const { fragment, target } = createCoMarkers('show');
        const container = document.createElement('div');
        container.appendChild(fragment);

        const content = document.createElement('p');
        content.textContent = 'hello';
        appendToCo(target, content);

        // Order inside the container: start marker, content, end marker.
        const nodes = Array.from(container.childNodes);
        expect(nodes[0]).toBe(target.start);
        expect(nodes[1]).toBe(content);
        expect(nodes[2]).toBe(target.end);
    });

    it('appends successive nodes as the last item before the end marker, preserving order', () =>
    {
        const { fragment, target } = createCoMarkers('switch');
        const container = document.createElement('div');
        container.appendChild(fragment);

        const a = document.createElement('span');
        const b = document.createElement('span');
        appendToCo(target, a);
        appendToCo(target, b);

        const nodes = Array.from(container.childNodes);
        expect(nodes).toEqual([target.start, a, b, target.end]);
    });

    it('moves an entire DocumentFragment\'s nodes into the range', () =>
    {
        const { fragment, target } = createCoMarkers('dynamic');
        const container = document.createElement('div');
        container.appendChild(fragment);

        const payload = document.createDocumentFragment();
        const a = document.createElement('i');
        const b = document.createElement('b');
        payload.appendChild(a);
        payload.appendChild(b);
        appendToCo(target, payload);

        const nodes = Array.from(container.childNodes);
        expect(nodes).toEqual([target.start, a, b, target.end]);
    });
});

describe('clearCo', () =>
{
    it('removes every content node in the range but keeps the markers', () =>
    {
        const { fragment, target } = createCoMarkers('show');
        const container = document.createElement('div');
        container.appendChild(fragment);

        appendToCo(target, document.createElement('p'));
        appendToCo(target, document.createElement('span'));
        expect(container.childNodes.length).toBe(4); // start, p, span, end

        clearCo(target);

        // Only the two markers remain, still bracketing an empty range.
        const nodes = Array.from(container.childNodes);
        expect(nodes).toEqual([target.start, target.end]);
        expect(target.start.parentNode).toBe(container);
        expect(target.end.parentNode).toBe(container);
    });

    it('runs destroy hooks (via destroyComponent) on each removed element', () =>
    {
        const { fragment, target } = createCoMarkers('show');
        const container = document.createElement('div');
        container.appendChild(fragment);

        const torn: string[] = [];
        const first = document.createElement('div');
        const second = document.createElement('div');
        const secondChild = document.createElement('span');
        second.appendChild(secondChild);

        setDestroyHooks(first, [() => torn.push('first')]);
        setDestroyHooks(second, [() => torn.push('second')]);
        setDestroyHooks(secondChild, [() => torn.push('secondChild')]);

        appendToCo(target, first);
        appendToCo(target, second);

        clearCo(target);

        // Each removed top-level node is destroyed, recursing into descendants.
        expect(torn).toEqual(['first', 'second', 'secondChild']);
        expect(container.childNodes.length).toBe(2); // markers only
    });

    it('removes non-element content (text/comment) without attempting teardown', () =>
    {
        const { fragment, target } = createCoMarkers('show');
        const container = document.createElement('div');
        container.appendChild(fragment);

        appendToCo(target, document.createTextNode('text'));
        appendToCo(target, document.createComment('comment'));

        expect(() => clearCo(target)).not.toThrow();
        expect(Array.from(container.childNodes)).toEqual([target.start, target.end]);
    });

    it('is a no-op on an already-empty range', () =>
    {
        const { fragment, target } = createCoMarkers('show');
        const container = document.createElement('div');
        container.appendChild(fragment);

        expect(() => clearCo(target)).not.toThrow();
        expect(Array.from(container.childNodes)).toEqual([target.start, target.end]);
    });

    it('clears only its own range, leaving sibling content outside the markers untouched', () =>
    {
        const { fragment, target } = createCoMarkers('show');
        const container = document.createElement('div');
        const before = document.createElement('header');
        const after = document.createElement('footer');
        container.appendChild(before);
        container.appendChild(fragment);
        container.appendChild(after);

        appendToCo(target, document.createElement('p'));
        clearCo(target);

        // Content before/after the markers is left alone.
        const nodes = Array.from(container.childNodes);
        expect(nodes).toEqual([before, target.start, target.end, after]);
    });
});

describe('adoptCoRange', () =>
{
    it('adopts an existing server-rendered marker range from a hydration cursor', () =>
    {
        // Reconstruct the DOM a server render emits: the open control-flow anchor
        // (`azc:<type>`), the range content, the matching close anchor (`/azc`),
        // all siblings in one parent. This is exactly wrapContentsAnchored's output.
        const parent = document.createElement('div');
        const open = document.createComment('azc:show');
        const content = document.createElement('p');
        content.textContent = 'server content';
        const close = document.createComment('/azc');
        parent.appendChild(open);
        parent.appendChild(content);
        parent.appendChild(close);

        const cursor = new HydrationCursor(parent, Array.from(parent.childNodes));

        const { target, contentCursor } = adoptCoRange(cursor);

        // The adopted markers are the server's open/close comments, reused live.
        expect(target.start).toBe(open);
        expect(target.end).toBe(close);
        expect(target.parent()).toBe(parent);
        expect(contentCursor).toBeInstanceOf(HydrationCursor);
    });

    it('adopts an empty range (markers adjacent, no content between)', () =>
    {
        const parent = document.createElement('div');
        const open = document.createComment('azc:switch');
        const close = document.createComment('/azc');
        parent.appendChild(open);
        parent.appendChild(close);

        const cursor = new HydrationCursor(parent, Array.from(parent.childNodes));
        const { target } = adoptCoRange(cursor);

        expect(target.start).toBe(open);
        expect(target.end).toBe(close);
    });

    it('the adopted range supports later swaps: clearCo then appendToCo on the reused markers', () =>
    {
        const parent = document.createElement('div');
        const open = document.createComment('azc:show');
        const serverContent = document.createElement('p');
        const close = document.createComment('/azc');
        parent.appendChild(open);
        parent.appendChild(serverContent);
        parent.appendChild(close);

        const cursor = new HydrationCursor(parent, Array.from(parent.childNodes));
        const { target } = adoptCoRange(cursor);

        // Clear the adopted server content, then mount a fresh client branch -
        // exactly what a control-flow component does on its first client swap.
        clearCo(target);
        expect(Array.from(parent.childNodes)).toEqual([open, close]);

        const fresh = document.createElement('section');
        appendToCo(target, fresh);
        expect(Array.from(parent.childNodes)).toEqual([open, fresh, close]);
    });
});
