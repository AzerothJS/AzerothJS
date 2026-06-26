// @vitest-environment happy-dom
//
// Full behavioral coverage for destroyComponent (destroy-component.ts): the node-bound
// subtree teardown that runs every destroy hook attached to an element and its descendants.
// Reactive effects are owned by their createRoot, NOT by destroyComponent - this suite
// exercises the NON-reactive, element-attached hook walk and its three guarantees: it
// recurses into the whole subtree, it snapshots each element's children before recursing
// (so a hook that mutates the DOM can't skip siblings), and it is idempotent (hooks drain
// after the first run).
//
// Hooks are attached via setDestroyHooks, the package-internal storage primitive the
// renderer's removers use; the test imports it directly (white-box) since it is the only
// way to register a node-bound hook, and that is exactly what destroyComponent runs.
import { describe, it, expect } from 'vitest';
import { destroyComponent } from '@azerothjs/component';
import { setDestroyHooks } from '../src/destroy-hooks.ts';

describe('destroyComponent', () =>
{
    it('runs a destroy hook attached to the root element', () =>
    {
        const el = document.createElement('div');
        let ran = 0;
        setDestroyHooks(el, [() => ran++]);

        destroyComponent(el);

        expect(ran).toBe(1);
    });

    it('runs hooks on every descendant, depth-first', () =>
    {
        const order: string[] = [];
        const root = document.createElement('div');
        const childA = document.createElement('section');
        const grandchild = document.createElement('span');
        const childB = document.createElement('p');

        childA.appendChild(grandchild);
        root.appendChild(childA);
        root.appendChild(childB);

        setDestroyHooks(root, [() => order.push('root')]);
        setDestroyHooks(childA, [() => order.push('childA')]);
        setDestroyHooks(grandchild, [() => order.push('grandchild')]);
        setDestroyHooks(childB, [() => order.push('childB')]);

        destroyComponent(root);

        // Own hook first, then recurse into children in order: childA's subtree
        // (childA, then its grandchild) fully before moving on to childB.
        expect(order).toEqual(['root', 'childA', 'grandchild', 'childB']);
    });

    it('runs all hooks on one element in attachment order', () =>
    {
        const el = document.createElement('div');
        const order: string[] = [];
        setDestroyHooks(el, [
            () => order.push('first'),
            () => order.push('second'),
            () => order.push('third')
        ]);

        destroyComponent(el);

        expect(order).toEqual(['first', 'second', 'third']);
    });

    it('is a no-op on an element with no hooks (and its hook-less subtree)', () =>
    {
        const root = document.createElement('div');
        root.appendChild(document.createElement('span'));

        expect(() => destroyComponent(root)).not.toThrow();
    });

    it('is idempotent: hooks drain after the first run, so a second call does nothing', () =>
    {
        const el = document.createElement('div');
        let ran = 0;
        setDestroyHooks(el, [() => ran++]);

        destroyComponent(el);
        destroyComponent(el);
        destroyComponent(el);

        expect(ran).toBe(1);
    });

    it('is idempotent across a whole subtree', () =>
    {
        let rootRuns = 0;
        let childRuns = 0;
        const root = document.createElement('div');
        const child = document.createElement('span');
        root.appendChild(child);
        setDestroyHooks(root, [() => rootRuns++]);
        setDestroyHooks(child, [() => childRuns++]);

        destroyComponent(root);
        destroyComponent(root);

        expect(rootRuns).toBe(1);
        expect(childRuns).toBe(1);
    });

    it('snapshots children before recursing: a hook that removes a later sibling still lets every sibling hook run', () =>
    {
        // Regression for the live-HTMLCollection hazard: destroyComponent copies
        // element.children (Array.from) BEFORE recursing, so a hook that mutates
        // the DOM mid-walk (here: removing a following sibling) cannot shift the
        // live collection and skip nodes. Every hook must still fire exactly once.
        const order: string[] = [];
        const root = document.createElement('div');
        const first = document.createElement('div');
        const second = document.createElement('div');
        const third = document.createElement('div');
        root.appendChild(first);
        root.appendChild(second);
        root.appendChild(third);

        // The first child's hook removes the THIRD child from the DOM mid-walk.
        // Were the walk over the live HTMLCollection, removing `third` would shift
        // indices and the walk could skip a sibling. With a snapshot, all run.
        setDestroyHooks(first, [() =>
        {
            order.push('first');
            root.removeChild(third);
        }]);
        setDestroyHooks(second, [() => order.push('second')]);
        setDestroyHooks(third, [() => order.push('third')]);

        destroyComponent(root);

        expect(order).toEqual(['first', 'second', 'third']);
        // The hook's mutation actually took effect.
        expect(root.contains(third)).toBe(false);
    });

    it('snapshots children before recursing: a hook that removes the NEXT sibling does not skip it', () =>
    {
        const order: string[] = [];
        const root = document.createElement('div');
        const first = document.createElement('div');
        const second = document.createElement('div');
        const third = document.createElement('div');
        root.appendChild(first);
        root.appendChild(second);
        root.appendChild(third);

        // first removes the immediately-following sibling (second). On a live
        // collection, the walk's cursor would jump straight from first to third,
        // skipping second entirely.
        setDestroyHooks(first, [() =>
        {
            order.push('first');
            root.removeChild(second);
        }]);
        setDestroyHooks(second, [() => order.push('second')]);
        setDestroyHooks(third, [() => order.push('third')]);

        destroyComponent(root);

        expect(order).toEqual(['first', 'second', 'third']);
    });

    it('still runs a removed subtree\'s own descendant hooks after the parent detaches it', () =>
    {
        // A hook detaches a sibling that itself has a child with a hook. Because
        // the parent's child list was snapshotted, destroyComponent still recurses
        // into the detached sibling and fires its descendant hook.
        const order: string[] = [];
        const root = document.createElement('div');
        const first = document.createElement('div');
        const second = document.createElement('div');
        const secondChild = document.createElement('span');
        second.appendChild(secondChild);
        root.appendChild(first);
        root.appendChild(second);

        setDestroyHooks(first, [() =>
        {
            order.push('first');
            root.removeChild(second);
        }]);
        setDestroyHooks(second, [() => order.push('second')]);
        setDestroyHooks(secondChild, [() => order.push('secondChild')]);

        destroyComponent(root);

        expect(order).toEqual(['first', 'second', 'secondChild']);
    });

    it('recurses only into element children, ignoring text and comment nodes', () =>
    {
        const order: string[] = [];
        const root = document.createElement('div');
        root.appendChild(document.createTextNode('text'));
        root.appendChild(document.createComment('comment'));
        const child = document.createElement('span');
        root.appendChild(child);

        setDestroyHooks(root, [() => order.push('root')]);
        setDestroyHooks(child, [() => order.push('child')]);

        expect(() => destroyComponent(root)).not.toThrow();
        expect(order).toEqual(['root', 'child']);
    });

    it('drains the element\'s hook storage so a hook re-registered after teardown is independent', () =>
    {
        const el = document.createElement('div');
        let firstRuns = 0;
        let secondRuns = 0;
        setDestroyHooks(el, [() => firstRuns++]);

        destroyComponent(el);
        expect(firstRuns).toBe(1);

        // After draining, the element accepts a fresh hook set, and a later
        // destroyComponent runs only those - the first batch is gone.
        setDestroyHooks(el, [() => secondRuns++]);
        destroyComponent(el);

        expect(firstRuns).toBe(1);
        expect(secondRuns).toBe(1);
    });
});
