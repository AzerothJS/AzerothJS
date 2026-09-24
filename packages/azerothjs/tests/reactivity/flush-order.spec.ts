// @vitest-environment happy-dom
//
// What one flush does around a branch it closes. Effects run in the order they were queued; a read
// on the cleared value may run before the branch closes, and its unhandled error is dropped.
import { describe, it, expect } from 'vitest';
import {
    h,
    render,
    Show,
    Switch,
    Match,
    For,
    ErrorBoundary,
    createSignal,
    createEffect,
    createMemo,
    createRoot,
    createResource,
    catchError,
    onCleanup,
    untrack,
    batch,
    getOwner,
    runWithOwner,
    type Owner
} from 'azerothjs';

type User = { name: string } | null;

/** Mounts a view, runs each step and joins the text after mount and after every step. */
function drive(mount: () => Node, steps: Array<() => void>): string
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(() => mount() as HTMLElement, container);
    const seq = [container.textContent];
    for (const step of steps)
    {
        try
        {
            step();
            seq.push(container.textContent);
        }
        catch (error)
        {
            seq.push(`threw ${ (error as Error).name }`);
        }
    }
    container.remove();
    return seq.join(' > ');
}

function account(): { user: () => User; setUser: (u: User) => void; mul: () => number; setMul: (n: number) => void }
{
    const [user, setUser] = createSignal<User>({ name: 'ann' });
    const [mul, setMul] = createSignal(0);
    return { user, setUser, mul, setMul };
}

const attempt = (fn: () => void): string =>
{
    try
    {
        fn();
        return 'ok';
    }
    catch (error)
    {
        return `threw ${ (error as Error).message }`;
    }
};

const logout = (a: ReturnType<typeof account>) => [() => batch(() =>
{
    a.setMul(1);
    a.setUser(null);
}), () => a.setUser({ name: 'bob' })];

