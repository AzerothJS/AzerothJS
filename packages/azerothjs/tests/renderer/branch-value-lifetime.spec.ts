// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { batch, catchError, createEffect, createRoot, createSignal, ErrorBoundary, h, hydrate, Match,
    onCleanup, render, renderToString, Show, Switch } from 'azerothjs';
import { subscriberCount } from 'azerothjs/internal';

const alpha = { name: 'Alpha' };
const beta = { name: 'Beta' };
const gamma = { name: 'Gamma' };
type Row = typeof alpha;

it('a static button can close two successive showings and still act on the record it closed', () =>
{
    const [selected, select] = createSignal<Row | null>(alpha);
    const handled: Row[] = [];
    const root = document.createElement('div');
    document.body.append(root);
    render(() => Show({ when: selected, children: row => h('button', {
        onClick: () =>
        {
            select(null);
            handled.push(row());
        }
    }, 'Archive') }), root);
    try
    {
        root.querySelector('button')!.click();
        expect(handled).toEqual([alpha]);
        select(beta);
        const reopened = root.querySelector('button')!;
        select(gamma);
        reopened.click();
        expect(handled).toEqual([alpha, gamma]);
        expect(root.querySelector('button')).toBeNull();
    }
    finally
    {
        render(() => h('i', {}), root);
        root.remove();
    }
});

it.each([null, 0, ''])('a branch opened from %j keeps the selected row on its first read in cleanup', initial =>
{
    const [selected, select] = createSignal<Row | typeof initial>(initial);
    const removed: unknown[] = [];
    const root = document.createElement('div');
    render(() => Show({
        when: selected,
        children: row =>
        {
            onCleanup(() => removed.push(row()));
            return h('input', {});
        }
    }), root);
    try
    {
        select(alpha);
        const input = root.querySelector('input')!;
        input.value = 'draft';
        select(beta);
        expect(root.querySelector('input')).toBe(input);
        expect(input.value).toBe('draft');
        select(initial);
        expect(removed).toEqual([beta]);
        expect(root.querySelector('input')).toBeNull();
    }
    finally
    {
        render(() => h('i', {}), root);
    }
});

it.each([true, false])('freezes the last value observed by selection or by a live read inside a batch (pull=%s)', pull =>
{
    const [selected, select] = createSignal<Row | null>(alpha);
    const sample = vi.fn(selected);
    let read!: () => Row;
    const root = document.createElement('div');
    render(() => Show({ when: sample, children: row =>
    {
        read = row;
        return h('b', {});
    } }), root);
    try
    {
        expect(sample).toHaveBeenCalledTimes(1);
        batch(() =>
        {
            select(beta);
            if (pull)
            {
                expect(read()).toBe(beta);
            }
            select(null);
        });
        expect(root.querySelector('b')).toBeNull();
        expect(read()).toBe(pull ? beta : alpha);
        expect(sample).toHaveBeenCalledTimes(pull ? 3 : 2);
    }
    finally
    {
        render(() => h('i', {}), root);
    }
});

it('keeps a showing through a batch when selection never observes the intermediate close', () =>
{
    const [selected, select] = createSignal<Row | null>(alpha);
    const readers: Array<() => Row> = [];
    const root = document.createElement('div');
    render(() => Show({ when: selected, children: row =>
    {
        readers.push(row);
        return h('b', {}, () => row().name);
    } }), root);
    try
    {
        const first = root.firstElementChild;
        batch(() =>
        {
            select(null);
            select(beta);
        });
        expect(root.firstElementChild).toBe(first);
        expect(root.textContent).toBe('Beta');
        expect(readers).toHaveLength(1);
        expect(readers[0]!()).toBe(beta);
    }
    finally
    {
        render(() => h('i', {}), root);
    }
});

it('reading a retired Show accessor in another effect cannot subscribe to a later showing', () =>
{
    const [selected, select] = createSignal<Row | null>(alpha);
    const readers: Array<() => Row> = [];
    const observed: Row[] = [];
    const root = document.createElement('div');
    render(() => Show({ when: selected, children: row =>
    {
        readers.push(row);
        return h('b', {});
    } }), root);
    select(null);
    const stop = createRoot(dispose =>
    {
        createEffect(() =>
        {
            observed.push(readers[0]!());
        });
        return dispose;
    });
    try
    {
        select(beta);
        select(gamma);
        expect(readers).toHaveLength(2);
        expect(readers[0]!()).toBe(alpha);
        expect(readers[1]!()).toBe(gamma);
        expect(observed).toEqual([alpha]);
    }
    finally
    {
        stop();
        render(() => h('i', {}), root);
    }
    expect(subscriberCount(selected)).toBe(0);
});

