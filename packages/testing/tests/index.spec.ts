// @vitest-environment happy-dom
//
// Meta-tests for @azerothjs/testing: the helpers ARE the system under test, exercised
// with REAL execution against real happy-dom DOM and the real reactive core (signals,
// effects, roots, the renderer's h()). No mocks of runtime. Each export is covered for
// its documented behavior:
//   - renderTest: attached container, live reactive updates, unmount disposes the root
//     (subscriberCount -> 0) and removes the container, idempotent unmount.
//   - leakGuard: passes on a clean teardown, THROWS naming the offender on a real leak,
//     passes when subscriber count is unchanged.
//   - fire: dispatches a bubbling, cancelable event a delegated (document-level) handler
//     receives; a non-bubbling event does NOT reach a delegated handler; custom init.
//   - cleanup: unmounts trees renderTest left mounted; idempotent.
import { describe, it, expect } from 'vitest';
import { renderTest, cleanup, leakGuard, fire } from '@azerothjs/testing';
import { createSignal, createRoot, createEffect, subscriberCount } from '@azerothjs/reactivity';
import { h, bindProps } from '@azerothjs/renderer';

describe('renderTest', () =>
{
    it('mounts the component into a container attached to document.body', () =>
    {
        const { container, unmount } = renderTest(() => h('p', {}, 'hello'));

        expect(container.parentNode).toBe(document.body);
        expect(document.body.contains(container)).toBe(true);
        expect(container.querySelector('p')!.textContent).toBe('hello');

        unmount();
    });

    it('returns a working container holding the rendered DOM', () =>
    {
        const { container, unmount } = renderTest(() =>
            h('div', { id: 'root' }, h('span', {}, 'child')));

        const div = container.querySelector('#root')!;
        expect(div.tagName).toBe('DIV');
        expect(div.querySelector('span')!.textContent).toBe('child');

        unmount();
    });

    it('reactive updates flow into the DOM in place (signal change -> DOM change)', () =>
    {
        const [count, setCount] = createSignal(0);
        const { container, unmount } = renderTest(() =>
            h('p', {}, () => `count: ${ count() }`));

        const p = container.querySelector('p')!;
        expect(p.textContent).toBe('count: 0');

        setCount(1);
        // Same node, mutated in place - no re-render.
        expect(container.querySelector('p')).toBe(p);
        expect(p.textContent).toBe('count: 1');

        setCount(41);
        expect(p.textContent).toBe('count: 41');

        unmount();
    });

    it('unmount() removes the container from the document', () =>
    {
        const { container, unmount } = renderTest(() => h('p', {}, 'x'));
        expect(document.body.contains(container)).toBe(true);

        unmount();

        expect(document.body.contains(container)).toBe(false);
        expect(container.parentNode).toBeNull();
    });

    it('unmount() disposes reactive subscriptions (subscriberCount -> 0)', () =>
    {
        const [count, setCount] = createSignal(0);
        const { unmount } = renderTest(() => h('p', {}, () => String(count())));

        // The reactive child binding subscribed an effect to `count`.
        expect(subscriberCount(count)).toBe(1);

        unmount();

        // Disposing the root unlinked that effect.
        expect(subscriberCount(count)).toBe(0);

        // A post-unmount write reaches nobody - genuinely detached.
        setCount(99);
        expect(subscriberCount(count)).toBe(0);
    });

    it('unmount() is idempotent (second call no-throw, no further effect)', () =>
    {
        const [value] = createSignal('v');
        const { container, unmount } = renderTest(() => h('p', {}, () => value()));

        unmount();
        expect(document.body.contains(container)).toBe(false);
        expect(subscriberCount(value)).toBe(0);

        // Second call must be a clean no-op.
        expect(() => unmount()).not.toThrow();
        expect(document.body.contains(container)).toBe(false);
        expect(subscriberCount(value)).toBe(0);
    });
});