describe('a closing branch drops the failure of a read it owns', () =>
{
    it('a Switch fallback hole', () =>
    {
        const a = account();
        expect(drive(() => h('div', null, Switch({
            fallback: () => h('b', null, () => `${ a.user()!.name }${ a.mul() }`),
            children: [Match({ when: () => !a.user(), children: () => h('u', null, 'none') })]
        })), logout(a))).toBe('ann0 > none > bob1');
    });

    it('an effect created in a memo inside the branch', () =>
    {
        const a = account();
        const log: string[] = [];
        const seq = drive(() => h('div', null, Show({
            when: a.user,
            children: () =>
            {
                const m = createMemo(() =>
                {
                    createEffect(() =>
                    {
                        log.push(`${ a.user()!.name }${ a.mul() }`);
                    });
                    return 1;
                });
                return h('i', null, () => String(m()));
            }
        })), logout(a));
        expect([seq, log.join(',')]).toEqual(['1 >  > 1', 'ann0,bob1']);
    });

    it('a resource source inside the branch', () =>
    {
        const a = account();
        expect(drive(() => h('div', null, Show({
            when: a.user,
            children: () =>
            {
                const r = createResource(() => `${ a.user()!.name }${ a.mul() }`, async (k) => k);
                return h('i', null, () => String(r.loading()));
            }
        })), logout(a))).toBe('true >  > true');
    });

    it('an effect that clears when during the flush, created before or after the branch', () =>
    {
        for (const writerFirst of [true, false])
        {
            const a = account();
            const [ready, setReady] = createSignal(true);
            const clear = (): void =>
            {
                createEffect(() =>
                {
                    if (!ready())
                    {
                        a.setUser(null);
                    }
                });
            };
            expect(drive(() =>
            {
                if (writerFirst)
                {
                    clear();
                }
                const node = h('div', null, Show({ when: a.user, children: () => h('i', null, () => `${ a.user()!.name }${ a.mul() }`) }));
                if (!writerFirst)
                {
                    clear();
                }
                return node;
            }, [
                () => batch(() =>
                {
                    setReady(false);
                    a.setMul(1);
                }),
                () => batch(() =>
                {
                    setReady(true);
                    a.setUser({ name: 'bob' });
                })
            ])).toBe('ann0 >  > bob1');
        }
    });

    it('a nested branch that opens as its outer branch closes in the same flush', () =>
    {
        const log: string[] = [];
        const [user, setUser] = createSignal<User>({ name: 'ann' });
        const [flag, setFlag] = createSignal(false);
        createRoot(() =>
        {
            createEffect(() =>
            {
                const u = user();
                log.push(`P ${ u ? u.name : 'null' }`);
                if (u === null)
                {
                    return;
                }
                createEffect(() =>
                {
                    if (!flag())
                    {
                        return;
                    }
                    log.push('Q');
                    createEffect(() =>
                    {
                        log.push(`H ${ user()!.name }`);
                    });
                });
            });
            createEffect(() =>
            {
                if (flag())
                {
                    setUser(null);
                }
            });
        });
        log.length = 0;
        setFlag(true);
        expect(log).toEqual(['Q', 'P null']);

        const b = account();
        const [open, setOpen] = createSignal(false);
        expect(drive(() =>
        {
            const node = h('div', null, Show({ when: b.user, children: () => h('p', null, 'o', Show({ when: open, children: () => h('i', null, () => b.user()!.name) })) }));
            createEffect(() =>
            {
                if (open())
                {
                    b.setUser(null);
                }
            });
            return node;
        }, [() => setOpen(true)])).toBe('o > ');
    });

    it('a For row reading list[i] while the batch empties the list', () =>
    {
        const [list, setList] = createSignal([1, 2]);
        const [mul, setMul] = createSignal(0);
        expect(drive(() => h('ul', null, For({
            each: list,
            key: (x) => x,
            children: (_x, i) => h('li', null, () => `${ list()[i()]!.toFixed(0) }${ mul() }`)
        })), [() => batch(() =>
        {
            setMul(1);
            setList([]);
        }), () => setList([5])])).toBe('1020 >  > 51');
    });

    it('an effect older than the hole closes the branch, and the swap waits alone for the next round', () =>
    {
        const [data, setData] = createSignal<{ x: string } | null>({ x: 'd' });
        const [show, setShow] = createSignal(true);
        expect(drive(() =>
        {
            createEffect(() =>
            {
                if (data() === null)
                {
                    setShow(false);
                }
            });
            return h('div', null, Show({ when: show, children: () => h('i', null, () => data()!.x) }));
        }, [() => setData(null)])).toBe('d > ');
    });

    it('failures in two rounds of one flush are each dropped when their own branch closes', () =>
    {
        const [x, setX] = createSignal(0);
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [y, setY] = createSignal(0);
        const nest = (read: () => number, own: () => number): void =>
        {
            createEffect(() =>
            {
                if (own() === 0)
                {
                    createEffect(() =>
                    {
                        if (read() === 1)
                        {
                            throw new Error('closed');
                        }
                    });
                }
            });
        };
        createRoot(() =>
        {
            nest(x, a);
            createEffect(() =>
            {
                if (a() === 1)
                {
                    setY(1);
                    setB(1);
                }
            });
            nest(y, b);
        });
        expect(attempt(() => batch(() =>
        {
            setX(1);
            setA(1);
        }))).toBe('ok');
    });

    it('a failure held behind two owners is dropped when the outer one closes the branch', () =>
    {
        // The For runs first and keeps the row; the Show then closes the branch.
        const a = account();
        const [list, setList] = createSignal(['r']);
        expect(drive(() => h('div', null, Show({
            when: a.user,
            children: () => For({ each: list, key: (x) => x, children: (x) => h('i', null, () => `${ x() }${ a.user()!.name }${ a.mul() }`) })
        })), [() => batch(() =>
        {
            a.setMul(1);
            setList(['r', 's']);
            a.setUser(null);
        }), () => a.setUser({ name: 'bob' })]))
            .toBe('rann0 >  > rbob1sbob1');
    });

    it('a branch effect that writes a signal it reads and then reads the cleared value runs once in the flush', () =>
    {
        const [user, setUser] = createSignal<User>({ name: 'ann' });
        const [mul, setMul] = createSignal(0);
        const [k, setK] = createSignal(0);
        let runs = 0;
        const seq = drive(() => h('div', null, Show({
            when: user,
            fallback: () => h('i', null, 'out'),
            children: () =>
            {
                createEffect(() =>
                {
                    runs++;
                    if (mul() > 0)
                    {
                        setK(k() + 1);
                    }
                    void user()!.name;
                });
                return h('i', null, 'in');
            }
        })), [() => batch(() =>
        {
            setMul(1);
            setUser(null);
        })]);
        expect(`${ seq } | runs ${ runs } k ${ k() }`).toBe('in > out | runs 2 k 1');
    });
});

