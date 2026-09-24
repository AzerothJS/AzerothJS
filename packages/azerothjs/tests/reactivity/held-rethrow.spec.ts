// @vitest-environment happy-dom
//
// A read that fails on a value the same flush clears, in a branch that flush closes, does not throw
// from the write. A handled error still reaches its handler in place; a real failure still throws.
import { describe, it, expect } from 'vitest';
import {
    h,
    render,
    Show,
    For,
    ErrorBoundary,
    Transition,
    TransitionGroup,
    Routes,
    hydrate,
    renderToString,
    createSignal,
    createEffect,
    createMemo,
    createRoot,
    createResource,
    createStream,
    createMutation,
    createForm,
    createRouter,
    createMemoryHistory,
    cached,
    catchError,
    onCleanup,
    onUncaughtError,
    batch,
    type Stream
} from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const attempt = (fn: () => void): string =>
{
    try
    {
        fn();
        return '';
    }
    catch (error)
    {
        return ' THREW ' + (error as Error).message;
    }
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function mount(view: () => unknown): HTMLElement
{
    const host = document.createElement('div');
    render(view as never, host);
    return host;
}

/**
 * A Show over `when` whose branch reads user; the effect that writes `when` subscribed after
 * the hole.
 */
function youngerWriter(user: () => { name: string } | null): HTMLElement
{
    const [shown, setShown] = createSignal(true);
    const host = mount(() => h('div', null, Show({ when: shown, fallback: () => h('i', null, 'out'), children: () => h('b', null, () => user()!.name) })));
    createRoot(() => createEffect(() =>
    {
        setShown(user() !== null);
    }));
    return host;
}

/** Runs `fn` once, the first time `cond` holds, from an effect that stops itself first. */
function once(cond: () => boolean, fn: () => void): void
{
    let done = false;
    const handle = { stop: (): void => undefined };
    handle.stop = createEffect(() =>
    {
        if (!done && cond())
        {
            done = true;
            handle.stop();
            fn();
        }
    });
}

/** An effect that closes the branch it sits in, then fails. */
function closesItself(status: () => number, setOpen: (v: boolean) => void): void
{
    createEffect(() =>
    {
        if (status() === 1)
        {
            setOpen(false);
            throw new Error('onDone bug');
        }
    });
}

/** A root whose effect holds a closesItself child while open, and logs 'closed' once it closes. */
function closingBranch(status: () => number, log: string[]): void
{
    const [open, setOpen] = createSignal(true);
    createRoot(() => createEffect(() =>
    {
        if (open())
        {
            closesItself(status, setOpen);
        }
        else
        {
            log.push('closed');
        }
    }));
}

/** Two effects: the first writes a signal the second reads once `status` is 1. */
function queuesAnother(status: () => number): void
{
    const [u, setU] = createSignal(0);
    createRoot(() =>
    {
        createEffect(() =>
        {
            if (status() === 1)
            {
                setU(1);
            }
        });
        createEffect(() =>
        {
            u();
        });
    });
}

interface Item
{
    id: number;
    name: string;
}

const failing = (): Promise<Response> => Promise.reject(new Error('net'));

/** A Show a stream's settle closes, whose hole reads the error the settle sets. */
function streamReader(stream: Stream): HTMLElement
{
    return mount(() => h('div', null, Show({
        when: () => !stream.done(),
        fallback: () => h('i', null, 'ended'),
        children: () => h('b', null, () => (stream.error() === null ? 'streaming' : (stream.error() as { nope: { x: string } }).nope.x))
    })));
}

describe('a read on a closing branch does not throw from the write', () =>
{
    it('a batch writes a signal the branch reads, then clears when', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [mark, setMark] = createSignal('');
        const host = mount(() => h('div', null, Show({ when: user, children: () => h('b', null, () => user()!.name + mark()) })));
        const seen = [host.textContent];
        seen.push(attempt(() => batch(() =>
        {
            setMark('!');
            setUser(null);
        })) + host.textContent);
        seen.push(attempt(() => batch(() =>
        {
            setMark('?');
            setUser({ name: 'bob' });
        })) + host.textContent);
        expect(seen.join(' > ')).toBe('ann >  > bob?');
    });

    it('the branch is a hole that owns it', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [mark, setMark] = createSignal('');
        const host = mount(() => h('div', null, () => (user() ? h('b', null, () => user()!.name + mark()) : 'none')));
        const r = attempt(() => batch(() =>
        {
            setMark('!');
            setUser(null);
        }));
        expect(r + host.textContent).toBe('none');
    });

    it('an effect clears when and the swap waits for the next round', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [go, setGo] = createSignal(0);
        const [mark, setMark] = createSignal('');
        const host = mount(() => h('div', null, Show({ when: user, children: () => h('b', null, () => user()!.name + mark()) })));
        createRoot(() => createEffect(() =>
        {
            if (go() === 1)
            {
                setUser(null);
            }
        }));
        // The writer runs before the hole, so the hole reads null and the swap is queued behind it.
        const r = attempt(() => batch(() =>
        {
            setGo(1);
            setMark('!');
        }));
        expect(r + host.textContent).toBe('');
    });

    it('the swap waits alone, then a later effect spills it into the queue before the round settles', () =>
    {
        for (const batched of [false, true])
        {
            const [a, setA] = createSignal<{ x: string } | null>({ x: 'ann' });
            const [show, setShow] = createSignal(true);
            const [count, setCount] = createSignal(0);
            createRoot(() => createEffect(() =>
            {
                setShow(a() !== null);
            }));
            const host = mount(() => h('div', null, Show({ when: show, children: () => h('b', null, () => a()!.x) }), h('i', null, () => String(count()))));
            createRoot(() => createEffect(() =>
            {
                setCount(a() === null ? 1 : 0);
            }));
            const r = attempt(() => (batched ? batch(() => setA(null)) : setA(null)));
            expect(r + host.textContent).toBe('1');
        }
    });

    it('the owner waits alone, a failure is held behind it, and a later write moves it into the queue', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [c, setC] = createSignal(0);
        const [d, setD] = createSignal(0);
        const [p, setP] = createSignal(0);
        const [q, setQ] = createSignal(0);
        createRoot(() =>
        {
            createEffect(() =>
            {
                log.push(`A${ a() }`);
                if (a() === 1)
                {
                    setP(1);
                }
            });
            createEffect(() =>
            {
                const v = p();
                log.push(`X${ v }`);
                if (v !== 0)
                {
                    return;
                }
                createEffect(() =>
                {
                    log.push(`B${ b() }`);
                    if (b() === 1)
                    {
                        throw new Error('tornB');
                    }
                });
                createEffect(() =>
                {
                    log.push(`D${ d() }`);
                    if (d() === 1)
                    {
                        throw new Error('tornD');
                    }
                });
            });
            createEffect(() =>
            {
                log.push(`C${ c() }`);
                if (c() === 1)
                {
                    setQ(1);
                }
            });
            createEffect(() =>
            {
                log.push(`Y${ q() }`);
            });
        });
        log.length = 0;
        const r = attempt(() => batch(() =>
        {
            setA(1);
            setB(1);
            setC(1);
            setD(1);
        }));
        expect(log.join(',') + r).toBe('A1,B1,C1,D1,X1,Y1');
    });

    it('the effect that clears when subscribed after the branch, unbatched and batched', () =>
    {
        for (const batched of [false, true])
        {
            const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
            const host = youngerWriter(user);
            const r = attempt(() => (batched ? batch(() => setUser(null)) : setUser(null)));
            expect(r + host.textContent).toBe('out');
        }
    });

    it('a For keeps its row, and a younger writer closes the list later in the flush', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [list, setList] = createSignal([1]);
        const [mid, setMid] = createSignal(true);
        const host = mount(() =>
        {
            const node = h('ul', null, For({ each: list, key: (n: number) => n, children: (item: () => number) => h('li', null, () => String(item()) + user()!.name) } as never));
            createEffect(() =>
            {
                setMid(user() !== null);
            });
            createEffect(() =>
            {
                if (!mid())
                {
                    setList([]);
                }
            });
            return node;
        });
        // The same-content list write makes the For wait behind the failed row and keep it.
        const r = attempt(() => batch(() =>
        {
            setUser(null);
            setList([1]);
        }));
        expect(r + host.textContent).toBe('');
    });

    it('a held failure whose waiting owner a third effect disposes before it runs, alone or after a torn read', () =>
    {
        for (const tornFirst of [false, true])
        {
            const log: string[] = [];
            const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
            const [a, setA] = createSignal(0);
            const [b, setB] = createSignal(0);
            youngerWriter(user);
            let disposeOwner = (): void => undefined;
            let made = false;
            createRoot((dispose) =>
            {
                disposeOwner = dispose;
                createEffect(() =>
                {
                    if (!made)
                    {
                        made = true;
                        createEffect(() =>
                        {
                            if (a() === 1)
                            {
                                throw new Error('child');
                            }
                        });
                    }
                    b();
                    log.push('O');
                });
            });
            createRoot(() => createEffect(() =>
            {
                if (a() === 1)
                {
                    log.push('T');
                    disposeOwner();
                }
            }));
            log.length = 0;
            // Round [hole, writer, child, T, O]: the torn read is dropped when the flush ends;
            // the child is held behind O, and T disposes O and the child before O runs.
            const r = attempt(() => batch(() =>
            {
                if (tornFirst)
                {
                    setUser(null);
                }
                setA(1);
                setB(1);
            }));
            expect(log.join(',') + r).toBe('T');
        }
    });

    it('a failure held while its owner waits for the next round, whose owner a third effect disposes before it runs', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [t, setT] = createSignal(0);
        createRoot(() => createEffect(() =>
        {
            if (a() === 1)
            {
                setT(1);
            }
        }));
        createRoot(() => createEffect(() =>
        {
            if (a() === 1)
            {
                setB(1);
            }
        }));
        let disposeOwner = (): void => undefined;
        let made = false;
        createRoot((dispose) =>
        {
            disposeOwner = dispose;
            createEffect(() =>
            {
                if (!made)
                {
                    made = true;
                    createEffect(() =>
                    {
                        if (a() === 1)
                        {
                            throw new Error('child');
                        }
                    });
                }
                b();
                log.push('O');
            });
        });
        createRoot(() => createEffect(() =>
        {
            if (t() === 1)
            {
                log.push('T');
                disposeOwner();
            }
        }));
        log.length = 0;
        // Round 1 queues T, then O, then the child fails;
        // round 2 runs T, which disposes O and the child.
        const r = attempt(() => setA(1));
        expect(log.join(',') + r).toBe('T');
    });

    it('a route page the client rendered, cleared in the batch that navigates to a page that renders at once', async () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const router = createRouter({
            history: createMemoryHistory('/account'),
            routes: [
                { path: '/login', component: () => h('main', null, 'login') },
                { path: '/account', component: () => h('main', null, () => `hi ${ user()!.name }`) }
            ]
        });
        const host = mount(() => h('div', {}, Routes({ router })));
        await tick();
        const before = host.textContent;
        const r = attempt(() => batch(() =>
        {
            setUser(null);
            router.navigate('/login');
        }));
        expect(`${ before } >${ r } ${ host.textContent }`).toBe('hi ann > login');
    });

});

