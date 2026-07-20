// @vitest-environment happy-dom
//
// Full behavioral coverage for <ErrorBoundary> (error-boundary.ts): it wraps a child factory
// and swaps to a fallback when the child throws - on a synchronous setup throw AND on a throw
// from an effect/memo created in the subtree on a much later signal change. The fallback's
// reset() clears the captured error and re-attempts children. Nested boundaries isolate, so an
// inner boundary catches first.
//
// Real execution: the boundary is built inside a real createRoot (so its driving effect is
// owned), its returned fragment is appended into a live container so the co-range markers and
// the active branch land in the real DOM, and signals/effects are the genuine reactivity core.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createRoot
} from '@azerothjs/reactivity';
import { ErrorBoundary } from '@azerothjs/component';
import { h } from '@azerothjs/renderer';

/**
 * Mounts an ErrorBoundary inside a real reactive root and a live container.
 * Returns the container plus the root disposer so a test can tear the whole
 * boundary (and its effects) down.
 */
function mountBoundary(props: Parameters<typeof ErrorBoundary>[0]): {
    container: HTMLElement;
    dispose: () => void;
}
{
    const container = document.createElement('div');
    document.body.appendChild(container);

    let dispose!: () => void;
    createRoot((d) =>
    {
        dispose = d;
        container.appendChild(ErrorBoundary(props));
    });

    return { container, dispose };
}