describe('a failure the hold does not drop', () =>
{
    it('a read outside the branch still throws', () =>
    {
        const a = account();
        const [slot, setSlot] = createSignal<(() => string) | null>(null);
        expect(drive(() =>
        {
            createEffect(() =>
            {
                void slot()?.();
            });
            return h('div', null, Show({
                when: a.user,
                children: () =>
                {
                    const m = createMemo(() => `${ a.user()!.name }${ a.mul() }`);
                    setSlot(() => m);
                    return h('i', null, 'in');
                }
            }));
        }, [() => batch(() =>
        {
            a.setMul(1);
            a.setUser(null);
        })])).toBe('in > threw TypeError');
    });

    it('a read outside the branch still throws inside its own try/catch', () =>
    {
        const a = account();
        const [slot, setSlot] = createSignal<(() => string) | null>(null);
        const caught: string[] = [];
        drive(() =>
        {
            createEffect(() =>
            {
                // mul first, so the run starts before the memo is read inside the try.
                a.mul();
                try
                {
                    void slot()?.();
                }
                catch
                {
                    caught.push('caught');
                }
            });
            return h('div', null, Show({
                when: a.user,
                children: () =>
                {
                    const m = createMemo(() => `${ a.user()!.name }${ a.mul() }`);
                    setSlot(() => m);
                    return h('i', null, 'in');
                }
            }));
        }, [() => batch(() =>
        {
            a.setMul(1);
            a.setUser(null);
        })]);
        expect(caught).toEqual(['caught']);
    });

    it('a cleanup that reads the cleared value when the branch is disposed still throws', () =>
    {
        const b = account();
        expect(drive(() => h('div', null, Show({
            when: b.user,
            children: () =>
            {
                onCleanup(() =>
                {
                    void b.user()!.name;
                });
                return h('i', null, 'in');
            }
        })), [() => b.setUser(null)])).toBe('in > threw TypeError');
    });

    it('a memo in a closing branch under an ErrorBoundary still trips the boundary', () =>
    {
        const a = account();
        expect(drive(() => h('div', null, ErrorBoundary({
            fallback: () => h('p', null, 'crashed'),
            children: () => Show({
                when: a.user,
                fallback: () => h('i', null, 'out'),
                children: () =>
                {
                    const label = createMemo(() => `${ a.user()!.name }${ a.mul() }`);
                    return h('i', null, () => label());
                }
            })
        })), logout(a))).toBe('ann0 > crashed > crashed');
    });

    it('a throw the swap does not close is still delivered, bare, under an ErrorBoundary or to catchError', () =>
    {
        interface U { name: string | null }
        const seen: string[] = [];
        for (const shape of ['bare', 'boundary', 'handler'])
        {
            const log: string[] = [];
            const [user, setUser] = createSignal<U>({ name: 'ann' });
            const [mul, setMul] = createSignal(0);
            const hole = (): HTMLElement => h('i', null, () =>
            {
                log.push('H');
                return `${ user().name!.toUpperCase() }${ mul() }`;
            });
            const seq = drive(() =>
            {
                createEffect(() =>
                {
                    log.push(`X ${ mul() }`);
                });
                const show = (): HTMLElement => Show({ when: user, children: () => shape === 'handler'
                    ? (() =>
                    {
                        let n!: HTMLElement;
                        catchError(() =>
                        {
                            n = hole();
                        }, (e) =>
                        {
                            log.push(`caught ${ (e as Error).name }`);
                        });
                        return n;
                    })()
                    : hole() }) as unknown as HTMLElement;
                return h('div', null, shape === 'boundary' ? ErrorBoundary({ fallback: () => h('i', null, 'crashed'), children: show }) : show());
            }, [() => batch(() =>
            {
                setMul(1);
                setUser({ name: null });
            }), () => setUser({ name: 'bob' })]);
            seen.push(`${ seq } | ${ log.join(',') }`);
        }
        expect(seen).toEqual([
            'ANN0 > threw TypeError > BOB1 | X 0,H,X 1,H,H,H',
            'ANN0 > crashed > crashed | X 0,H,X 1,H',
            'ANN0 >  > BOB1 | X 0,H,X 1,H,caught TypeError,H,caught TypeError,H'
        ]);
    });

    it('a kept For row that throws on a stale index', () =>
    {
        const [list, setList] = createSignal([1, 2]);
        const [mul, setMul] = createSignal(0);
        expect(drive(() => h('ul', null, For({
            each: list,
            key: (n) => n,
            children: (_item, index) => h('li', null, () => `${ list()[index()]!.toFixed(0) }${ mul() }`)
        })), [() => batch(() =>
        {
            setMul(1);
            setList([2]);
        }), () => setMul(2)])).toBe('1020 > threw TypeError > 22');
    });

    it('a real throw after its owner already ran this round', () =>
    {
        interface U { name: string | null }
        const [user, setUser] = createSignal<U>({ name: 'ann' });
        const [mul, setMul] = createSignal(0);
        expect(drive(() => h('div', null, Show({ when: user, children: () => h('i', null, () => `${ user().name!.toUpperCase() }${ mul() }`) })),
            [() => batch(() =>
            {
                setUser({ name: null });
                setMul(1);
            }), () => setUser({ name: 'bob' })])).toBe('ANN0 > threw TypeError > BOB1');
    });

    it('a detached child whose owner an outer swap disposes still delivers its throw', () =>
    {
        const [a, setA] = createSignal(true);
        const [b, setB] = createSignal(true);
        const [c, setC] = createSignal(1);
        const log: string[] = [];
        const seq = drive(() => h('div', null, Show({
            when: a,
            fallback: () => h('i', null, 'A'),
            children: () => h('p', null, Show({
                when: b,
                fallback: () => h('i', null, 'B'),
                children: () =>
                {
                    createRoot(() =>
                    {
                        createEffect(() =>
                        {
                            log.push(`c${ c() }`);
                            if (c() === 0)
                            {
                                throw new RangeError('real');
                            }
                        });
                    });
                    return h('i', null, 'in');
                }
            }))
        })), [() => batch(() =>
        {
            setC(0);
            setA(false);
            setB(false);
        })]);
        expect(`${ seq } | ${ log.join(',') }`).toBe('in > threw RangeError | c1,c0');
    });

    it('a real throw after its owner already ran this round, and a later solo throw', () =>
    {
        const [a, setA] = createSignal(1);
        const [b, setB] = createSignal(0);
        const [user, setUser] = createSignal<{ name: string | null }>({ name: 'ann' });
        expect(drive(() => h('div', null, Show({
            when: () => a() > 0,
            children: () => h('i', null, () =>
            {
                if (b() === 99)
                {
                    throw new RangeError('real');
                } return `${ user().name!.toUpperCase() }${ b() }`;
            })
        })), [
            () => batch(() =>
            {
                setA(2);
                setUser({ name: null });
            }),
            () => setUser({ name: 'bob' }),
            () => batch(() =>
            {
                setB(1);
                setA(3);
            }),
            () => setB(99)
        ])).toBe('ANN0 > threw TypeError > BOB0 > BOB1 > threw RangeError');
    });

    it('a kept row throwing after its For ran this round, and a later solo throw', () =>
    {
        const seen: string[] = [];
        for (const order of ['forFirst', 'rowFirst'])
        {
            const [list, setList] = createSignal([1]);
            const [b, setB] = createSignal(0);
            seen.push(drive(() => h('ul', null, For({
                each: list,
                key: (n) => n,
                children: (item) => h('li', null, () =>
                {
                    if (item() !== 1)
                    {
                        return `${ item() }`;
                    } if (b() === 99)
                    {
                        throw new RangeError('real');
                    } return `${ item() }:${ b() }`;
                })
            })), order === 'forFirst'
                ? [() => batch(() =>
                {
                    setList([1, 2]);
                    setB(99);
                }), () => setB(0)]
                : [() => batch(() =>
                {
                    setB(1);
                    setList([1, 2]);
                }), () => setB(99), () => setB(2)]));
        }
        expect(seen).toEqual(['1:0 > threw RangeError > 1:02', '1:0 > 1:12 > threw RangeError > 1:22']);
    });
});