describe('a real failure still throws', () =>
{
    it('a self-closing failure after a held torn read in the same round', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [mark, setMark] = createSignal('');
        const [open, setOpen] = createSignal(true);
        mount(() => h('div', null, Show({ when: user, children: () => h('b', null, () => `${ user()!.name }${ mark() }`) })));
        createRoot(() => createEffect(() =>
        {
            if (open())
            {
                createEffect(() =>
                {
                    if (user() === null)
                    {
                        setOpen(false);
                        throw new Error('self');
                    }
                });
            }
        }));
        // Round [hole, swap, effect]: the hole's torn read is held and dropped;
        // the effect then closes its own branch and fails.
        expect(attempt(() => batch(() =>
        {
            setMark('!');
            setUser(null);
        }))).toBe(' THREW self');
    });

    it('the torn error is dropped and the genuine one after it throws', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [mark, setMark] = createSignal('');
        mount(() => h('div', null, Show({ when: user, children: () => h('b', null, () => user()!.name + mark()) })));
        createRoot(() => createEffect(() =>
        {
            if (mark() === '!')
            {
                throw new Error('genuine');
            }
        }));
        expect(attempt(() => batch(() =>
        {
            setMark('!');
            setUser(null);
        }))).toBe(' THREW genuine');
    });

    it('a genuine failure after a torn read the end of the flush drops still throws', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        youngerWriter(user);
        createRoot(() => createEffect(() =>
        {
            if (user() === null)
            {
                throw new Error('genuine after torn');
            }
        }));
        expect(attempt(() => setUser(null))).toBe(' THREW genuine after torn');
    });

    it('a genuine failure behind an owner that already ran this round is not held', () =>
    {
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [q, setQ] = createSignal(0);
        let disposeKept = (): void => undefined;
        createRoot(() =>
        {
            let made = false;
            let madeTorn = false;
            createEffect(() =>
            {
                if (!made)
                {
                    made = true;
                    createRoot((dispose) =>
                    {
                        disposeKept = dispose;
                        createEffect(() =>
                        {
                            if (b() === 1)
                            {
                                throw new Error('real');
                            }
                        });
                    });
                }
                if (!madeTorn)
                {
                    // Created before the owner reads a, so it runs ahead of the owner.
                    madeTorn = true;
                    createEffect(() =>
                    {
                        if (a() === 1)
                        {
                            throw new Error('torn');
                        }
                    });
                }
                a();
            });
        });
        createRoot(() => createEffect(() =>
        {
            if (b() === 1)
            {
                setQ(1);
            }
        }));
        createRoot(() => createEffect(() =>
        {
            if (q() === 1)
            {
                disposeKept();
            }
        }));
        // Round [torn, owner, kept, writer]: the owner drops the torn read and keeps the child,
        // whose genuine error stays live though a later round disposes the child.
        expect(attempt(() => batch(() =>
        {
            setA(1);
            setB(1);
        }))).toBe(' THREW real');
    });

    it('a child error the owner runs past and keeps', () =>
    {
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const log: string[] = [];
        createRoot(() =>
        {
            let made = false;
            createEffect(() =>
            {
                if (!made)
                {
                    made = true;
                    createRoot(() => createEffect(() =>
                    {
                        if (b() === 1)
                        {
                            throw new Error('kept bug');
                        }
                    }));
                }
                a();
                log.push('P');
            });
        });
        log.length = 0;
        const r = attempt(() => batch(() =>
        {
            setB(1);
            setA(1);
        }));
        expect(log.join(',') + r).toBe('P THREW kept bug');
    });

    it('the first of two genuine errors', () =>
    {
        const [a, setA] = createSignal(0);
        createRoot(() => createEffect(() =>
        {
            if (a() === 1)
            {
                throw new Error('first');
            }
        }));
        createRoot(() => createEffect(() =>
        {
            if (a() === 1)
            {
                throw new Error('second');
            }
        }));
        expect(attempt(() => setA(1))).toBe(' THREW first');
    });

    it('an effect that closes its own branch and then fails, unbatched and batched', () =>
    {
        for (const batched of [false, true])
        {
            const [open, setOpen] = createSignal(true);
            const [status, setStatus] = createSignal(0);
            const [x, setX] = createSignal(0);
            const log: string[] = [];
            createRoot(() => createEffect(() =>
            {
                if (open())
                {
                    createEffect(() =>
                    {
                        if (status() === 1)
                        {
                            setOpen(false);
                            throw new Error('onDone bug');
                        }
                    });
                }
                else
                {
                    log.push('closed');
                }
            }));
            createRoot(() => createEffect(() =>
            {
                x();
            }));
            const r = attempt(() => (batched ? batch(() =>
            {
                setStatus(1);
                setX(1);
            }) : setStatus(1)));
            expect(log.join(',') + r).toBe('closed THREW onDone bug');
        }
    });

    it('an effect that closes its own branch and then fails after an earlier effect of the round queued another', () =>
    {
        const log: string[] = [];
        const [status, setStatus] = createSignal(0);
        queuesAnother(status);
        closingBranch(status, log);
        const r = attempt(() => setStatus(1));
        expect(log.join(',') + r).toBe('closed THREW onDone bug');
    });

    it('an effect that closes its own branch and then fails after a held failure and another queued effect in the round', () =>
    {
        const log: string[] = [];
        const [status, setStatus] = createSignal(0);
        const [t, setT] = createSignal(0);
        let made = false;
        createRoot(() => createEffect(() =>
        {
            if (!made)
            {
                made = true;
                createEffect(() =>
                {
                    if (status() === 1)
                    {
                        throw new Error('torn');
                    }
                });
            }
            t();
        }));
        queuesAnother(status);
        closingBranch(status, log);
        const r = attempt(() => batch(() =>
        {
            setStatus(1);
            setT(1);
        }));
        expect(log.join(',') + r).toBe('closed THREW onDone bug');
    });

    it('a self-closing failure ahead of a torn read the end of the flush drops', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [open, setOpen] = createSignal(true);
        createRoot(() => createEffect(() =>
        {
            if (open())
            {
                createEffect(() =>
                {
                    if (user() === null)
                    {
                        setOpen(false);
                        throw new Error('self first');
                    }
                });
            }
        }));
        youngerWriter(user);
        expect(attempt(() => setUser(null))).toBe(' THREW self first');
    });

    it('an effect that closes its own branch and then fails while a farther owner that keeps it also waits', () =>
    {
        const log: string[] = [];
        const [open, setOpen] = createSignal(true);
        const [status, setStatus] = createSignal(0);
        const [k, setK] = createSignal(0);
        let made = false;
        createRoot(() => createEffect(() =>
        {
            k();
            log.push('O');
            if (made)
            {
                return;
            }
            made = true;
            createRoot(() => createEffect(() =>
            {
                if (open())
                {
                    closesItself(status, setOpen);
                }
                else
                {
                    log.push('closed');
                }
            }));
        }));
        log.length = 0;
        const r = attempt(() => batch(() =>
        {
            setStatus(1);
            setK(1);
        }));
        expect(log.join(',') + r).toBe('O,closed THREW onDone bug');
    });

    it('a dialog that closes itself and fails inside a let= Show whose value the same batch rewrites', () =>
    {
        const [account, setAccount] = createSignal({ id: 1 });
        const [open, setOpen] = createSignal(true);
        const [status, setStatus] = createSignal(0);
        const host = mount(() => h('div', null, Show({
            when: account,
            children: (_account: () => { id: number }) => h('section', null, Show({
                when: open,
                fallback: () => h('i', null, 'closed'),
                children: () =>
                {
                    closesItself(status, setOpen);
                    return h('b', null, 'dialog');
                }
            }))
        })));
        const r = attempt(() => batch(() =>
        {
            setStatus(1);
            setAccount({ id: 2 });
        }));
        expect(r + ' | ' + host.textContent).toBe(' THREW onDone bug | closed');
    });

    it('a dialog in a kept For row that closes itself and fails while the For waits for the same batch', () =>
    {
        const [items, setItems] = createSignal([1, 2]);
        const [open, setOpen] = createSignal(true);
        const [status, setStatus] = createSignal(0);
        const host = mount(() => h('ul', null, For({
            each: items,
            key: (x: number) => x,
            children: (x: () => number) => h('li', null, x() === 1 ? Show({
                when: open,
                fallback: () => h('i', null, 'closed'),
                children: () =>
                {
                    closesItself(status, setOpen);
                    return h('b', null, 'dialog');
                }
            }) : 'row')
        } as never)));
        const r = attempt(() => batch(() =>
        {
            setStatus(1);
            setItems([1, 2]);
        }));
        expect(r + ' | ' + host.textContent).toBe(' THREW onDone bug | closedrow');
    });

    it('a row effect that stops itself and then fails while its For waits for the same batch', () =>
    {
        const [list, setList] = createSignal<Item[]>([{ id: 1, name: 'ann' }]);
        const [ready, setReady] = createSignal(0);
        let fired = false;
        const host = mount(() => h('ul', null, For({
            each: list,
            key: (item: Item) => item.id,
            children: (item: () => Item) =>
            {
                once(() => ready() === 1, () =>
                {
                    if (!fired)
                    {
                        fired = true;
                        throw new Error('init bug');
                    }
                });
                return h('li', null, () => item().name);
            }
        } as never)));
        const r = attempt(() => batch(() =>
        {
            setReady(1);
            setList([{ id: 1, name: 'ann' }, { id: 2, name: 'bob' }]);
        }));
        expect(r + ' | ' + host.textContent).toBe(' THREW init bug | annbob');
    });

    it('a row that disposes its own root and then fails, before its list owner runs later in the flush', () =>
    {
        const log: string[] = [];
        const [done, setDone] = createSignal('');
        const [list, setList] = createSignal(['a']);
        const rows = new Map<string, () => void>();
        createRoot(() =>
        {
            createEffect(() =>
            {
                for (const key of list())
                {
                    if (!rows.has(key))
                    {
                        createRoot((dispose) =>
                        {
                            rows.set(key, dispose);
                            createEffect(() =>
                            {
                                if (done() === key)
                                {
                                    dispose();
                                    throw new Error('onDone bug ' + key);
                                }
                            });
                        });
                    }
                }
                log.push('list');
            });
            createEffect(() =>
            {
                if (done() === 'a')
                {
                    setList(['a', 'b']);
                }
            });
        });
        log.length = 0;
        const r = attempt(() => setDone('a'));
        expect(log.join(',') + r).toBe('list THREW onDone bug a');
    });

    it('a catchError handler that closes the root holding its effect and rethrows while the owner waits', () =>
    {
        const [go, setGo] = createSignal(0);
        const [n, setN] = createSignal(0);
        createRoot(() =>
        {
            const settled = createMemo(() => n() >= 0);
            createEffect(() =>
            {
                settled();
                createRoot((close) =>
                {
                    catchError(() =>
                    {
                        createEffect(() =>
                        {
                            if (go() === 1)
                            {
                                throw new Error('save failed');
                            }
                        });
                    }, (error) =>
                    {
                        close();
                        throw error;
                    });
                });
            });
        });
        expect(attempt(() => batch(() =>
        {
            setGo(1);
            setN(1);
        }))).toBe(' THREW save failed');
    });

    it('a child a third effect disposes, whose owner is queued after it and skips its body', () =>
    {
        const log: string[] = [];
        const [b, setB] = createSignal(0);
        const [a, setA] = createSignal(0);
        const handle = { stop: (): void => undefined };
        createRoot(() =>
        {
            const settled = createMemo(() => a() >= 0);
            createEffect(() =>
            {
                settled();
                log.push('A');
                handle.stop = createEffect(() =>
                {
                    if (b() === 1)
                    {
                        throw new Error('child bug');
                    }
                });
            });
            createEffect(() =>
            {
                if (b() === 1)
                {
                    handle.stop();
                    setA(1);
                }
            });
        });
        log.length = 0;
        expect(log.join(',') + attempt(() => setB(1))).toBe(' THREW child bug');
    });

    it('a hole a younger effect disposes while its let= Show keeps the branch', () =>
    {
        const handle = { stop: (): void => undefined };
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [b, setB] = createSignal(0);
        let fired = false;
        const host = mount(() => h('div', null, Show({
            when: user,
            children: (_user: () => { name: string }) => createRoot((dispose) =>
            {
                handle.stop = dispose;
                createEffect(() =>
                {
                    if (b() === 1 && !fired)
                    {
                        fired = true;
                        throw new Error('hole bug');
                    }
                });
                return h('b', null, 'x');
            })
        })));
        createRoot(() => createEffect(() =>
        {
            if (b() === 1)
            {
                handle.stop();
                setUser({ name: 'bob' });
            }
        }));
        expect(attempt(() => setB(1)) + ' | ' + host.textContent).toBe(' THREW hole bug | x');
    });
});