it('root removal freezes the last selected row even if the branch has never read it', () =>
{
    const [selected, select] = createSignal<Row | null>(alpha);
    const sample = vi.fn(selected);
    let read!: () => Row;
    const root = document.createElement('div');
    render(() => Show({ when: sample, children: row =>
    {
        read = row;
        return h('b', {});
    } }), root);
    select(beta);
    render(() => h('i', {}), root);
    select(gamma);
    expect(read()).toBe(beta);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(subscriberCount(selected)).toBe(0);
});

it('freezes the outgoing accessor before its cleanup opens another showing', () =>
{
    const [selected, select] = createSignal<Row | null>(alpha);
    const removed: Row[] = [];
    const readers: Array<() => Row> = [];
    const root = document.createElement('div');
    render(() => Show({ when: selected, children: row =>
    {
        readers.push(row);
        if (readers.length === 1)
        {
            onCleanup(() =>
            {
                select(gamma);
                removed.push(row());
            });
        }
        return h('b', {});
    } }), root);
    try
    {
        select(beta);
        select(null);
        expect(removed).toEqual([beta]);
        expect(readers).toHaveLength(2);
        expect(readers[0]!()).toBe(beta);
        expect(readers[1]!()).toBe(gamma);
    }
    finally
    {
        render(() => h('i', {}), root);
    }
});

it('retires the accessor when an ownerless Match callback throws', () =>
{
    const [selected, select] = createSignal(alpha);
    const failure = new Error('case failed');
    let read!: () => Row;
    const match = Match({ when: selected, children: row =>
    {
        read = row;
        expect(row()).toBe(alpha);
        throw failure;
    } });
    expect(match.render).toThrow(failure);
    select(beta);
    expect(read()).toBe(alpha);
    expect(subscriberCount(selected)).toBe(0);
});

it('freezes two renderings of the same Match descriptor independently', () =>
{
    const [selected, select] = createSignal(alpha);
    const readers: Array<() => Row> = [];
    const match = Match({ when: selected, children: row =>
    {
        readers.push(row);
        return h('b', {});
    } });
    const mount = () => createRoot(dispose =>
    {
        match.render();
        return dispose;
    });
    const stopFirst = mount();
    const stopSecond = mount();
    try
    {
        stopFirst();
        select(beta);
        expect(readers[0]!()).toBe(alpha);
        expect(readers[1]!()).toBe(beta);
        stopSecond();
        select(gamma);
        expect(readers[0]!()).toBe(alpha);
        expect(readers[1]!()).toBe(beta);
    }
    finally
    {
        stopFirst();
        stopSecond();
    }
    expect(subscriberCount(selected)).toBe(0);
});

it('retires sibling manual matches before the enclosing effect runs its cleanups', () =>
{
    const [enabled, setEnabled] = createSignal(true);
    const [selected, select] = createSignal(alpha);
    const readers: Array<() => Row> = [];
    const earlierCleanup: Row[][] = [];
    const sourceCleanup: Row[][] = [];
    const removed: Row[] = [];
    let inspectSourceDisposal: (() => void) | undefined;
    const match = Match({ when: () =>
    {
        onCleanup(() =>
        {
            const inspect = inspectSourceDisposal;
            inspectSourceDisposal = undefined;
            inspect?.();
        });
        return selected();
    }, children: row =>
    {
        readers.push(row);
        onCleanup(() =>
        {
            select(gamma);
            removed.push(row());
        });
        return h('b', {});
    } });
    const stop = createRoot(dispose =>
    {
        createEffect(() =>
        {
            if (enabled())
            {
                onCleanup(() =>
                {
                    select(gamma);
                    earlierCleanup.push(readers.map(read => read()));
                });
                match.render();
                match.render();
            }
        });
        return dispose;
    });
    try
    {
        select(beta);
        expect(readers.map(read => read())).toEqual([beta, beta]);
        inspectSourceDisposal = () =>
        {
            select(gamma);
            sourceCleanup.push(readers.map(read => read()));
        };
        setEnabled(false);
        expect(earlierCleanup).toEqual([[beta, beta]]);
        expect(sourceCleanup).toEqual([[beta, beta]]);
        expect(removed).toEqual([beta, beta]);
        expect(readers.map(read => read())).toEqual([beta, beta]);
        expect(subscriberCount(selected)).toBe(0);
    }
    finally
    {
        stop();
    }
});

it('a later root cleanup can read the retiring Match without pulling its new source', () =>
{
    const [selected, select] = createSignal(alpha);
    const observed: Row[] = [];
    let read!: () => Row;
    const stop = createRoot(dispose =>
    {
        Match({ when: selected, children: row =>
        {
            read = row;
            return h('b', {});
        } }).render();
        onCleanup(() =>
        {
            select(gamma);
            observed.push(read());
        });
        return dispose;
    });
    select(beta);
    expect(read()).toBe(beta);
    stop();
    expect(observed).toEqual([beta]);
    expect(subscriberCount(selected)).toBe(0);
});

