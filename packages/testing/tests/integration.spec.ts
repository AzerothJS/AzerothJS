// @vitest-environment happy-dom
//
// Integration: prove the @azerothjs/testing helpers compose to test a REAL interactive
// component end-to-end - mount with renderTest, drive interactions with fire, assert the
// live DOM, unmount, and confirm with leakGuard that the whole interactive cycle released
// every reactive subscription. Real reactive core + real happy-dom; no mocks.
import { describe, it, expect } from 'vitest';
import { renderTest, fire, leakGuard } from '@azerothjs/testing';
import { createSignal, createMemo, subscriberCount } from '@azerothjs/reactivity';
import { h, Show } from '@azerothjs/renderer';

// A small but realistic component: a counter with increment/reset buttons, a derived
// parity label (memo), and a Show that toggles a message once the count crosses a
// threshold. The reactive state (signal + memo) is created INSIDE the component so it
// is owned by renderTest's reactive root - the realistic pattern, and what lets unmount
// dispose every subscription. The getters are surfaced via an out-param so the test can
// leak-guard them after teardown.
interface CounterApi
{
    count: () => number;
    parity: () => string;
}

function Counter(expose: (api: CounterApi) => void): () => HTMLElement
{
    return () =>
    {
        const [count, setCount] = createSignal(0);
        const parity = createMemo(() => (count() % 2 === 0 ? 'even' : 'odd'));
        expose({ count, parity });

        return h('div', {},
            h('output', { id: 'value' }, () => String(count())),
            h('span', { id: 'parity' }, () => parity()),
            h('button', { id: 'inc', onClick: () => setCount((c) => c + 1) }, '+1'),
            h('button', { id: 'reset', onClick: () => setCount(0) }, 'reset'),
            Show({
                when: () => count() >= 3,
                children: () => h('p', { id: 'cheer' }, 'high!')
            }));
    };
}

describe('testing helpers - end-to-end interactive component', () =>
{
    it('mounts, reacts to fired events, and tears down with no leak', () =>
    {
        let api!: CounterApi;
        const { container, unmount } = renderTest(Counter((a) =>
        {
            api = a;
        }));

        // The component's reactive state is now live inside renderTest's root.
        const guard = leakGuard(api.count, api.parity);

        const value = container.querySelector('#value')!;
        const parity = container.querySelector('#parity')!;
        const inc = container.querySelector<HTMLButtonElement>('#inc')!;
        const reset = container.querySelector<HTMLButtonElement>('#reset')!;

        // Initial render.
        expect(value.textContent).toBe('0');
        expect(parity.textContent).toBe('even');
        expect(container.querySelector('#cheer')).toBeNull();

        // Interact purely through fire(): three increments cross the Show threshold.
        fire(inc, 'click');
        fire(inc, 'click');
        fire(inc, 'click');

        expect(value.textContent).toBe('3');
        expect(parity.textContent).toBe('odd');
        expect(container.querySelector('#cheer')!.textContent).toBe('high!');

        // Reset hides the conditional branch again.
        fire(reset, 'click');
        expect(value.textContent).toBe('0');
        expect(parity.textContent).toBe('even');
        expect(container.querySelector('#cheer')).toBeNull();

        // While mounted, the component holds live subscriptions.
        expect(subscriberCount(api.count)).toBeGreaterThan(0);
        expect(subscriberCount(api.parity)).toBeGreaterThan(0);

        unmount();

        // Container gone, and the mount->interact->unmount cycle released every
        // subscription owned by the root - guard passes AND the exact count is zero.
        expect(document.body.contains(container)).toBe(false);
        expect(() => guard()).not.toThrow();
        expect(subscriberCount(api.count)).toBe(0);
        expect(subscriberCount(api.parity)).toBe(0);
    });

    it('leakGuard CATCHES a leak when an interactive tree is never unmounted', () =>
    {
        // A signal owned outside the mount lets us snapshot the baseline (0) BEFORE
        // any subscriber exists - the documented contract. The component reads it, so
        // mounting adds subscribers; skipping unmount leaves them - guard must throw.
        // This proves the passing case above is meaningful, not vacuous.
        const [external, setExternal] = createSignal(0);
        const guard = leakGuard(external);
        expect(subscriberCount(external)).toBe(0);

        const { container } = renderTest(() =>
            h('button', { id: 'tick', onClick: () => setExternal((n) => n + 1) },
                () => `ticks: ${ external() }`));

        const button = container.querySelector<HTMLButtonElement>('#tick')!;
        fire(button, 'click');
        fire(button, 'click');
        expect(button.textContent).toBe('ticks: 2');
        expect(subscriberCount(external)).toBeGreaterThan(0);

        // Never unmounted -> the binding effect is still subscribed -> guard throws.
        expect(() => guard()).toThrow(/subscriptions not released/);

        // Clean up manually so this leaked tree does not bleed into later tests.
        container.remove();
    });
});
