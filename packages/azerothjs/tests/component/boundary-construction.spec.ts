// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { componentScope, createEffect, createMemo, createRoot, createSignal, ErrorBoundary,
    h, hydrate, type MountNode, onCleanup, onUncaughtError, render, renderToString } from 'azerothjs';

const container = document.createElement('div');

beforeEach(() => document.body.append(container));

afterEach(() =>
{
    render(() => h('div', null), container);
    container.remove();
});

describe('manual ErrorBoundary construction', () =>
{
    it.each(['children', 'fallback'])('isolates setup reads while resolving a thunk returned by %s', branch =>
    {
        const [caption, setCaption] = createSignal('first');
        const built = vi.fn();
        // co-range resolves the extra getter emitted for a markup callback. The public
        // signature describes its resolved MountNode, so model this runtime form explicitly.
        const deferred = (() => () =>
        {
            built();
            return h('label', null, h('input', null), h('b', null, caption()), h('i', null, caption));
        }) as unknown as () => MountNode;
        render(() => ErrorBoundary({
            children: branch === 'children' ? deferred : () =>
            {
                throw new Error('retry');
            },
            fallback: deferred
        }), container);
        const input = container.querySelector('input')!;
        input.value = 'draft';
        setCaption('second');
        expect([built.mock.calls.length, container.querySelector('b')?.textContent,
            container.querySelector('i')?.textContent]).toEqual([1, 'first', 'second']);
        expect(container.querySelector('input')).toBe(input);
        expect(input.value).toBe('draft');
    });

    it.each(['render', 'hydrate'])('keeps a setup snapshot and a focused draft after %s until reset', mode =>
    {
        const [name, setName] = createSignal<string | null>('oak');
        const [failed, setFailed] = createSignal(false);
        const built = vi.fn();
        const cleaned = vi.fn();
        const app = () => h('main', null, ErrorBoundary({
            children: () =>
            {
                built();
                onCleanup(cleaned);
                const initial = name();
                if (initial === null)
                {
                    throw new Error('missing at setup');
                }
                createEffect(() =>
                {
                    if (failed())
                    {
                        throw new Error('effect failed');
                    }
                });
                return h('label', null, h('input', null), h('b', null, initial), h('i', null, () => name()));
            },
            fallback: (error, reset) => h('button', { onClick: reset }, (error as Error).message)
        }));
        if (mode === 'hydrate')
        {
            container.innerHTML = renderToString(app);
            const main = container.querySelector('main');
            const servedInput = container.querySelector('input');
            expect(container.textContent).toBe('oakoak');
            expect(servedInput).toBeInstanceOf(HTMLInputElement);
            hydrate(app, container);
            expect(container.querySelector('main')).toBe(main);
            // ErrorBoundary adopts the surrounding page and rebuilds its own content once.
            expect(container.querySelector('input')).not.toBe(servedInput);
        }
        else
        {
            render(app, container);
        }
        const buildsAtMount = built.mock.calls.length;
        const cleanupsAtMount = cleaned.mock.calls.length;
        const input = container.querySelector('input')!;
        input.value = 'draft in progress';
        input.focus();
        input.setSelectionRange(2, 5);
        setName('ash');
        expect([built.mock.calls.length - buildsAtMount, cleaned.mock.calls.length - cleanupsAtMount,
            container.querySelector('b')?.textContent, container.querySelector('i')?.textContent])
            .toEqual([0, 0, 'oak', 'ash']);
        setName(null);
        expect(container.querySelector('input')).toBe(input);
        expect(document.activeElement).toBe(input);
        expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['draft in progress', 2, 5]);
        setFailed(true);
        expect(container.querySelector('button')?.textContent).toBe('effect failed');
        expect(cleaned).toHaveBeenCalledTimes(cleanupsAtMount + 1);
        setFailed(false);
        container.querySelector('button')!.click();
        expect(container.querySelector('button')?.textContent).toBe('missing at setup');
        setName('elm');
        container.querySelector('button')!.click();
        expect(container.textContent).toBe('elmelm');
        expect(built).toHaveBeenCalledTimes(buildsAtMount + 2);
        render(() => h('div', null), container);
        expect(cleaned).toHaveBeenCalledTimes(cleanupsAtMount + 3);
    });

    it('delivers a deferred memo error to the nearest boundary and disposes its observers', () =>
    {
        const [count, setCount] = createSignal(1);
        const observed = vi.fn();
        render(() => ErrorBoundary({
            children: () =>
            {
                const doubled = createMemo(() =>
                {
                    const n = count();
                    observed(n);
                    if (n < 0)
                    {
                        throw new Error('negative');
                    }
                    return n * 2;
                });
                return h('b', null, doubled);
            },
            fallback: (error, reset) => h('button', { onClick: reset }, (error as Error).message)
        }), container);
        setCount(2);
        expect(container.textContent).toBe('4');
        setCount(-1);
        expect(container.querySelector('button')?.textContent).toBe('negative');
        setCount(3);
        expect(observed.mock.calls.flat()).toEqual([1, 2, -1]);
        container.querySelector('button')!.click();
        expect(container.textContent).toBe('6');
        render(() => h('div', null), container);
        setCount(4);
        expect(observed.mock.calls.flat()).toEqual([1, 2, -1, 3]);
    });

    it('retains a manual fallback with a setup snapshot until retry', () =>
    {
        const [message, setMessage] = createSignal('first');
        let shouldFail = true;
        const mountFallback = vi.fn();
        render(() => ErrorBoundary({
            children: () =>
            {
                if (shouldFail)
                {
                    throw new Error('try again');
                }
                return h('b', null, 'available');
            },
            fallback: (error, reset) =>
            {
                mountFallback();
                const first = message();
                return h('section', null, h('input', null), h('b', null, first), h('i', null, message),
                    h('button', { onClick: reset }, (error as Error).message));
            }
        }), container);
        const input = container.querySelector('input')!;
        input.value = 'report';
        input.focus();
        setMessage('second');
        expect([mountFallback.mock.calls.length, container.querySelector('b')?.textContent,
            container.querySelector('i')?.textContent]).toEqual([1, 'first', 'second']);
        expect(document.activeElement).toBe(input);
        expect(container.querySelector('input')?.value).toBe('report');
        shouldFail = false;
        container.querySelector('button')!.click();
        expect(container.textContent).toBe('available');
    });

    it.each(['setup', 'effect'])('disposes a partial fallback when it throws after a child %s error', origin =>
    {
        const [fault, setFault] = createSignal(false);
        const [pulse, setPulse] = createSignal(0);
        const observed = vi.fn();
        const cleaned = vi.fn();
        render(() => ErrorBoundary({
            fallback: error => h('b', null, (error as Error).message),
            children: () => ErrorBoundary({
                children: () =>
                {
                    if (origin === 'setup')
                    {
                        throw new Error('setup failed');
                    }
                    createEffect(() =>
                    {
                        if (fault())
                        {
                            throw new Error('effect failed');
                        }
                    });
                    return h('input', null);
                },
                fallback: () =>
                {
                    onCleanup(cleaned);
                    createEffect(() =>
                    {
                        observed(pulse());
                    });
                    throw new Error('fallback failed');
                }
            })
        }), container);
        if (origin === 'effect')
        {
            expect(container.querySelector('input')).toBeInstanceOf(HTMLInputElement);
            setFault(true);
        }
        expect(container.textContent).toBe('fallback failed');
        setPulse(1);
        render(() => h('div', null), container);
        setPulse(2);
        // A late fault happens during a flush. Its new observer is queued, then disposed
        // before the queue reaches it. During initial construction it already ran once.
        expect([cleaned.mock.calls.length, observed.mock.calls.flat()]).toEqual([1, origin === 'setup' ? [0] : []]);
    });

    it.each([false, true])('rolls back a failed fallback before the global error handler (cleanup throws=%s)', doubleFault =>
    {
        const [pulse, setPulse] = createSignal(0);
        const setupError = new Error('fallback construction');
        const cleanupError = new Error('fallback cleanup');
        const observed = vi.fn();
        const cleaned = vi.fn();
        const captured: unknown[] = [];
        let cleanupsBeforeReport = 0;
        const uninstall = onUncaughtError(error =>
        {
            cleanupsBeforeReport = cleaned.mock.calls.length;
            captured.push(error);
        });
        try
        {
            render(() => ErrorBoundary({
                children: () =>
                {
                    throw new Error('child');
                },
                fallback: () =>
                {
                    onCleanup(() =>
                    {
                        cleaned();
                        if (doubleFault)
                        {
                            throw cleanupError;
                        }
                    });
                    createEffect(() =>
                    {
                        observed(pulse());
                    });
                    throw setupError;
                }
            }), container);
            expect(captured).toHaveLength(1);
            if (doubleFault)
            {
                expect(captured[0]).toBeInstanceOf(AggregateError);
                expect((captured[0] as AggregateError).errors).toEqual([setupError, cleanupError]);
            }
            else
            {
                expect(captured[0]).toBe(setupError);
            }
            setPulse(1);
            expect([cleanupsBeforeReport, cleaned.mock.calls.length, observed.mock.calls.flat()]).toEqual([1, 1, [0]]);
            render(() => h('div', null), container);
            expect(cleaned).toHaveBeenCalledOnce();
        }
        finally
        {
            uninstall();
        }
    });

    it('lets an explicit memo of raw server HTML track synchronous child and fallback reads', () =>
    {
        const [name, setName] = createSignal<string | null>('oak');
        const [message, setMessage] = createSignal('absent');
        const dispose = createRoot(stop =>
        {
            const html = createMemo(() => renderToString(() => ErrorBoundary({
                children: () =>
                {
                    const value = name();
                    if (value === null)
                    {
                        throw new Error('missing');
                    }
                    return h('b', null, value);
                },
                fallback: () => h('i', null, message())
            })));
            expect(html()).toContain('<b>oak</b>');
            setName(null);
            expect(html()).toContain('<i>absent</i>');
            setMessage('gone');
            expect(html()).toContain('<i>gone</i>');
            return stop;
        });
        dispose();
    });
});

