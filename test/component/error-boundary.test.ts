import { describe, it, expect, vi } from 'vitest';
import { createRoot, createSignal, createEffect } from '@azerothjs/core';
import { ErrorBoundary } from '../../packages/component/src/error-boundary.ts';

/** Builds a simple paragraph fallback that displays the error. */
function makeTextFallback(): (err: unknown, reset: () => void) => HTMLElement
{
    return (err) =>
    {
        const p = document.createElement('p');
        p.setAttribute('data-role', 'fallback');
        p.textContent = `caught: ${ err instanceof Error ? err.message : String(err) }`;
        return p;
    };
}

describe('<ErrorBoundary>', () =>
{
    it('renders children when no error is thrown', () =>
    {
        createRoot((dispose) =>
        {
            const container = ErrorBoundary({
                fallback: makeTextFallback(),
                children: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-role', 'child');
                    div.textContent = 'hello';
                    return div;
                }
            });

            expect(container.querySelector('[data-role="child"]')).not.toBeNull();
            expect(container.querySelector('[data-role="fallback"]')).toBeNull();
            expect(container.textContent).toBe('hello');

            dispose();
        });
    });

    it('swaps to the fallback when the child throws synchronously', () =>
    {
        createRoot((dispose) =>
        {
            const container = ErrorBoundary({
                fallback: makeTextFallback(),
                children: () =>
                {
                    throw new Error('init-failed');
                }
            });

            expect(container.querySelector('[data-role="fallback"]')).not.toBeNull();
            expect(container.textContent).toBe('caught: init-failed');

            dispose();
        });
    });

    it('swaps to the fallback when an effect inside children throws on a signal change', () =>
    {
        createRoot((dispose) =>
        {
            const [count, setCount] = createSignal(0);

            const container = ErrorBoundary({
                fallback: makeTextFallback(),
                children: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-role', 'child');
                    createEffect(() =>
                    {
                        // Effect captures the boundary's handler at
                        // construction. On re-run after setCount(1)
                        // it throws, and the handler swaps the
                        // boundary to the fallback branch.
                        if (count() > 0)
                        {
                            throw new Error(`count=${ count() }`);
                        }
                    });
                    return div;
                }
            });

            // Initial render - the child is shown, no error.
            expect(container.querySelector('[data-role="child"]')).not.toBeNull();
            expect(container.querySelector('[data-role="fallback"]')).toBeNull();

            // Trigger the effect to throw.
            setCount(1);

            expect(container.querySelector('[data-role="child"]')).toBeNull();
            expect(container.querySelector('[data-role="fallback"]')).not.toBeNull();
            expect(container.textContent).toBe('caught: count=1');

            dispose();
        });
    });

    it('passes the original error and a working reset function to fallback', () =>
    {
        createRoot((dispose) =>
        {
            const failure = new Error('measure-me');
            const fallback = vi.fn(makeTextFallback());

            const container = ErrorBoundary({
                fallback,
                children: () =>
                {
                    throw failure;
                }
            });

            expect(fallback).toHaveBeenCalledOnce();
            const [receivedError, receivedReset] = fallback.mock.calls[0];

            // First arg: the exact error object, not a copy.
            expect(receivedError).toBe(failure);

            // Second arg: a reset function. We just check the type
            // here; behaviour is exercised in the next test.
            expect(typeof receivedReset).toBe('function');
            expect(container.querySelector('[data-role="fallback"]')).not.toBeNull();

            dispose();
        });
    });

    it('reset() clears the error and re-renders children', () =>
    {
        createRoot((dispose) =>
        {
            // First call throws; subsequent calls succeed. Lets us
            // verify reset goes back to the children branch.
            let calls = 0;
            const container = ErrorBoundary({
                fallback: (err, reset) =>
                {
                    const wrap = document.createElement('div');
                    wrap.setAttribute('data-role', 'fallback');
                    const button = document.createElement('button');
                    button.setAttribute('data-role', 'reset');
                    button.textContent = `reset (was: ${ String(err) })`;
                    button.onclick = reset;
                    wrap.appendChild(button);
                    return wrap;
                },
                children: () =>
                {
                    calls++;
                    if (calls === 1)
                    {
                        throw new Error('first');
                    }
                    const div = document.createElement('div');
                    div.setAttribute('data-role', 'child');
                    div.textContent = `attempt ${ calls }`;
                    return div;
                }
            });

            // After construction: fallback shown.
            expect(container.querySelector('[data-role="fallback"]')).not.toBeNull();

            // Click the reset button - boundary should re-attempt
            // children, which now succeeds.
            const button = container.querySelector('[data-role="reset"]') as HTMLButtonElement;
            button.click();

            expect(container.querySelector('[data-role="fallback"]')).toBeNull();
            expect(container.querySelector('[data-role="child"]')).not.toBeNull();
            expect(container.textContent).toBe('attempt 2');

            dispose();
        });
    });

    it('inner ErrorBoundary catches first; outer\'s fallback never appears', () =>
    {
        createRoot((dispose) =>
        {
            const outerFallback = vi.fn((err: unknown) =>
            {
                const p = document.createElement('p');
                p.setAttribute('data-role', 'outer-fallback');
                p.textContent = `outer: ${ String(err) }`;
                return p;
            });
            const innerFallback = vi.fn((err: unknown) =>
            {
                const p = document.createElement('p');
                p.setAttribute('data-role', 'inner-fallback');
                p.textContent = `inner: ${ String(err) }`;
                return p;
            });

            const container = ErrorBoundary({
                fallback: outerFallback,
                children: () => ErrorBoundary({
                    fallback: innerFallback,
                    children: () =>
                    {
                        throw new Error('only-the-inner-sees-me');
                    }
                })
            });

            expect(innerFallback).toHaveBeenCalledOnce();
            expect(outerFallback).not.toHaveBeenCalled();

            expect(container.querySelector('[data-role="inner-fallback"]')).not.toBeNull();
            expect(container.querySelector('[data-role="outer-fallback"]')).toBeNull();

            dispose();
        });
    });

    it('propagates the throw when the fallback itself throws (avoids infinite loops)', () =>
    {
        // The fallback is intentionally NOT wrapped in catchError - a
        // broken fallback would otherwise re-trigger the boundary forever.
        // So when the fallback throws, the throw escapes the boundary instead.
        expect(() =>
        {
            createRoot((dispose) =>
            {
                ErrorBoundary({
                    fallback: () =>
                    {
                        throw new Error('fallback-broken');
                    },
                    children: () =>
                    {
                        throw new Error('child-broken');
                    }
                });
                dispose();
            });
        }).toThrow('fallback-broken');
    });
});