describe('a read the drop does not reach still throws', () =>
{
    it('a row that writes the list its For reads, then reads the value the batch clears', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [mark, setMark] = createSignal(0);
        const [seen, setSeen] = createSignal([1]);
        mount(() => h('div', null, Show({
            when: user,
            fallback: () => h('i', null, 'out'),
            children: () => h('ul', null, For({
                each: seen,
                key: (x: number) => x,
                children: (x: () => number) =>
                {
                    createEffect(() =>
                    {
                        if (mark() === 1 && x() === 1)
                        {
                            setSeen([1, 2]);
                            void user()!.name;
                        }
                    });
                    return h('li', null, String(x()));
                }
            } as never))
        })));
        expect(attempt(() => batch(() =>
        {
            setMark(1);
            setUser(null);
        }))).toBe(' THREW Cannot read properties of null (reading \'name\')');
    });

    it('a row effect that stops itself and then reads the list item the batch removed', () =>
    {
        const [list, setList] = createSignal<Item[]>([{ id: 1, name: 'ann' }]);
        const [ready, setReady] = createSignal(0);
        mount(() => h('ul', null, For({
            each: list,
            key: (item: Item) => item.id,
            children: (item: () => Item, index: () => number) =>
            {
                once(() => ready() === 1, () =>
                {
                    void list()[index()]!.name;
                });
                return h('li', null, () => item().name);
            }
        } as never)));
        expect(attempt(() => batch(() =>
        {
            setReady(1);
            setList([]);
        }))).toBe(' THREW Cannot read properties of undefined (reading \'name\')');
    });

    it('an onUncaughtError handler that unmounts the root and rethrows the read', () =>
    {
        let calls = 0;
        const unmount = { dispose: (): void => undefined };
        const off = onUncaughtError((error) =>
        {
            calls++;
            unmount.dispose();
            throw error;
        });
        const r = createRoot((dispose) =>
        {
            unmount.dispose = dispose;
            const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
            const [x, setX] = createSignal(0);
            const open = createMemo(() => user() !== null);
            createEffect(() =>
            {
                if (open())
                {
                    createEffect(() =>
                    {
                        void (user()!.name + String(x()));
                    });
                }
            });
            return attempt(() => batch(() =>
            {
                setX(1);
                setUser(null);
            }));
        });
        off();
        expect(r + ' | ' + String(calls)).toBe(' THREW Cannot read properties of null (reading \'name\') | 1');
    });

    it('a read in a branch whose closing swap throws from a cleanup as it tears the branch down', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [shown, setShown] = createSignal(true);
        const host = mount(() => h('div', null, Show({
            when: shown,
            fallback: () => h('i', null, 'out'),
            children: () =>
            {
                createEffect(() =>
                {
                    onCleanup(() =>
                    {
                        throw new Error('cleanup bug');
                    });
                });
                return h('b', null, () => user()!.name);
            }
        })));
        createRoot(() => createEffect(() =>
        {
            setShown(user() !== null);
        }));
        expect(attempt(() => setUser(null)) + ' | ' + host.textContent).toBe(' THREW Cannot read properties of null (reading \'name\') | ann');
    });

    it('a route page the navigation keeps open while a lazy page loads or an async guard runs', async () =>
    {
        const seen: string[] = [];
        const login = (): HTMLElement => h('main', null, 'login');
        for (const target of [{ lazy: () => Promise.resolve({ default: login }) }, { component: login, guard: async (): Promise<boolean> => true }])
        {
            const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
            const router = createRouter({
                history: createMemoryHistory('/account'),
                routes: [
                    { path: '/login', ...target },
                    { path: '/account', component: () => h('main', null, () => `hi ${ user()!.name }`) }
                ]
            });
            const host = mount(() => h('div', {}, Routes({ router })));
            await tick();
            const before = host.textContent;
            const r = attempt(() => batch(() =>
            {
                setUser(null);
                router.navigate('/login');
            }));
            await tick();
            seen.push(`${ before } >${ r } > ${ host.textContent }`);
        }
        expect(seen).toEqual([
            'hi ann > THREW Cannot read properties of null (reading \'name\') > login',
            'hi ann > THREW Cannot read properties of null (reading \'name\') > login'
        ]);
    });

    it('a route page hydration adopted from the server markup, when the batch logs out before it navigates to a page that renders at once', async () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const routes = [
            { path: '/login', component: () => h('main', null, 'login') },
            { path: '/account', component: () => h('main', null, () => `hi ${ user()!.name }`) }
        ];
        const host = document.createElement('div');
        document.body.appendChild(host);
        host.innerHTML = renderToString(() => h('div', {}, Routes({ router: createRouter({ history: createMemoryHistory('/account'), routes }) })));
        const server = host.querySelector('main');
        resetDataCache();
        const router = createRouter({ history: createMemoryHistory('/account'), routes });
        hydrate(() => h('div', {}, Routes({ router })), host);
        await tick();
        const before = `${ host.querySelector('main') === server ? 'adopted' : 'rebuilt' } ${ host.textContent }`;
        const r = attempt(() => batch(() =>
        {
            setUser(null);
            router.navigate('/login');
        }));
        await tick();
        host.remove();
        expect(`${ before } >${ r } > ${ host.textContent }`).toBe('adopted hi ann > THREW Cannot read properties of null (reading \'name\') > login');
    });

    it('the leave of a named Transition or TransitionGroup', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [mul, setMul] = createSignal(0);
        mount(() => h('div', null, Transition({ when: () => user() !== null, name: 'fade', children: () => h('i', null, () => user()!.name + String(mul())) })));
        const [member, setMember] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [list, setList] = createSignal(['a']);
        mount(() => h('ul', null, TransitionGroup({ each: list, key: (s: string) => s, name: 'fade', children: (s: string) => h('li', null, () => s + member()!.name) })));
        const transition = attempt(() => batch(() =>
        {
            setMul(1);
            setUser(null);
        }));
        const group = attempt(() => batch(() =>
        {
            setMember(null);
            setList([]);
        }));
        expect(transition + ' |' + group).toBe(' THREW Cannot read properties of null (reading \'name\') | THREW Cannot read properties of null (reading \'name\')');
    });
});