describe('leakGuard', () =>
{
    it('passes when renderTest + unmount released the subscription', () =>
    {
        const [count, setCount] = createSignal(0);

        // Snapshot BEFORE mounting, per the documented contract.
        const check = leakGuard(count);

        const { unmount } = renderTest(() => h('p', {}, () => String(count())));
        // While mounted the count is up - the leak is real until teardown.
        expect(subscriberCount(count)).toBe(1);
        setCount(5);

        unmount();

        // Released back to baseline -> guard passes.
        expect(() => check()).not.toThrow();
    });

    it('THROWS naming the offender when a real leak exists (undisposed effect)', () =>
    {
        const [count] = createSignal(0);
        const check = leakGuard(count);

        // A genuine leak: an effect subscribing to `count` inside a root we never
        // dispose. This subscription outlives the check.
        createRoot(() =>
        {
            createEffect(() =>
            {
                count();
            });
        });
        expect(subscriberCount(count)).toBe(1);

        expect(() => check()).toThrow(/subscriptions not released/);
        // Names the offending getter and its before -> after counts.
        expect(() => check()).toThrow(/getter #0: 0 -> 1 subscribers/);
    });

    it('THROWS when a renderTest tree is never unmounted (leaked binding)', () =>
    {
        const [count] = createSignal(0);
        const check = leakGuard(count);

        // Mount but deliberately never unmount: the binding effect stays subscribed.
        // (cleanup() in afterEach will reclaim it after this test.)
        renderTest(() => h('p', {}, () => String(count())));
        expect(subscriberCount(count)).toBe(1);

        expect(() => check()).toThrow(/getter #0/);
    });

    it('passes when subscriber count is unchanged (equal is not a leak)', () =>
    {
        const [count] = createSignal(0);

        // Pre-existing, intentionally-kept subscriber: baseline is 1, not 0.
        const keep = createRoot((dispose) =>
        {
            createEffect(() =>
            {
                count();
            });
            return dispose;
        });
        expect(subscriberCount(count)).toBe(1);

        const check = leakGuard(count);

        // Mount and tear down a tree: net change is zero.
        const { unmount } = renderTest(() => h('p', {}, () => String(count())));
        unmount();

        // Equal to baseline (1) -> passes; only an INCREASE throws.
        expect(() => check()).not.toThrow();

        keep();
        expect(subscriberCount(count)).toBe(0);
    });

    it('does not throw for a getter that ended with FEWER subscribers', () =>
    {
        const [count] = createSignal(0);

        const disposeFirst = createRoot((dispose) =>
        {
            createEffect(() =>
            {
                count();
            });
            return dispose;
        });
        expect(subscriberCount(count)).toBe(1);

        // Baseline captured at 1; then we release a subscriber -> ends at 0 (fewer).
        const check = leakGuard(count);
        disposeFirst();
        expect(subscriberCount(count)).toBe(0);

        expect(() => check()).not.toThrow();
    });

    it('checks every getter and reports each offender independently', () =>
    {
        const [a] = createSignal('a');
        const [b] = createSignal('b');
        const check = leakGuard(a, b);

        // Leak only `b`.
        createRoot(() =>
        {
            createEffect(() =>
            {
                b();
            });
        });

        let message = '';
        try
        {
            check();
        }
        catch (error)
        {
            message = (error as Error).message;
        }

        expect(message).toMatch(/getter #1: 0 -> 1 subscribers/);
        // `a` (getter #0) never leaked, so it must not be named.
        expect(message).not.toMatch(/getter #0/);
    });
});

describe('fire', () =>
{
    it('reaches a per-element handler bound via h()', () =>
    {
        let clicks = 0;
        const { container, unmount } = renderTest(() =>
            h('button', { onClick: () =>
            {
                clicks++;
            } }, 'go'));

        const button = container.querySelector('button')!;
        fire(button, 'click');
        fire(button, 'click');
        expect(clicks).toBe(2);

        unmount();
    });

    it('a BUBBLING event reaches a delegated (document-level) handler', () =>
    {
        // bindProps delegates bubbling events to a single document listener; the
        // handler only fires for events that actually bubble to the document.
        let clicks = 0;
        const button = h('button', {});
        bindProps(button, { onClick: () =>
        {
            clicks++;
        } });
        const { container, unmount } = renderTest(() => button);
        // Sanity: the delegated element is connected (required for delegation).
        expect(container.contains(button)).toBe(true);

        fire(button, 'click');
        expect(clicks).toBe(1);

        unmount();
    });

    it('a NON-bubbling plain Event does NOT reach a delegated handler', () =>
    {
        // Contrast: fire() always bubbles, but a hand-built non-bubbling event
        // never reaches the document, so the delegated handler does not run.
        let delegated = 0;
        const button = h('button', {});
        bindProps(button, { onClick: () =>
        {
            delegated++;
        } });
        const { unmount } = renderTest(() => button);

        // Non-bubbling: dies at the target, document listener never sees it.
        button.dispatchEvent(new Event('click', { bubbles: false }));
        expect(delegated).toBe(0);

        // fire() bubbles, so the SAME delegated handler now runs.
        fire(button, 'click');
        expect(delegated).toBe(1);

        unmount();
    });

    it('dispatches a cancelable event and supports custom init (detail merge)', () =>
    {
        let seenCancelable: boolean | null = null;
        let seenBubbles: boolean | null = null;
        const { container, unmount } = renderTest(() =>
            h('input', { onInput: (event: Event) =>
            {
                seenCancelable = event.cancelable;
                seenBubbles = event.bubbles;
            } }, ''));

        const input = container.querySelector('input')!;
        fire(input, 'input');
        expect(seenBubbles).toBe(true);
        expect(seenCancelable).toBe(true);

        unmount();
    });

    it('custom init overrides the bubbling default (bubbles: false wins)', () =>
    {
        let bubbles: boolean | null = null;
        const button = h('button', { onClick: (event: Event) =>
        {
            bubbles = event.bubbles;
        } });
        // Per-element listener still fires regardless of bubbling.
        const { unmount } = renderTest(() => button);

        fire(button, 'click', { bubbles: false });
        expect(bubbles).toBe(false);

        unmount();
    });
});

describe('cleanup', () =>
{
    it('unmounts a tree renderTest left mounted (removes container, disposes root)', () =>
    {
        const [count] = createSignal(0);
        // No manual unmount: cleanup() owns its disposal.
        const { container } = renderTest(() => h('p', {}, () => String(count())));

        expect(document.body.contains(container)).toBe(true);
        expect(subscriberCount(count)).toBe(1);

        cleanup();

        // Assert immediately after OUR cleanup() call - robust to the afterEach
        // cleanup that also runs (it would be a second, idempotent no-op).
        expect(document.body.contains(container)).toBe(false);
        expect(subscriberCount(count)).toBe(0);
    });

    it('unmounts EVERY tracked tree, not just the last', () =>
    {
        const [a] = createSignal(0);
        const [b] = createSignal(0);
        const first = renderTest(() => h('p', {}, () => String(a())));
        const second = renderTest(() => h('p', {}, () => String(b())));

        expect(document.body.contains(first.container)).toBe(true);
        expect(document.body.contains(second.container)).toBe(true);

        cleanup();

        expect(document.body.contains(first.container)).toBe(false);
        expect(document.body.contains(second.container)).toBe(false);
        expect(subscriberCount(a)).toBe(0);
        expect(subscriberCount(b)).toBe(0);
    });

    it('is idempotent (a second cleanup() is a no-op)', () =>
    {
        const { container } = renderTest(() => h('p', {}, 'x'));
        cleanup();
        expect(document.body.contains(container)).toBe(false);

        expect(() => cleanup()).not.toThrow();
        expect(document.body.contains(container)).toBe(false);
    });

    it('does not unmount a tree that was already manually unmounted', () =>
    {
        const [count] = createSignal(0);
        const { container, unmount } = renderTest(() => h('p', {}, () => String(count())));

        unmount();
        expect(document.body.contains(container)).toBe(false);
        expect(subscriberCount(count)).toBe(0);

        // cleanup() must not touch an already-unmounted, no-longer-tracked tree.
        expect(() => cleanup()).not.toThrow();
        expect(document.body.contains(container)).toBe(false);
    });
});