describe('a handled failure reaches its handler in place', () =>
{
    it('in the kept child slot, before its waiting owner and the rest of the round', () =>
    {
        const log: string[] = [];
        const [t, setT] = createSignal(0);
        const [p, setP] = createSignal(0);
        const [z, setZ] = createSignal(0);
        createRoot(() =>
        {
            let made = false;
            createEffect(() =>
            {
                if (!made)
                {
                    made = true;
                    createRoot(() => catchError(() => createEffect(() =>
                    {
                        if (t() === 1)
                        {
                            throw new Error('kept');
                        }
                    }), (error) => log.push(`H ${ (error as Error).message }`)));
                }
                p();
                log.push('P');
            });
            createEffect(() =>
            {
                z();
                log.push('Z');
            });
        });
        log.length = 0;
        batch(() =>
        {
            setT(1);
            setP(1);
            setZ(1);
        });
        expect(log).toEqual(['H kept', 'P', 'Z']);
    });

    it('beside an unhandled kept failure, which the write still throws', () =>
    {
        const log: string[] = [];
        const [t, setT] = createSignal(0);
        const [p, setP] = createSignal(0);
        createRoot(() =>
        {
            let made = false;
            createEffect(() =>
            {
                if (!made)
                {
                    made = true;
                    createRoot(() => catchError(() => createEffect(() =>
                    {
                        if (t() === 1)
                        {
                            throw new Error('kept');
                        }
                    }), (error) => log.push(`H ${ (error as Error).message }`)));
                    createRoot(() => createEffect(() =>
                    {
                        if (t() === 1)
                        {
                            throw new Error('unhandled');
                        }
                    }));
                }
                p();
                log.push('P');
            });
        });
        log.length = 0;
        expect(attempt(() => batch(() =>
        {
            setT(1);
            setP(1);
        }))).toBe('threw unhandled');
        expect(log).toEqual(['H kept', 'P']);
    });

    it('an outer catchError hears a kept child failure before the owner runs', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        createRoot(() => catchError(() =>
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
                log.push('P');
            });
        }, (error) => log.push(`H ${ (error as Error).message }`)));
        log.length = 0;
        batch(() =>
        {
            setB(1);
            setA(1);
        });
        expect(log).toEqual(['H bad', 'P']);
    });

    it('when the owner already ran earlier in the round', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        createRoot(() => catchError(() =>
        {
            let made = false;
            createEffect(() =>
            {
                a();
                log.push('P');
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
            });
            createEffect(() =>
            {
                b();
                log.push('S');
            });
        }, (error) => log.push(`H ${ (error as Error).message }`)));
        log.length = 0;
        batch(() =>
        {
            setA(1);
            setB(1);
        });
        expect(log).toEqual(['P', 'H bad', 'S']);
    });

    it('with no handler the batch throws, and the first thrown error still wins', () =>
    {
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
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
                            throw new Error('first');
                        }
                    }));
                }
                a();
            });
        });
        createRoot(() => createEffect(() =>
        {
            if (b() === 1)
            {
                throw new Error('second');
            }
        }));
        expect(() => batch(() =>
        {
            setB(1);
            setA(1);
        })).toThrow('first');
    });
});