describe('a handled error while an ancestor waits stays where it was', () =>
{
    it('reaches catchError in place, before a reader of the handler write runs', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [k, setK] = createSignal(0);
        const [err, setErr] = createSignal('none');
        let made = false;
        createRoot(() => createEffect(() =>
        {
            k();
            if (!made)
            {
                made = true;
                createRoot(() => catchError(() => createEffect(() =>
                {
                    if (a() === 1)
                    {
                        throw new Error('bad');
                    }
                }), (e) =>
                {
                    log.push('H');
                    setErr((e as Error).message);
                }));
            }
            log.push('P');
        }));
        createRoot(() => createEffect(() =>
        {
            a();
            log.push(`S ${ err() }`);
        }));
        log.length = 0;
        const r = attempt(() => batch(() =>
        {
            setA(1);
            setK(1);
        }));
        expect(log.join(',') + r).toBe('H,S bad,P');
    });

    it('reaches onUncaughtError in place', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [k, setK] = createSignal(0);
        const [banner, setBanner] = createSignal(0);
        const off = onUncaughtError(() =>
        {
            log.push('U');
            setBanner((n) => n + 1);
        });
        let made = false;
        createRoot(() => createEffect(() =>
        {
            k();
            if (!made)
            {
                made = true;
                createRoot(() => createEffect(() =>
                {
                    if (a() === 1)
                    {
                        throw new Error('bad');
                    }
                }));
            }
            log.push('P');
        }));
        createRoot(() => createEffect(() =>
        {
            a();
            log.push(`B${ banner() }`);
        }));
        log.length = 0;
        const r = attempt(() => batch(() =>
        {
            setA(1);
            setK(1);
        }));
        off();
        expect(log.join(',') + r).toBe('U,B1,P');
    });

    it('reaches catchError for a genuine error in a branch that closes', () =>
    {
        const log: string[] = [];
        const [open, setOpen] = createSignal(true);
        const [a, setA] = createSignal(0);
        const host = mount(() => h('div', null, Show({
            when: open,
            fallback: () => h('i', null, 'closed'),
            children: () =>
            {
                catchError(() => createEffect(() =>
                {
                    if (a() === 1)
                    {
                        throw new Error('genuine');
                    }
                }), (e) => log.push('H ' + (e as Error).message));
                return h('i', null, 'in');
            }
        })));
        const r = attempt(() => batch(() =>
        {
            setA(1);
            setOpen(false);
        }));
        expect(log.join(',') + ' | ' + host.textContent + r).toBe('H genuine | closed');
    });

    it('reaches catchError from a kept For row before a reader of the handler write', () =>
    {
        const log: string[] = [];
        const [list, setList] = createSignal([1]);
        const [a, setA] = createSignal(0);
        const [err, setErr] = createSignal('none');
        const host = mount(() => h('ul', null, For({
            each: list,
            key: (n: number) => n,
            children: (item: () => number) =>
            {
                catchError(() => createEffect(() =>
                {
                    if (a() === 1 && item() === 1)
                    {
                        throw new Error('row');
                    }
                }), (e) =>
                {
                    log.push('H');
                    setErr((e as Error).message);
                });
                return h('li', null, () => String(item()));
            }
        } as never)));
        createRoot(() => createEffect(() =>
        {
            a();
            log.push(`S ${ err() }`);
        }));
        log.length = 0;
        const r = attempt(() => batch(() =>
        {
            setA(1);
            setList([1, 2]);
        }));
        expect(log.join(',') + ' | ' + host.textContent + r).toBe('H,S row | 12');
    });

    it('keeps an ErrorBoundary swap ahead of effects queued after the throw', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [k, setK] = createSignal(0);
        const host = mount(() => h('div', null, ErrorBoundary({
            fallback: (e) =>
            {
                log.push('FB ' + (e as Error).message);
                return h('b', null, 'crashed');
            },
            children: () =>
            {
                let made = false;
                createEffect(() =>
                {
                    if (!made)
                    {
                        made = true;
                        createRoot(() => createEffect(() =>
                        {
                            if (b() === 1)
                            {
                                throw new Error('bad');
                            }
                        }));
                    }
                    a();
                    log.push('O');
                });
                createEffect(() =>
                {
                    log.push(`K${ k() }`);
                });
                return h('i', null, 'x');
            }
        })));
        createRoot(() => createEffect(() =>
        {
            if (a() === 1)
            {
                setK(1);
            }
        }));
        log.length = 0;
        const r = attempt(() => batch(() =>
        {
            setB(1);
            setA(1);
        }));
        expect(log.join(',') + r + ' | ' + host.textContent).toBe('O,FB bad | crashed');
    });

    it('still trips an ErrorBoundary around a read on a closing branch', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [mark, setMark] = createSignal('');
        const host = mount(() => h('div', null, ErrorBoundary({
            fallback: () => h('b', null, 'crashed'),
            children: () => Show({ when: user, fallback: () => h('i', null, 'out'), children: () => h('i', null, () => user()!.name + mark()) })
        })));
        const r = attempt(() => batch(() =>
        {
            setMark('!');
            setUser(null);
        }));
        expect(r + host.textContent).toBe('crashed');
    });
});

