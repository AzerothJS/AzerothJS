// @vitest-environment happy-dom
//
// Cross-module integration for @azerothjs/component: a real rendered, interactive tree torn
// down cleanly (leak-free, verified by subscriberCount AND the testing package's leakGuard),
// and an <ErrorBoundary> recovering inside a rendered app. No mocks - the reactive core, the
// real DOM renderer (h/render), and the live happy-dom tree.
//
// TEARDOWN MODEL (verified against source): reactive subscriptions are owned by the mount's
// createRoot, NOT by destroyComponent. destroyComponent runs the NON-reactive, node-bound
// destroy hooks and recurses the subtree. The leak-free guarantee is the COMBINATION the
// renderer's removers use - dispose the root (reactive teardown) AND walk destroyComponent
// (node-bound hooks) - which is exactly what render()'s remount and renderTest's unmount do.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createMemo,
    subscriberCount,
    createRoot
} from '@azerothjs/reactivity';
import { h, render } from '@azerothjs/renderer';
import { ErrorBoundary, destroyComponent } from '@azerothjs/component';
import { renderTest, leakGuard } from '@azerothjs/testing';
import { setDestroyHooks } from '../src/destroy-hooks.ts';

describe('component integration: teardown of a rendered tree', () =>
{
    it('an interactive rendered component updates in place, then tears down leak-free', () =>
    {
        const [count, setCount] = createSignal(0);

        // Snapshot subscriber count BEFORE mount so leakGuard measures the net
        // delta the mount introduces (and releases).
        const check = leakGuard(count);

        // The memo is created INSIDE the component so it is owned by the mount's
        // root and torn down with it - a subscription created outside the mount
        // would legitimately survive unmount and is not a leak.
        const { container, unmount } = renderTest(() =>
        {
            const doubled = createMemo(() => count() * 2);
            return h('div', {},
                h('button', { onClick: () => setCount((c) => c + 1) }, 'inc'),
                h('span', { class: 'value' }, () => `count: ${ count() }`),
                h('span', { class: 'doubled' }, () => `doubled: ${ doubled() }`));
        });

        const button = container.querySelector('button') as HTMLButtonElement;
        expect(container.querySelector('.value')!.textContent).toBe('count: 0');
        expect(container.querySelector('.doubled')!.textContent).toBe('doubled: 0');

        // Real interaction: clicking flows through the signal back into the DOM.
        button.click();
        button.click();
        expect(container.querySelector('.value')!.textContent).toBe('count: 2');
        expect(container.querySelector('.doubled')!.textContent).toBe('doubled: 4');

        // While mounted, the bindings hold live subscriptions.
        expect(subscriberCount(count)).toBeGreaterThan(0);

        // Documented teardown path: dispose the root AND run destroyComponent per
        // removed node (renderTest.unmount does both).
        unmount();

        // Every subscription the mount introduced is released: count returns to
        // its pre-mount baseline, and leakGuard confirms no net leak.
        expect(subscriberCount(count)).toBe(0);
        check();
    });

    it('render() remount of the same container disposes the prior mount\'s subscriptions (and runs destroy hooks)', () =>
    {
        const [count] = createSignal(0);
        const container = document.createElement('div');
        document.body.appendChild(container);

        render(() => h('p', {}, () => `count: ${ count() }`), container);
        expect(subscriberCount(count)).toBeGreaterThan(0);
        expect(container.textContent).toBe('count: 0');

        // Attach a node-bound destroy hook to the mounted element so we can prove
        // the remount's destroyComponent walk fired it.
        let hookRan = 0;
        setDestroyHooks(container.firstChild as HTMLElement, [() => hookRan++]);

        // Remounting the same container disposes the previous root (reactive
        // teardown -> subscriberCount 0) and clears the DOM node-by-node, running
        // destroy hooks (node-bound teardown -> hookRan 1).
        render(() => h('div', {}, 'replaced'), container);

        expect(subscriberCount(count)).toBe(0);
        expect(hookRan).toBe(1);
        expect(container.textContent).toBe('replaced');

        container.remove();
    });

    it('destroyComponent runs node-bound destroy hooks across a real rendered subtree', () =>
    {
        // Build a real tree via the renderer, attach destroy hooks to several
        // nodes, then walk it with destroyComponent and confirm every hook ran in
        // depth-first order. (Reactive disposal is the root's job; this asserts the
        // node-bound half that destroyComponent owns.)
        const torn: string[] = [];
        let root!: HTMLElement;

        createRoot((dispose) =>
        {
            root = h('section', {},
                h('header', {}, 'title'),
                h('main', {}, h('p', {}, 'body')));

            const header = root.querySelector('header') as HTMLElement;
            const main = root.querySelector('main') as HTMLElement;
            const para = root.querySelector('p') as HTMLElement;

            setDestroyHooks(root, [() => torn.push('section')]);
            setDestroyHooks(header, [() => torn.push('header')]);
            setDestroyHooks(main, [() => torn.push('main')]);
            setDestroyHooks(para, [() => torn.push('p')]);

            dispose();
        });

        destroyComponent(root);

        expect(torn).toEqual(['section', 'header', 'main', 'p']);

        // Idempotent: a second walk runs nothing.
        destroyComponent(root);
        expect(torn).toEqual(['section', 'header', 'main', 'p']);
    });
});

describe('component integration: ErrorBoundary inside a rendered app', () =>
{
    it('a thrown child shows the fallback; reset recovers, and the whole app tears down leak-free', () =>
    {
        const [reloads, setReloads] = createSignal(0);
        // `attempt` is derived from a signal so the protected child re-reads it on
        // every (re)render driven by reset.
        let attempts = 0;

        const check = leakGuard(reloads);

        const { container, unmount } = renderTest(() =>
            h('div', { class: 'app' },
                h('h1', {}, 'My App'),
                ErrorBoundary({
                    fallback: (err, reset) =>
                        h('div', { class: 'error' },
                            h('p', {}, `Something broke: ${ (err as Error).message }`),
                            h('button', { class: 'reset', onClick: () => reset() }, 'Try again')),
                    children: () =>
                    {
                        attempts++;
                        // Fail the first attempt, succeed afterwards.
                        if (attempts === 1)
                        {
                            throw new Error('boom');
                        }
                        return h('div', { class: 'content' }, () => `loaded (reloads: ${ reloads() })`);
                    }
                })));

        // App chrome is always present; the boundary swapped to the fallback.
        expect(container.querySelector('h1')!.textContent).toBe('My App');
        expect(container.querySelector('.error')).not.toBeNull();
        expect(container.querySelector('.content')).toBeNull();
        expect(container.textContent).toContain('Something broke: boom');

        // Recover via the fallback's reset button.
        (container.querySelector('.reset') as HTMLButtonElement).click();

        expect(container.querySelector('.error')).toBeNull();
        const content = container.querySelector('.content');
        expect(content).not.toBeNull();
        expect(content!.textContent).toBe('loaded (reloads: 0)');

        // The recovered subtree is live and reactive: a signal write updates it in place.
        setReloads(1);
        expect(container.querySelector('.content')!.textContent).toBe('loaded (reloads: 1)');

        // The whole app - boundary, recovered subtree, and its bindings - tears
        // down with no leaked subscriptions.
        unmount();
        expect(subscriberCount(reloads)).toBe(0);
        check();
    });
});