it('restores outer tracking and cleanup after component construction throws', () =>
{
    const [setup, setSetup] = createSignal(0);
    const [after, setAfter] = createSignal(0);
    const [rootRead, setRootRead] = createSignal(0);
    const outer = vi.fn();
    const childCleanup = vi.fn();
    const outerCleanup = vi.fn();
    const dispose = createRoot(stop =>
    {
        createEffect(() =>
        {
            expect(() => componentScope(() =>
            {
                setup();
                onCleanup(childCleanup);
                throw new Error('construction');
            })).toThrow('construction');
            // A createRoot inside an effect still passes the subscriber through.
            createRoot(disposeInner =>
            {
                rootRead();
                disposeInner();
            });
            onCleanup(outerCleanup);
            outer(after());
        });
        return stop;
    });
    try
    {
        setSetup(1);
        setAfter(1);
        setRootRead(1);
        expect(outer.mock.calls.flat()).toEqual([0, 1, 1]);
        expect(childCleanup).toHaveBeenCalledTimes(2);
        expect(outerCleanup).toHaveBeenCalledTimes(2);
    }
    finally
    {
        dispose();
    }
    setAfter(2);
    expect(outer).toHaveBeenCalledTimes(3);
    expect(childCleanup).toHaveBeenCalledTimes(3);
    expect(outerCleanup).toHaveBeenCalledTimes(3);
});