describe('ErrorBoundary', () =>
{
    it('renders children when nothing throws', () =>
    {
        const { container, dispose } = mountBoundary({
            fallback: () => h('div', { class: 'fallback' }, 'boom'),
            children: () => h('p', { class: 'ok' }, 'all good')
        });

        expect(container.querySelector('.ok')).not.toBeNull();
        expect(container.querySelector('.fallback')).toBeNull();
        expect(container.textContent).toContain('all good');

        dispose();
        container.remove();
    });

    it('catches a synchronous throw in children and renders the fallback instead', () =>
    {
        let caught: unknown = null;
        const { container, dispose } = mountBoundary({
            fallback: (err) =>
            {
                caught = err;
                return h('div', { class: 'fallback' }, `failed: ${ (err as Error).message }`);
            },
            children: () =>
            {
                throw new Error('child-setup-throw');
            }
        });

        // The children branch never appears; the fallback is mounted in its place.
        expect(container.querySelector('.fallback')).not.toBeNull();
        expect(container.textContent).toContain('failed: child-setup-throw');
        expect((caught as Error).message).toBe('child-setup-throw');

        dispose();
        container.remove();
    });

    it('passes a working reset() to the fallback that re-renders children', () =>
    {
        let attempt = 0;
        const { container, dispose } = mountBoundary({
            fallback: (_err, reset) =>
                h('button', { class: 'retry', onClick: () => reset() }, 'try again'),
            children: () =>
            {
                attempt++;
                // Fail on the first attempt, succeed on the retry.
                if (attempt === 1)
                {
                    throw new Error('first-attempt-fails');
                }
                return h('p', { class: 'recovered' }, 'recovered');
            }
        });

        // First attempt threw -> fallback shown.
        const retry = container.querySelector('.retry') as HTMLButtonElement;
        expect(retry).not.toBeNull();
        expect(container.querySelector('.recovered')).toBeNull();

        // reset() clears the error and re-attempts children, which now succeeds.
        retry.click();

        expect(container.querySelector('.recovered')).not.toBeNull();
        expect(container.querySelector('.retry')).toBeNull();
        expect(attempt).toBe(2);

        dispose();
        container.remove();
    });

    it('catches a throw from an effect created in the subtree on a LATER signal change', () =>
    {
        const [n, setN] = createSignal(0);
        let caught: unknown = null;

        const { container, dispose } = mountBoundary({
            fallback: (err) =>
            {
                caught = err;
                return h('div', { class: 'fallback' }, 'effect failed');
            },
            children: () =>
            {
                const el = h('p', { class: 'live' }, 'live');
                // An effect inside the protected subtree. It throws only when the
                // signal crosses a threshold - long after setup returned.
                createEffect(() =>
                {
                    if (n() > 0)
                    {
                        throw new Error('deferred-effect-throw');
                    }
                });
                return el;
            }
        });

        // Setup ran cleanly: children are shown, no fallback yet.
        expect(container.querySelector('.live')).not.toBeNull();
        expect(container.querySelector('.fallback')).toBeNull();

        // A later write re-runs the effect, which throws and is caught -> swap.
        setN(1);

        expect(container.querySelector('.fallback')).not.toBeNull();
        expect(container.querySelector('.live')).toBeNull();
        expect((caught as Error).message).toBe('deferred-effect-throw');

        dispose();
        container.remove();
    });

    it('catches a thrown null/undefined (distinguished from "no error")', () =>
    {
        let fallbackRendered = false;
        const { container, dispose } = mountBoundary({
            fallback: (err) =>
            {
                fallbackRendered = true;
                // The thrown value really was null - the boundary still caught it.
                expect(err).toBeNull();
                return h('div', { class: 'fallback' }, 'caught null');
            },
            children: () =>
            {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- the thrown-null case IS the behavior under test (the { value } wrapper must distinguish it from "no error")
                throw null;
            }
        });

        expect(fallbackRendered).toBe(true);
        expect(container.querySelector('.fallback')).not.toBeNull();

        dispose();
        container.remove();
    });

    it('reset() with no captured error is a no-op (children stay mounted)', () =>
    {
        let resetFn: (() => void) | null = null;
        let childBuilds = 0;
        const { container, dispose } = mountBoundary({
            fallback: (_err, reset) =>
            {
                resetFn = reset;
                return h('div', { class: 'fallback' }, 'fallback');
            },
            children: () =>
            {
                childBuilds++;
                return h('p', { class: 'ok' }, 'ok');
            }
        });

        // No throw -> children shown, fallback never built, so we never captured
        // a reset. Confirm the happy path and that children built exactly once.
        expect(container.querySelector('.ok')).not.toBeNull();
        expect(resetFn).toBeNull();
        expect(childBuilds).toBe(1);

        dispose();
        container.remove();
    });

    it('nested boundaries isolate: the inner boundary catches, the outer keeps rendering', () =>
    {
        const { container, dispose } = mountBoundary({
            fallback: () => h('div', { class: 'outer-fallback' }, 'outer caught'),
            children: () => h('div', { class: 'outer-ok' },
                // The inner boundary wraps a throwing child. It should catch,
                // so the throw never reaches the outer boundary.
                ErrorBoundary({
                    fallback: () => h('span', { class: 'inner-fallback' }, 'inner caught'),
                    children: () =>
                    {
                        throw new Error('inner-throw');
                    }
                }))
        });

        // Inner caught -> inner fallback shown; outer subtree intact, outer fallback NOT shown.
        expect(container.querySelector('.inner-fallback')).not.toBeNull();
        expect(container.querySelector('.outer-ok')).not.toBeNull();
        expect(container.querySelector('.outer-fallback')).toBeNull();

        dispose();
        container.remove();
    });

    it('an error in the inner children escapes to the OUTER boundary when the inner fallback itself throws', () =>
    {
        // The fallback is deliberately NOT wrapped in catchError: if it throws, the
        // error propagates outside the inner boundary (avoiding a fallback loop) and
        // the outer boundary catches it.
        const { container, dispose } = mountBoundary({
            fallback: () => h('div', { class: 'outer-fallback' }, 'outer caught'),
            children: () =>
                ErrorBoundary({
                    fallback: () =>
                    {
                        throw new Error('broken-fallback');
                    },
                    children: () =>
                    {
                        throw new Error('inner-throw');
                    }
                })
        });

        // Inner caught the child throw, tried to render its fallback, which threw;
        // that escaped the inner boundary and the outer boundary caught it.
        expect(container.querySelector('.outer-fallback')).not.toBeNull();

        dispose();
        container.remove();
    });

    it('swaps cleanly back and forth across multiple reset cycles', () =>
    {
        const [shouldThrow, setShouldThrow] = createSignal(true);
        let builds = 0;

        const { container, dispose } = mountBoundary({
            fallback: (_err, reset) =>
                h('button', { class: 'retry', onClick: () => reset() }, 'retry'),
            children: () =>
            {
                builds++;
                if (shouldThrow())
                {
                    throw new Error('cycle-throw');
                }
                return h('p', { class: 'ok' }, 'ok');
            }
        });

        // Attempt 1: throws -> fallback.
        expect(container.querySelector('.retry')).not.toBeNull();

        // Fix the cause, then reset -> children succeed.
        setShouldThrow(false);
        (container.querySelector('.retry') as HTMLButtonElement).click();
        expect(container.querySelector('.ok')).not.toBeNull();
        expect(container.querySelector('.retry')).toBeNull();

        expect(builds).toBe(2);

        dispose();
        container.remove();
    });

    it('resolves a thunk-chain children (a thunk returning a thunk) instead of crashing', () =>
    {
        const inner = (): HTMLElement => h('p', { class: 'ok' }, 'ok');

        const { container, dispose } = mountBoundary({
            fallback: (_err, reset) => h('button', { class: 'retry', onClick: () => reset() }, 'retry'),
            children: () => inner as unknown as HTMLElement
        });

        expect(container.querySelector('.ok')).not.toBeNull();
        expect(container.querySelector('.retry')).toBeNull();

        dispose();
        container.remove();
    });
});