describe('a catcher around the write does not see a dropped read', () =>
{
    it('a try/catch around the batch catches nothing', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const [mark, setMark] = createSignal('');
        const host = mount(() => h('div', null, Show({ when: user, fallback: () => h('i', null, 'out'), children: () => h('b', null, () => user()!.name + mark()) })));
        expect(attempt(() => batch(() =>
        {
            setMark('!');
            setUser(null);
        })) + host.textContent).toBe('out');
    });

    it('the catchError a resource was created under is not called when its refetch closes a reader outside it', async () =>
    {
        const log: string[] = [];
        let next: { name: string } | null = { name: 'ann' };
        let res!: ReturnType<typeof createResource<{ name: string } | null>>;
        createRoot(() => catchError(() =>
        {
            res = createResource(async () => next);
        }, (e) => log.push('H ' + (e as Error).name)));
        await tick();
        const host = mount(() => h('div', null, Show({ when: () => res.loading(), fallback: () => h('i', null, 'idle'), children: () => h('b', null, () => 'refreshing ' + res.data()!.name) })));
        next = null;
        const settled = res.refetch();
        const during = host.textContent;
        await settled;
        await tick();
        expect(`${ during } > ${ host.textContent } | ${ log.join(',') || 'no handler call' }`).toBe('refreshing ann > idle | no handler call');
    });

    it('an ErrorBoundary around a resource does not show its fallback when the refetch closes a reader beside it', async () =>
    {
        let next: { name: string } | null = { name: 'ann' };
        let res!: ReturnType<typeof createResource<{ name: string } | null>>;
        const boundary = mount(() => h('div', null, ErrorBoundary({
            fallback: () => h('b', null, 'crashed'),
            children: () =>
            {
                res = createResource(async () => next);
                return h('i', null, 'inner');
            }
        })));
        await tick();
        const reader = mount(() => h('div', null, Show({ when: () => res.loading(), fallback: () => h('i', null, 'idle'), children: () => h('b', null, () => 'refreshing ' + res.data()!.name) })));
        next = null;
        const settled = res.refetch();
        const during = reader.textContent;
        await settled;
        await tick();
        expect(`${ during } > ${ boundary.textContent } / ${ reader.textContent }`).toBe('refreshing ann > inner / idle');
    });

    it('the catchError a stream was created under is not called when its settle closes a reader outside it', async () =>
    {
        const log: string[] = [];
        let stream!: Stream;
        createRoot(() => catchError(() =>
        {
            stream = createStream({ fetcher: failing });
        }, (e) => log.push('H ' + (e as Error).name)));
        const reader = streamReader(stream);
        const before = reader.textContent;
        await tick();
        await tick();
        expect(`${ before } > ${ reader.textContent } | ${ String(stream.error()) } | ${ log.join(',') || 'no handler call' }`)
            .toBe('streaming > ended | Error: net | no handler call');
    });

    it('an ErrorBoundary around a stream does not show its fallback when the settle closes a reader beside it', async () =>
    {
        let stream!: Stream;
        const boundary = mount(() => h('div', null, ErrorBoundary({
            fallback: () => h('b', null, 'crashed'),
            children: () =>
            {
                stream = createStream({ fetcher: failing });
                return h('i', null, 'inner');
            }
        })));
        const reader = streamReader(stream);
        const before = reader.textContent;
        await tick();
        await tick();
        expect(`${ before } > ${ boundary.textContent } / ${ reader.textContent } | ${ String(stream.error()) }`).toBe('streaming > inner / ended | Error: net');
    });

    it('a stream keeps reading after a chunk whose flush closes a branch', async () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
        const encoder = new TextEncoder();
        const pipe: { push: (text: string) => void; close: () => void } = { push: () => undefined, close: () => undefined };
        let stream!: Stream;
        createRoot(() =>
        {
            stream = createStream(() => Promise.resolve(new Response(new ReadableStream({
                start(controller)
                {
                    pipe.push = (text) => controller.enqueue(encoder.encode(text));
                    pipe.close = () => controller.close();
                }
            }))));
        });
        await tick();
        createRoot(() => createEffect(() =>
        {
            if (stream.partial().includes('bye'))
            {
                setUser(null);
            }
        }));
        const host = mount(() => h('div', null, Show({ when: user, fallback: () => h('i', null, 'out'), children: () => h('b', null, () => user()!.name + ':' + stream.partial()) })));
        pipe.push('hi ');
        await tick();
        const during = host.textContent;
        pipe.push('bye ');
        await tick();
        pipe.push('more');
        pipe.close();
        await tick();
        expect(`${ during } > ${ host.textContent } | ${ stream.partial() } | ${ String(stream.error()) }`).toBe('ann:hi  > out | hi bye more | null');
    });

    it('createForm reports no submit error for a submit whose batch closes a branch, sync or async', async () =>
    {
        const seen: string[] = [];
        for (const isAsync of [false, true])
        {
            const [user, setUser] = createSignal<{ name: string } | null>({ name: 'ann' });
            const [mark, setMark] = createSignal('');
            const host = mount(() => h('div', null, Show({ when: user, fallback: () => h('i', null, 'out'), children: () => h('b', null, () => user()!.name + mark()) })));
            const close = (): void => batch(() =>
            {
                setMark('!');
                setUser(null);
            });
            let ran = 'not run';
            const form = createRoot(() => createForm({
                initial: { q: '' },
                onSubmit: isAsync
                    ? async (): Promise<void> =>
                    {
                        await Promise.resolve();
                        ran = 'ran';
                        close();
                    }
                    : (): void =>
                    {
                        ran = 'ran';
                        close();
                    }
            }));
            form.handleSubmit(new Event('submit'));
            await tick();
            seen.push(`${ ran } ${ host.textContent } ${ String(form.submitError()) }`);
        }
        expect(seen).toEqual(['ran out null', 'ran out null']);
    });

    it('a mutation whose settle closes a branch answers ok', async () =>
    {
        resetDataCache();
        const getList = cached('held-rethrow-mutation', () => new Promise<string[]>(() => undefined));
        const add = createMutation(async () => 'saved', {
            optimistic: (_input: undefined, patch) =>
            {
                patch(getList, (list: string[] | undefined) => [...(list ?? []), 'draft']);
            }
        });
        const res = createRoot(() => createResource(getList));
        const host = mount(() => h('div', null, Show({
            when: res.loading,
            fallback: () => h('i', null, 'ready'),
            children: () => h('i', null, () =>
            {
                const list = res.data() ?? [];
                // Loading and refreshing never hold together while this branch is open.
                if (res.refreshing())
                {
                    throw new TypeError('refreshing inside the loading branch');
                }
                return 'loading ' + list.join(',');
            })
        })));
        await tick();
        const before = host.textContent;
        const result = await add.run(undefined);
        await tick();
        expect(`${ before } > ${ host.textContent } | ${ result.ok ? 'ok' : 'failed' } | ${ String(add.error()) }`).toBe('loading  > ready | ok | null');
    });
});

