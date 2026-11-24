// @vitest-environment happy-dom
//
// The <Show> value-callback form: `<Show when={value()}>{(value) => ...}</Show>` passes the children an
// ACCESSOR to the narrowed, non-nullish `when` value. This replaces the snapshot-IIFE pattern
// (`{(() => { const x = thing()!; return ...; })()}`) - the accessor stays reactive, never yields null
// while the branch is mounted, and the branch is NOT rebuilt when the value changes (only on a
// truthy<->falsy flip). The plain thunk form keeps its original contract (see show.spec.ts).
import { describe, it, expect } from 'vitest';
import { batch, catchError, createSignal, createEffect, createMemo, createRoot, onCleanup, onUncaughtError, h, render, hydrate, Show, renderToString, untrack } from 'azerothjs';
import { subscriberCount } from 'azerothjs/internal';

interface User { name: string }

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

function ssrInto(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    container.innerHTML = renderToString(component);
    document.body.appendChild(container);
    return container;
}

describe('Show value-callback', () =>
{
    it('shares one condition sample with the branch on mount, invalidation and re-entry', () =>
    {
        const [key, setKey] = createSignal<string | null>('A');
        const [extra, setExtra] = createSignal(0);
        const samples: Array<string | null> = [];
        const removed: string[] = [];
        const root = mount(() => h('section', {}, Show({
            when: () =>
            {
                const name = key();
                samples.push(name);
                return name === null ? null : { name, revision: samples.length };
            },
            children: value =>
            {
                onCleanup(() => removed.push(value().name));
                return h('label', {}, h('input', {}), h('b', {}, () => `${ value().name }:${ value().revision }:${ extra() }`));
            }
        })));
        try
        {
            const original = root.querySelector('input')!;
            original.value = 'draft';
            expect(root.textContent).toBe('A:1:0');
            setExtra(1);
            expect(root.textContent).toBe('A:1:1');
            batch(() =>
            {
                setKey('unused');
                setKey('B');
            });
            expect(root.textContent).toBe('B:2:1');
            expect(root.querySelector('input')).toBe(original);
            expect(original.value).toBe('draft');
            setKey(null);
            expect(root.querySelector('input')).toBeNull();
            expect(removed).toEqual(['B']);
            setKey('C');
            expect(root.textContent).toBe('C:4:1');
            expect(root.querySelector('input')).not.toBe(original);
            expect(samples).toEqual(['A', 'B', null, 'C']);
        }
        finally
        {
            render(() => h('div', {}), root);
            root.remove();
        }
    });

    it('leaves the enclosing factory independent of the initial condition', () =>
    {
        const [name, setName] = createSignal('A');
        const values: string[] = [];
        let builds = 0;
        const stop = createRoot(dispose =>
        {
            createEffect(() =>
            {
                builds++;
                Show({
                    when: name,
                    children: value =>
                    {
                        createEffect(() =>
                        {
                            values.push(value());
                        });
                        return h('b', {});
                    }
                });
            });
            return dispose;
        });
        try
        {
            setName('B');
            expect(builds).toBe(1);
            expect(values).toEqual(['A', 'B']);
        }
        finally
        {
            stop();
        }
    });

    it.each(['scope', 'global hook'])('preserves synchronous setup control flow for an initial condition error with a %s', scope =>
    {
        const failure = new Error('condition unavailable');
        const seen: unknown[] = [];
        const report = (error: unknown): void =>
        {
            seen.push(error);
        };
        const stop = createRoot(dispose =>
        {
            const run = (): void =>
            {
                Show<number>({
                    when: () =>
                    {
                        throw failure;
                    },
                    fallback: () =>
                    {
                        seen.push('fallback'); return h('i', {});
                    },
                    children: value => h('b', {}, value)
                });
                seen.push('after Show');
            };
            if (scope === 'scope')
            {
                catchError(run, report);
            }
            else
            {
                const unregister = onUncaughtError(report);
                try
                {
                    expect(run).toThrow(failure);
                }
                finally
                {
                    unregister();
                }
            }
            return dispose;
        });
        stop();
        expect(seen).toEqual(scope === 'scope' ? [failure] : []);
    });

    it('can render a fallback for a public memo that reported an initial error and later recovers', () =>
    {
        const [name, setName] = createSignal<string | null>(null);
        const failure = new Error('no initial profile');
        const seen: unknown[] = [];
        const root = document.createElement('div');
        try
        {
            catchError(() => render(() =>
            {
                const profile = createMemo(() =>
                {
                    const value = name();
                    if (value === null)
                    {
                        throw failure;
                    }
                    return value;
                });
                return Show({ when: profile, fallback: () => h('i', {}, 'waiting'), children: value => h('b', {}, value) });
            }, root), error =>
            {
                seen.push(error);
            });
            expect(seen).toEqual([failure]);
            expect(root.textContent).toBe('waiting');
            setName('ready');
            expect(root.textContent).toBe('ready');
        }
        finally
        {
            render(() => h('i', {}), root);
        }
    });

    it('preserves ownership of cleanup registered when a public condition memo is pulled', () =>
    {
        const [name, setName] = createSignal('A');
        let cleaned = 0;
        const root = document.createElement('div');
        const stop = createRoot(dispose =>
        {
            const profile = createMemo(() =>
            {
                const current = name();
                if (current === 'A')
                {
                    onCleanup(() => onCleanup(() =>
                    {
                        cleaned++;
                    }));
                }
                return current;
            });
            render(() => Show({ when: profile, children: value => h('b', {}, value) }), root);
            batch(() =>
            {
                setName('B');
                // Explicitly pull while the outer root owns this call. A cleanup
                // registered by the outgoing computation survives until that root closes.
                expect(profile()).toBe('B');
            });
            return dispose;
        });
        try
        {
            expect(root.textContent).toBe('B');
            expect(cleaned).toBe(0);
        }
        finally
        {
            stop();
            render(() => h('i', {}), root);
        }
        expect(cleaned).toBe(1);
    });

    it('disposes work started by a failed first sample while its enclosing root remains alive', () =>
    {
        const [tick, setTick] = createSignal(0);
        const failure = new Error('slot setup failed');
        const calls: number[] = [];
        let cleaned = 0;
        const stop = createRoot(dispose =>
        {
            expect(() => Show<number>({
                when: () =>
                {
                    createEffect(() =>
                    {
                        calls.push(tick());
                    });
                    onCleanup(() =>
                    {
                        cleaned++;
                    });
                    throw failure;
                },
                children: value => h('b', {}, value)
            })).toThrow(failure);
            return dispose;
        });
        try
        {
            setTick(1);
            expect([calls, cleaned]).toEqual([[0], 1]);
        }
        finally
        {
            stop();
        }
        expect(cleaned).toBe(1);
    });

    it('preserves the setup error and completes rollback when a condition cleanup also throws', async () =>
    {
        const [tick, setTick] = createSignal(0);
        const setupFailure = new Error('slot setup failed');
        const cleanupFailure = new Error('slot cleanup failed');
        const seen: unknown[] = [];
        const calls: number[] = [];
        let cleaned = 0;
        const stop = createRoot(dispose =>
        {
            catchError(() => Show<number>({
                when: () =>
                {
                    tick();
                    createEffect(() =>
                    {
                        calls.push(tick());
                    });
                    onCleanup(() =>
                    {
                        throw cleanupFailure;
                    });
                    onCleanup(() =>
                    {
                        cleaned++;
                    });
                    throw setupFailure;
                },
                children: value => h('b', {}, value)
            }), error =>
            {
                seen.push(error);
            });
            return dispose;
        });
        try
        {
            expect(seen).toEqual([setupFailure]);
            await Promise.resolve();
            expect(seen).toEqual([setupFailure, cleanupFailure]);
            expect(cleaned).toBe(1);
            expect(subscriberCount(tick)).toBe(0);
        }
        finally
        {
            stop();
        }
        setTick(1);
        expect(calls).toEqual([0]);
        expect(seen).toHaveLength(2);
    });

    it('reports a cleanup error from a failed first sample as a memo to the global hook', async () =>
    {
        const setupFailure = new Error('slot setup failed');
        const cleanupFailure = new Error('slot cleanup failed');
        const reported: Array<[unknown, string]> = [];
        const unregister = onUncaughtError((error, info) =>
        {
            reported.push([error, info.source]);
        });
        let thrown: unknown;
        try
        {
            try
            {
                Show<number>({
                    when: () =>
                    {
                        onCleanup(() =>
                        {
                            throw cleanupFailure;
                        });
                        throw setupFailure;
                    },
                    children: value => h('b', {}, value)
                });
            }
            catch (error)
            {
                thrown = error;
            }
            expect(thrown).toBe(setupFailure);
            expect(reported).toHaveLength(0);
            await Promise.resolve();
            expect(reported).toHaveLength(1);
            expect(reported[0]?.[0]).toBe(cleanupFailure);
            expect(reported[0]?.[1]).toBe('memo');
        }
        finally
        {
            unregister();
        }
    });

    it.each(['scope', 'global hook'])('reports a later failed condition sample once to its %s and recovers on the next value', scope =>
    {
        const [name, setName] = createSignal('A');
        const failure = new Error('profile unavailable');
        const seen: unknown[] = [];
        const samples: string[] = [];
        const report = (error: unknown): void =>
        {
            seen.push(error);
        };
        const app = () => Show<string>({
            when: () =>
            {
                const value = name();
                samples.push(value);
                if (value === 'bad')
                {
                    throw failure;
                }
                return value;
            },
            children: value => h('b', {}, value)
        });
        const unregister = scope === 'global hook' ? onUncaughtError(report) : undefined;
        const root = document.createElement('div');
        try
        {
            if (scope === 'scope')
            {
                catchError(() => render(app, root), report);
            }
            else
            {
                render(app, root);
            }
            const original = root.querySelector('b');
            setName('bad');
            expect(root.textContent).toBe('A');
            setName('B');
            expect(root.textContent).toBe('B');
            expect(root.querySelector('b')).toBe(original);
            expect(seen).toEqual([failure]);
            expect(samples).toEqual(['A', 'bad', 'B']);
        }
        finally
        {
            render(() => h('i', {}), root);
            unregister?.();
        }
    });

    it('null -> value: builds the callback branch with the narrowed accessor', () =>
    {
        const [user, setUser] = createSignal<User | null>(null);
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            fallback: () => h('p', { class: 'fb' }, 'none'),
            children: (u) => h('span', {}, () => u().name)
        })));
        expect(c.querySelector('.fb')).not.toBeNull();
        expect(c.querySelector('span')).toBeNull();

        setUser({ name: 'Ann' });
        expect(c.querySelector('.fb')).toBeNull();
        expect(c.querySelector('span')!.textContent).toBe('Ann');
        c.remove();
    });

    it('value change (stays truthy): updates reactively WITHOUT rebuilding the branch', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        let builds = 0;
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) =>
            {
                builds++;
                return h('span', {}, () => u().name);
            }
        })));
        const span = c.querySelector('span')!;
        expect(builds).toBe(1);
        expect(span.textContent).toBe('Ann');

        setUser({ name: 'Bob' });
        expect(builds).toBe(1);                 // branch NOT rebuilt
        expect(c.querySelector('span')).toBe(span); // same DOM node (focus/scroll preserved)
        expect(span.textContent).toBe('Bob');   // accessor updated reactively
        c.remove();
    });

    it('value -> null: tears down the branch with NO null-deref (the IIFE-replacement guarantee)', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            // `u().name` would throw if the accessor ever yielded null during teardown.
            children: (u) => h('span', {}, () => u().name)
        })));
        expect(c.querySelector('span')).not.toBeNull();

        expect(() => setUser(null)).not.toThrow();
        expect(c.querySelector('span')).toBeNull();
        expect(c.textContent).toBe('');
        c.remove();
    });

    it('toggling back and forth rebuilds cleanly each time', () =>
    {
        const [user, setUser] = createSignal<User | null>(null);
        let builds = 0;
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) =>
            {
                builds++; return h('span', {}, () => u().name);
            }
        })));
        expect(builds).toBe(0);
        setUser({ name: 'A' });
        expect(builds).toBe(1);
        setUser(null);
        expect(c.querySelector('span')).toBeNull();
        setUser({ name: 'B' });
        expect(builds).toBe(2);
        expect(c.querySelector('span')!.textContent).toBe('B');
        c.remove();
    });

    it('disposes the branch effects on teardown (no leak)', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        const [tick] = createSignal(0);
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) => h('span', {}, () =>
            {
                tick(); // subscribe an inner effect to `tick`
                return u().name;
            })
        })));
        expect(subscriberCount(tick)).toBe(1);
        setUser(null);                       // tear the branch down
        expect(subscriberCount(tick)).toBe(0); // its effects unsubscribed
        c.remove();
    });

    it('onCleanup inside the callback branch runs on teardown', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        let cleaned = 0;
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) =>
            {
                createEffect(() =>
                {
                    onCleanup(() =>
                    {
                        cleaned++;
                    });
                });
                return h('span', {}, () => u().name);
            }
        })));
        expect(cleaned).toBe(0);
        setUser(null);
        expect(cleaned).toBe(1);
        c.remove();
    });

    it('nested value-callback Shows narrow independently', () =>
    {
        const [outer, setOuter] = createSignal<User | null>({ name: 'Out' });
        const [inner, setInner] = createSignal<User | null>(null);
        const c = mount(() => h('div', {}, Show<User | null>({
            when: outer,
            children: (o) => h('section', {},
                h('h1', {}, () => o().name),
                Show<User | null>({
                    when: inner,
                    children: (i) => h('span', { class: 'inner' }, () => `${ o().name }/${ i().name }`)
                })
            )
        })));
        expect(c.querySelector('h1')!.textContent).toBe('Out');
        expect(c.querySelector('.inner')).toBeNull();

        setInner({ name: 'In' });
        expect(c.querySelector('.inner')!.textContent).toBe('Out/In');

        setOuter({ name: 'Out2' });
        expect(c.querySelector('.inner')!.textContent).toBe('Out2/In'); // both accessors reactive, no rebuild
        c.remove();
    });

    it('a plain thunk child still works alongside the callback form (backward compatible)', () =>
    {
        const [on, setOn] = createSignal(true);
        const c = mount(() => h('div', {}, Show({
            when: on,
            children: () => h('p', {}, 'plain')   // arity-0 thunk: ignores the accessor
        })));
        expect(c.querySelector('p')!.textContent).toBe('plain');
        setOn(false);
        expect(c.querySelector('p')).toBeNull();
        c.remove();
    });

    it('SSR: serializes the callback branch with the evaluated value', () =>
    {
        const App = (): HTMLElement => h('div', {}, Show<User | null>({
            when: () => ({ name: 'Server' }),
            children: (u) => h('span', {}, () => u().name)
        }));
        const html = renderToString(App);
        expect(html).toContain('Server');
    });

    it('hydration: adopts the server callback branch, then stays reactive', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        const App = (): HTMLElement => h('div', {}, Show<User | null>({
            when: user,
            children: (u) => h('span', {}, () => u().name)
        }));
        const container = ssrInto(App);
        const serverSpan = container.querySelector('span')!;
        expect(serverSpan.textContent).toBe('Ann');

        hydrate(App, container);
        expect(container.querySelector('span')).toBe(serverSpan); // adopted, not rebuilt

        setUser({ name: 'Bob' });
        expect(container.querySelector('span')!.textContent).toBe('Bob'); // reactive after hydrate
        container.remove();
    });

    // A value-callback Show whose HOST is built during a write wave - inside another
    // Show's branch flipped after mount, a Transition enter, a late <For> row. Effects
    // created mid-wave defer their first run while memos subscribe eagerly at creation,
    // so nothing may depend on the notification order between the narrowed accessor's
    // machinery and the truthy memo: the accessor must be correct AT THE READ. This is
    // the shape that shipped as a crash in 2.0.0-beta.1 (found live in Guardian's import
    // sheet); every earlier test in this file mounts the Show directly and cannot see it.
    it('constructed during a write wave: the branch still gets the real value, not the seed', () =>
    {
        const [outer, setOuter] = createSignal(false);
        const [done, setDone] = createSignal(false);
        const [report, setReport] = createSignal<User | null>(null);

        const seen: Array<User | null> = [];

        const c = mount(() => h('div', {}, Show({
            when: outer,
            children: () => h('section', {}, Show<User | null>({
                when: () => (done() ? report() : null),
                children: (u) =>
                {
                    seen.push(untrack(() => u()));
                    return h('span', {}, () => u().name);
                }
            }))
        })));

        // The inner Show is constructed DURING this write's notification wave.
        setOuter(true);
        expect(c.querySelector('section')).not.toBeNull();

        // The fixtures' own order: value first, then the flag.
        setReport({ name: 'Real' });
        setDone(true);

        expect(seen).toEqual([{ name: 'Real' }]);
        expect(c.querySelector('span')!.textContent).toBe('Real');
    });

    it('keeps the last truthy value through the falsy flip, and yields the new one on re-entry', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'First' });

        let accessor: (() => User) | null = null;

        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) =>
            {
                accessor = u;
                return h('span', {}, () => u().name);
            }
        })));

        expect(c.querySelector('span')!.textContent).toBe('First');

        // Falsy flip: the branch tears down; the accessor must still answer with the
        // LAST truthy value for anything validating during the teardown window.
        setUser(null);
        expect(c.querySelector('span')).toBeNull();
        expect(untrack(() => accessor!())).toEqual({ name: 'First' });

        // Re-entry with a new value must yield the new one, never the latch.
        setUser({ name: 'Second' });
        expect(c.querySelector('span')!.textContent).toBe('Second');
    });
});