it('retires an unsuccessful fresh Show when a child throws during materialization', () =>
{
    const [selected, select] = createSignal(alpha);
    const failure = new Error('branch content failed');
    const cleaned = vi.fn();
    let read!: () => Row;
    const root = document.createElement('div');
    try
    {
        expect(() => render(() => Show({ when: selected, children: row =>
        {
            read = row;
            onCleanup(cleaned);
            return [() =>
            {
                throw failure;
            }];
        } }), root)).toThrow(failure);
        expect(cleaned).toHaveBeenCalledOnce();
        select(beta);
        expect(read()).toBe(alpha);
    }
    finally
    {
        render(() => h('i', {}), root);
    }
    expect(subscriberCount(selected)).toBe(0);
});

it('retires a failed Show adoption before the client builds its replacement', () =>
{
    const [selected, select] = createSignal(alpha);
    const readers: Array<() => Row> = [];
    const cleaned = vi.fn();
    const root = document.createElement('div');
    root.innerHTML = renderToString(() => Show({ when: selected, children: () => h('i', {}) }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
    {});
    try
    {
        hydrate(() => Show({ when: selected, children: row =>
        {
            readers.push(row);
            onCleanup(cleaned);
            return h('b', {});
        } }), root);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to full client render'));
        expect(root.querySelector('b')).not.toBeNull();
        expect(cleaned).toHaveBeenCalledOnce();
        expect(readers).toHaveLength(2);
        select(beta);
        expect(readers[0]!()).toBe(alpha);
        expect(readers[1]!()).toBe(beta);
    }
    finally
    {
        render(() => h('i', {}), root);
        warn.mockRestore();
    }
    expect(subscriberCount(selected)).toBe(0);
});

describe.each(['render', 'hydrate'])('%s during a write wave', mode =>
{
    it.each(['catchError', 'ErrorBoundary'])('supplies the opened record to queued child work before teardown (%s)', guard =>
    {
        const [selected, select] = createSignal<Row | null>(null);
        const [undo, setUndo] = createSignal(false);
        const names: string[] = [];
        const failures: unknown[] = [];
        const panel = () => Show({ when: selected, children: row =>
        {
            createEffect(() =>
            {
                names.push(row().name);
            });
            return h('b', {});
        } });
        const app = () => h('main', {}, guard === 'ErrorBoundary' ? ErrorBoundary({
            children: panel,
            fallback: err =>
            {
                failures.push(err);
                return h('i', {}, 'failed');
            }
        }) : panel());
        const root = document.createElement('div');
        const stop = createRoot(dispose =>
        {
            catchError(() =>
            {
                if (mode === 'hydrate')
                {
                    root.innerHTML = renderToString(app);
                    const served = root.querySelector('main');
                    hydrate(app, root);
                    expect(root.querySelector('main')).toBe(served);
                }
                else
                {
                    render(app, root);
                }
                createEffect(() =>
                {
                    if (undo())
                    {
                        select(null);
                    }
                });
            }, error => failures.push(error));
            return dispose;
        });
        try
        {
            batch(() =>
            {
                select(alpha);
                setUndo(true);
            });
            expect(names).toEqual(['Alpha']);
            expect(failures).toEqual([]);
            expect(root.textContent).toBe('');
            expect(root.querySelector('b')).toBeNull();
        }
        finally
        {
            render(() => h('i', {}), root);
            stop();
        }
    });
});

it('a lower-priority Match stays lazy, takes the same number of samples on SSR and hydration, and freezes after losing', () =>
{
    const [higher, setHigher] = createSignal(false);
    const [selected, select] = createSignal<Row>(alpha);
    const sample = vi.fn(() =>
    {
        if (higher())
        {
            throw new Error('inactive case evaluated');
        }
        return selected();
    });
    const readers: Array<() => Row> = [];
    const app = () => h('main', {}, Switch({ children: [
        Match({ when: higher, children: () => h('i', {}, 'higher') }),
        Match({ when: sample, children: row =>
        {
            readers.push(row);
            return h('b', {}, 'lower');
        } })
    ] }));
    const root = document.createElement('div');
    root.innerHTML = renderToString(app);
    const serverSamples = sample.mock.calls.length;
    expect(serverSamples).toBe(1);
    const served = root.querySelector('b');
    readers.length = 0;
    sample.mockClear();
    hydrate(app, root);
    try
    {
        expect(root.querySelector('b')).toBe(served);
        expect(sample).toHaveBeenCalledTimes(serverSamples);
        sample.mockClear();
        setHigher(true);
        select(beta);
        expect(readers[0]!()).toBe(alpha);
        expect(sample).not.toHaveBeenCalled();
        setHigher(false);
        expect(readers).toHaveLength(2);
        expect(readers[0]!()).toBe(alpha);
        expect(readers[1]!()).toBe(beta);
    }
    finally
    {
        render(() => h('i', {}), root);
    }
});