describe('a failed flush leaves nothing behind for the next write', () =>
{
    // Stack exhaustion can hit the failure bookkeeping; one injected RangeError stands in for it.
    for (const site of ['ancestorWaits', 'stampRun'])
    {
        it(`after its bookkeeping throws in ${ site }, a later safe write throws nothing`, () =>
        {
            const [a, setA] = createSignal(0);
            const [b, setB] = createSignal(0);
            const [y, setY] = createSignal(0);
            let seenY = -1;
            createRoot(() =>
            {
                // The owner makes the failing effect's root once, so the owner's re-run keeps it.
                let made = false;
                createEffect(() =>
                {
                    a();
                    b();
                    if (!made)
                    {
                        made = true;
                        createRoot(() => createEffect(() =>
                        {
                            if (a() === 1)
                            {
                                throw new Error('genuine');
                            }
                        }));
                    }
                });
                createEffect(() =>
                {
                    if (a() === 1)
                    {
                        setB(1);
                    }
                });
                createEffect(() =>
                {
                    b();
                });
                createEffect(() =>
                {
                    seenY = y();
                });
            });
            // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below, and only called with an explicit receiver
            const realSet = Map.prototype.set;
            const probe = { armed: true };
            Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V): Map<K, V>
            {
                if (probe.armed && (new Error().stack ?? '').includes(site))
                {
                    probe.armed = false;
                    throw new RangeError('injected');
                }
                return realSet.call(this, key, value) as Map<K, V>;
            };
            let failing: string;
            try
            {
                failing = attempt(() => setA(1));
            }
            finally
            {
                Map.prototype.set = realSet;
            }
            const later = attempt(() => setA(0)) + ' |' + attempt(() => batch(() => setY(1)));
            expect(`${ probe.armed ? 'not reached' : 'reached' }${ failing } |${ later } ${ String(seenY) }`).toBe('reached THREW injected | | 1');
        });
    }

    it('after its bookkeeping throws in watch, a later write still drops a failure an outer effect disposes', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [k, setK] = createSignal(0);
        const [g, setG] = createSignal(0);
        let fired = false;
        createRoot(() =>
        {
            createEffect(() =>
            {
                log.push(`G${ g() }`);
                createEffect(() =>
                {
                    createEffect(() =>
                    {
                        if (a() === 1 && !fired)
                        {
                            fired = true;
                            throw new Error('e1');
                        }
                    });
                    createEffect(() =>
                    {
                        if (k() === 1 && g() === 0)
                        {
                            throw new Error('e2');
                        }
                    });
                });
            });
            createEffect(() =>
            {
                if (k() === 1)
                {
                    setG(1);
                }
            });
        });
        // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below
        const realAdd = Set.prototype.add;
        const probe = { armed: true, adds: 0 };
        // watch adds the middle scope, then the outer one; the throw leaves the outer one out.
        Set.prototype.add = function <T>(this: Set<T>, value: T): Set<T>
        {
            if (probe.armed && / at watch /.test(new Error().stack ?? '') && ++probe.adds === 2)
            {
                probe.armed = false;
                throw new RangeError('injected');
            }
            return realAdd.call(this, value) as Set<T>;
        };
        let failing: string;
        try
        {
            failing = attempt(() => setA(1));
        }
        finally
        {
            Set.prototype.add = realAdd;
        }
        const later = attempt(() => batch(() => setK(1)));
        expect(`${ probe.armed ? 'not reached' : 'reached' }${ failing } |${ later } | ${ log.join(',') }`).toBe('reached THREW injected | | G0,G1');
    });

    it('after its bookkeeping throws mid-round, a later effect that closes its own branch alone and fails still throws', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [status, setStatus] = createSignal(0);
        const [open, setOpen] = createSignal(true);
        createRoot(() =>
        {
            createEffect(() =>
            {
                if (a() === 1)
                {
                    throw new Error('genuine');
                }
            });
            createEffect(() =>
            {
                a();
                if (open())
                {
                    closesItself(status, setOpen);
                }
                else
                {
                    log.push('closed');
                }
            });
        });
        // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below
        const realSet = Map.prototype.set;
        const probe = { armed: true };
        Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V): Map<K, V>
        {
            if (probe.armed && (new Error().stack ?? '').includes('ancestorWaits'))
            {
                probe.armed = false;
                throw new RangeError('injected');
            }
            return realSet.call(this, key, value) as Map<K, V>;
        };
        let failing: string;
        try
        {
            failing = attempt(() => setA(1));
        }
        finally
        {
            Map.prototype.set = realSet;
        }
        const later = attempt(() => setStatus(1));
        expect(`${ probe.armed ? 'not reached' : 'reached' }${ failing } | ${ log.join(',') }${ later }`).toBe('reached THREW injected | closed THREW onDone bug');
    });

    it('after a self-disposing failure and the flush cap end a flush, a later write still throws its own failure', () =>
    {
        const [a, setA] = createSignal(0);
        const [loop, setLoop] = createSignal(0);
        const [b, setB] = createSignal(0);
        createRoot((dispose) => createEffect(() =>
        {
            if (a() === 1)
            {
                dispose();
                throw new Error('self');
            }
        }));
        createRoot(() => createEffect(() =>
        {
            const v = loop();
            if (a() === 1)
            {
                setLoop(v + 1);
            }
        }));
        createRoot(() => createEffect(() =>
        {
            if (b() === 1)
            {
                throw new Error('genuine');
            }
        }));
        const first = attempt(() => setA(1)).replace(/:.*/, '');
        const later = attempt(() => setB(1));
        expect(first + ' |' + later).toBe(' THREW Reactive flush did not settle after 1000 rounds | THREW genuine');
    });
});