describe('the flush keeps queue order around a waiting owner', () =>
{
    it('a row queued before its For reconcile runs first, and again after it', () =>
    {
        const log: string[] = [];
        const [list, setList] = createSignal(['a']);
        const [mul, setMul] = createSignal(0);
        drive(() => h('ul', null, For({
            each: () =>
            {
                log.push('for');
                return list();
            },
            key: (x) => x,
            children: (item) => h('li', null, () =>
            {
                log.push('row');
                return `${ item() }${ mul() }`;
            })
        })), [() =>
        {
            log.length = 0;
            batch(() =>
            {
                setMul(1);
                setList(['a', 'b']);
            });
        }]);
        expect(log).toEqual(['row', 'for', 'row']);
    });

    it('a child queued ahead of an owner that waits for the next round runs before it and again after', () =>
    {
        const log: string[] = [];
        const [t, setT] = createSignal(0);
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        createRoot(() =>
        {
            createEffect(() =>
            {
                const v = t();
                if (v)
                {
                    setA(v);
                }
            });
            createEffect(() =>
            {
                log.push(`P a=${ a() } b=${ b() }`);
                createEffect(() =>
                {
                    log.push(`C t=${ t() }`);
                });
            });
            createEffect(() =>
            {
                const v = t();
                if (v)
                {
                    setB(v);
                }
            });
        });
        log.length = 0;
        setT(1);
        expect(log).toEqual(['C t=1', 'P a=1 b=1', 'C t=1']);
    });

    it('a child queued ahead of an owner that an unrelated effect disposes still runs in its own slot', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [user, setUser] = createSignal<User>({ name: 'ann' });
        createRoot(() =>
        {
            let close = (): void =>
            {};
            createRoot((dispose) =>
            {
                close = dispose;
                createEffect(() =>
                {
                    log.push(`P ${ user()!.name }`);
                    createEffect(() =>
                    {
                        log.push(`C ${ a() }`);
                    });
                });
            });
            createEffect(() =>
            {
                if (b() === 1)
                {
                    log.push('T disposes');
                    close();
                }
            });
        });
        log.length = 0;
        batch(() =>
        {
            setA(1);
            setB(1);
            setUser(null);
        });
        expect(log).toEqual(['C 1', 'T disposes']);
    });

    it('a kept child queued ahead of its owner runs before it, and the round keeps queue order', () =>
    {
        const log: string[] = [];
        const [t, setT] = createSignal(0);
        const [x, setX] = createSignal(0);
        const [y, setY] = createSignal(0);
        createRoot(() =>
        {
            createEffect(() =>
            {
                const v = t();
                if (v)
                {
                    setX(v);
                }
            });
            let made = false;
            createEffect(() =>
            {
                if (!made)
                {
                    made = true;
                    createRoot(() => createEffect(() =>
                    {
                        t();
                        log.push('C');
                    }));
                }
                t();
                log.push('P');
            });
            createEffect(() =>
            {
                const v = t();
                if (v)
                {
                    setY(v);
                }
            });
            createEffect(() =>
            {
                t();
                log.push('L');
            });
            createEffect(() =>
            {
                x();
                log.push('X');
            });
            createEffect(() =>
            {
                y();
                log.push('Y');
            });
        });
        log.length = 0;
        setT(1);
        expect(log).toEqual(['C', 'P', 'L', 'X', 'Y']);
    });

    it('a kept child queued ahead of its owner runs before it, and again for a later write of the round', () =>
    {
        const log: string[] = [];
        const [t, setT] = createSignal(0);
        const [z, setZ] = createSignal(0);
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
                        log.push(`C t=${ t() } z=${ z() }`);
                    }));
                }
                t();
                log.push('P');
            });
            createEffect(() =>
            {
                const v = t();
                if (v)
                {
                    setZ(v);
                }
            });
        });
        log.length = 0;
        setT(1);
        expect(log).toEqual(['C t=1 z=0', 'P', 'C t=1 z=1']);
    });

    it('a chain of nested owners queued innermost first settles in one round, innermost first', () =>
    {
        // 1001 levels, one past the flush cap, so a chain that drained
        // a level per round would throw.
        const depth = 1001;
        const order: number[] = [];
        const sigs = Array.from({ length: depth + 1 }, () => createSignal(0));
        const level = (d: number): Owner =>
        {
            let scope: Owner | null = null;
            createEffect(() =>
            {
                scope ??= getOwner();
                sigs[d]![0]();
                order.push(d);
            });
            return scope!;
        };
        let parent = createRoot(() => level(depth));
        for (let d = depth - 1; d >= 1; d--)
        {
            const d0 = d;
            parent = runWithOwner(parent, () => createRoot(() => level(d0)));
        }
        order.length = 0;
        batch(() =>
        {
            for (let d = 1; d <= depth; d++)
            {
                sigs[d]![1](1);
            }
        });
        expect([order.length, order[0], order[depth - 1]]).toEqual([depth, 1, depth]);
    });

    it('a live child queued ahead of an owner disposed before its turn runs in its own slot', () =>
    {
        const log: string[] = [];
        const [c, setC] = createSignal(0);
        const [t, setT] = createSignal(0);
        const [p, setP] = createSignal(0);
        const [z, setZ] = createSignal(0);
        createRoot(() =>
        {
            let close = (): void =>
            {};
            let made = false;
            createRoot((dispose) =>
            {
                close = dispose;
                createEffect(() =>
                {
                    if (!made)
                    {
                        made = true;
                        createRoot(() => createEffect(() =>
                        {
                            c();
                            log.push('C');
                        }));
                    }
                    p();
                    log.push('P');
                });
            });
            createEffect(() =>
            {
                if (t() === 1)
                {
                    log.push('T');
                    close();
                }
            });
            createEffect(() =>
            {
                z();
                log.push('Z');
            });
        });
        log.length = 0;
        batch(() =>
        {
            setC(1);
            setT(1);
            setP(1);
            setZ(1);
        });
        expect(log).toEqual(['C', 'T', 'Z']);
    });
});

describe('orders and branches the flush leaves alone', () =>
{
    it('unrelated effects run in the order they were queued', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        createRoot(() =>
        {
            createEffect(() =>
            {
                log.push(`old ${ a() }`);
            });
            createEffect(() =>
            {
                log.push(`young ${ b() }`);
            });
        });
        log.length = 0;
        batch(() =>
        {
            setB(1);
            setA(1);
        });
        expect(log).toEqual(['young 1', 'old 1']);
    });

    it('an effect created during a flush takes its first value before an older effect writes', () =>
    {
        const log: string[] = [];
        const [s, setS] = createSignal(0);
        const [c, setC] = createSignal(0);
        const [t, setT] = createSignal(0);
        createRoot(() =>
        {
            createEffect(() =>
            {
                if (t() > 0)
                {
                    setS(5);
                }
            });
            createEffect(() =>
            {
                if (c() === 0)
                {
                    return;
                }
                let first = true;
                createEffect(() =>
                {
                    const v = s();
                    log.push(first ? `base ${ v }` : `changed ${ v }`);
                    first = false;
                });
                setT(1);
            });
        });
        setC(1);
        expect(log).toEqual(['base 0', 'changed 5']);
    });

    it('a swap queued for the next round never builds its fallback on a half-written round', () =>
    {
        const log: string[] = [];
        const [t, setT] = createSignal(0);
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const seq = drive(() =>
        {
            createEffect(() =>
            {
                const v = t();
                if (v)
                {
                    setA(v);
                }
            });
            const kid = (): HTMLElement =>
            {
                onCleanup(() =>
                {
                    log.push('cleanup');
                });
                return h('i', null, () => `t${ t() }`);
            };
            const node = h('div', null, Show({
                when: () =>
                {
                    log.push(`when ${ a() }=${ b() }`);
                    return a() === b();
                },
                fallback: () =>
                {
                    log.push('fallback');
                    return h('i', null, 'FB');
                },
                children: () => kid()
            }));
            createEffect(() =>
            {
                const v = t();
                if (v)
                {
                    setB(v);
                }
            });
            return node;
        }, [() =>
        {
            log.length = 0;
            setT(1);
        }]);
        expect([seq, log]).toEqual(['t0 > t1', ['cleanup', 'when 1=1']]);
    });

    it('a branch opened by two effects that keep state in step sees the settled state', () =>
    {
        const [src, setSrc] = createSignal<Array<{ price: number }>>([]);
        const [count, setCount] = createSignal(0);
        const [items, setItems] = createSignal<Array<{ price: number }>>([]);
        const summary = (): HTMLElement => h('b', null, `last ${ items()[count() - 1]!.price }`);
        expect(drive(() =>
        {
            createEffect(() =>
            {
                setCount(src().length);
            });
            const node = h('div', null, ErrorBoundary({
                fallback: () => h('p', null, 'crashed'),
                children: () => Show({ when: () => count() > 0, fallback: () => h('i', null, () => `empty ${ src().length }`), children: () => summary() })
            }));
            createEffect(() =>
            {
                setItems(src());
            });
            return node;
        }, [() => setSrc([{ price: 7 }]), () => setSrc([{ price: 7 }, { price: 9 }])])).toBe('empty 0 > last 7 > last 9');
    });

    it('a child that writes its owner\'s condition still runs first and keeps the branch open', () =>
    {
        const log: string[] = [];
        const [items, setItems] = createSignal(['a', 'b', 'c']);
        const [idx, setIdx] = createSignal(2);
        const [other, setOther] = createSignal(0);
        createRoot(() =>
        {
            createEffect(() =>
            {
                const row = items()[idx()];
                log.push(`S ${ row ?? 'closed' }`);
                if (row === undefined)
                {
                    return;
                }
                createEffect(() =>
                {
                    other();
                    const len = items().length;
                    if (untrack(idx) >= len)
                    {
                        setIdx(len - 1);
                    }
                });
            });
        });
        log.length = 0;
        batch(() =>
        {
            setOther(1);
            setItems(['a']);
        });
        expect(log).toEqual(['S a']);
    });

    it('an owner that reads what its child writes runs after the child, once', () =>
    {
        const log: string[] = [];
        const [items, setItems] = createSignal([{ n: 'a' }, { n: 'b' }, { n: 'c' }]);
        const [idx, setIdx] = createSignal(2);
        createRoot(() =>
        {
            createEffect(() =>
            {
                createEffect(() =>
                {
                    const len = items().length;
                    if (idx() >= len)
                    {
                        setIdx(len - 1);
                    }
                });
                log.push(`P ${ items()[idx()]!.n }`);
            });
        });
        log.length = 0;
        expect(attempt(() => batch(() =>
        {
            setItems([{ n: 'a' }]);
        }))).toBe('ok');
        expect(log).toEqual(['P a']);
    });

    it('a Show or Switch whose condition a branch child writes, and a For whose list a row writes', () =>
    {
        const seen: string[] = [];
        for (const childFirst of [true, false])
        {
            const log: string[] = [];
            const [a, setA] = createSignal(true);
            const [b, setB] = createSignal(0);
            const [x, setX] = createSignal(0);
            const seq = drive(() => h('div', null, Show({
                when: () => a() || b() > 0,
                fallback: () => h('i', null, 'closed'),
                children: () =>
                {
                    createEffect(() =>
                    {
                        log.push(`kid ${ x() }`);
                        setB(x());
                    });
                    return h('i', null, () => `open${ b() }`);
                }
            })), [
                () => batch(() =>
                {
                    if (childFirst)
                    {
                        setX(1);
                        setA(false);
                    }
                    else
                    {
                        setA(false);
                        setX(1);
                    }
                }),
                () => setX(0)
            ]);
            seen.push(`${ seq } | ${ log.join(',') }`);
        }
        {
            const log: string[] = [];
            const [a, setA] = createSignal(true);
            const [b, setB] = createSignal(0);
            const [x, setX] = createSignal(0);
            const seq = drive(() => h('div', null, Switch({
                fallback: () => h('i', null, 'none'),
                children: [Match({
                    when: () => a() || b() > 0,
                    children: () =>
                    {
                        createEffect(() =>
                        {
                            log.push(`kid ${ x() }`);
                            setB(x());
                        });
                        return h('i', null, () => `m${ b() }`);
                    }
                })]
            })), [() => batch(() =>
            {
                setX(1);
                setA(false);
            })]);
            seen.push(`${ seq } | ${ log.join(',') }`);
        }
        {
            const log: string[] = [];
            const [list, setList] = createSignal(['a']);
            const [mul, setMul] = createSignal(0);
            const seq = drive(() => h('ul', null, For({
                each: () =>
                {
                    log.push('for');
                    return list();
                },
                key: (s) => s,
                children: (item) =>
                {
                    createEffect(() =>
                    {
                        const m = mul();
                        log.push(`row ${ item() }${ m }`);
                        if (m > 0 && !list().includes('z'))
                        {
                            setList([...list(), 'z']);
                        }
                    });
                    return h('li', null, () => `${ item() }${ mul() }`);
                }
            })), [() => batch(() =>
            {
                setMul(1);
                setList(['a', 'b']);
            })]);
            seen.push(`${ seq } | ${ log.join(',') }`);
        }
        expect(seen).toEqual([
            'open0 > open1 > closed | kid 0,kid 1,kid 1,kid 0',
            'open0 > closed > closed | kid 0',
            'm0 > m1 | kid 0,kid 1,kid 1',
            'a0 > a1b1z1 | for,row a0,row a1,for,row a1,row b1,row z1'
        ]);
    });
});

describe('the flush cap', () =>
{
    it('two effects that ping-pong still hit the cap, and a later write reaches both', () =>
    {
        const log: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [armed, setArmed] = createSignal(false);
        createRoot(() =>
        {
            createEffect(() =>
            {
                const v = a();
                if (armed())
                {
                    setB(v + 1);
                } log.push(`a${ v }`);
            });
            createEffect(() =>
            {
                const v = b();
                if (armed())
                {
                    setA(v + 1);
                } log.push(`b${ v }`);
            });
        });
        expect(() => setArmed(true)).toThrow(/did not settle after 1000 rounds/);
        setArmed(false);
        log.length = 0;
        setA(-5);
        setB(-7);
        expect(log).toEqual(['a-5', 'b-7']);
    });

    it('an effect left waiting by the cap still runs on a later write', () =>
    {
        // Four effects so both cap parities leave effects in the array queue.
        const seen: string[] = [];
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [armed, setArmed] = createSignal(false);
        createRoot(() =>
        {
            createEffect(() =>
            {
                const v = a();
                if (armed())
                {
                    setB(v + 1);
                } seen.push(`a${ v }`);
            });
            createEffect(() =>
            {
                const v = b();
                if (armed())
                {
                    setA(v + 1);
                } seen.push(`b${ v }`);
            });
            createEffect(() =>
            {
                seen.push(`c${ b() }`);
            });
            createEffect(() =>
            {
                seen.push(`d${ a() }`);
            });
        });
        expect(() => setArmed(true)).toThrow(/did not settle/);
        setArmed(false);
        seen.length = 0;
        setA(-5);
        setB(-7);
        expect(seen).toEqual(['a-5', 'd-5', 'b-7', 'c-7']);
    });

    it('a kept child of an owner in the ping-pong still runs on a later write', () =>
    {
        // Each start lands the cap on one parity.
        for (const startB of [false, true])
        {
            const seen: string[] = [];
            const [a, setA] = createSignal(0);
            const [b, setB] = createSignal(0);
            let armed = false;
            createRoot(() =>
            {
                createEffect(() =>
                {
                    const v = a();
                    if (armed)
                    {
                        setB(v + 1);
                    }
                });
                let made = false;
                createEffect(() =>
                {
                    if (!made)
                    {
                        made = true;
                        createRoot(() => createEffect(() =>
                        {
                            seen.push(`c${ a() }`);
                        }));
                    }
                    const v = b();
                    if (armed)
                    {
                        setA(v + 1);
                    }
                });
            });
            armed = true;
            expect(() => (startB ? setB(1) : setA(1))).toThrow(/did not settle/);
            armed = false;
            seen.length = 0;
            setA(-5);
            setA(-6);
            expect(seen).toEqual(['c-5', 'c-6']);
        }
    });

    it('a failure held when the cap trips is not thrown by a later flush', () =>
    {
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [z, setZ] = createSignal(0);
        let armed = false;
        createRoot(() =>
        {
            let made = false;
            createEffect(() =>
            {
                const v = a();
                if (armed)
                {
                    setB(v + 1);
                }
            });
            createEffect(() =>
            {
                if (!made)
                {
                    made = true;
                    createRoot(() => createEffect(() =>
                    {
                        // Reads a after the ping-pong's first effect does,
                        // so it runs while its owner waits.
                        a();
                        if (armed && z() === 1)
                        {
                            throw new Error('held at the cap');
                        }
                    }));
                }
                const v = b();
                if (armed)
                {
                    setA(v + 1);
                }
            });
        });
        armed = true;
        expect(attempt(() => batch(() =>
        {
            setZ(1);
            setA(1);
        }))).toMatch(/did not settle/);
        armed = false;
        expect(attempt(() => setZ(2))).toBe('ok');
    });

    it('the cap still trips with a failure held, and a later write reaches every effect', () =>
    {
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [z, setZ] = createSignal(0);
        let armed = false;
        const seen: string[] = [];
        createRoot(() =>
        {
            createEffect(() =>
            {
                const v = a();
                if (armed)
                {
                    setB(v + 1);
                }
            });
            createEffect(() =>
            {
                b();
                createEffect(() =>
                {
                    if (armed && z() === 1)
                    {
                        throw new Error('held');
                    }
                    seen.push(`k${ z() }`);
                });
                const v = b();
                if (armed)
                {
                    setA(v + 1);
                }
            });
        });
        armed = true;
        expect(attempt(() => batch(() =>
        {
            setZ(1);
            setA(1);
        }))).toMatch(/did not settle/);
        armed = false;
        seen.length = 0;
        setZ(2);
        expect(seen).toEqual(['k2']);
    });
});
