// @vitest-environment happy-dom
//
// A hole whose value holds another live hole or a For. The outer hole clears its whole range on a
// swap, so rows and nodes the inner one added since go too, in render and after hydration.
import { describe, it, expect, vi } from 'vitest';
import { createSignal, createEffect, h, render, hydrate, renderToString, For, Portal, ErrorBoundary } from 'azerothjs';
import { bindContent } from 'azerothjs/internal';

type Steps = Array<() => void>;

function container(): HTMLElement
{
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
}

/** The text of `c` after mount and each step, plus any text rendered outside it (a Portal). */
function drive(c: HTMLElement, steps: Steps): string
{
    const read = (): string =>
    {
        const outside = [...document.body.childNodes].filter((n) => n !== c).map((n) => n.textContent).join('');
        return outside === '' ? c.textContent : `${ c.textContent }|${ outside }`;
    };
    const seq = [read()];
    for (const step of steps)
    {
        try
        {
            step();
            seq.push(read());
        }
        catch (error)
        {
            seq.push(`threw ${ (error as Error).name }`);
        }
    }
    return seq.join(' > ');
}

/** Renders `app`, then server-renders and hydrates a second copy; returns both sequences. */
function lanes(make: () => { app: () => HTMLElement; steps: Steps }): { render: string; hydrate: string; adopted: boolean }
{
    document.body.innerHTML = '';
    const fresh = make();
    const a = container();
    render(fresh.app, a);
    const rendered = drive(a, fresh.steps);
    a.remove();

    document.body.innerHTML = '';
    const served = make();
    const b = container();
    b.innerHTML = renderToString(served.app);
    const server = [...b.querySelectorAll('li, b, i, u')];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hydrate(served.app, b);
    const adopted = server.every((node) => node.isConnected) && warn.mock.calls.length === 0;
    warn.mockRestore();
    const hydrated = drive(b, served.steps);
    b.remove();
    document.body.innerHTML = '';
    return { render: rendered, hydrate: hydrated, adopted };
}

function forHole(): { app: () => HTMLElement; steps: Steps }
{
    const [ready, setReady] = createSignal(true);
    const [list, setList] = createSignal([1]);
    return {
        app: () => h('ul', {}, () => ready() && For({ each: list, key: (x: number) => x, children: (x: () => number) => h('li', {}, () => x()) })),
        steps: [() => setList([1, 2, 3]), () => setList([3, 1]), () => setReady(false), () => setReady(true), () => setList([]), () => setReady(false), () => setReady(true)]
    };
}

function kidHole(): { app: () => HTMLElement; steps: Steps }
{
    const [ready, setReady] = createSignal(true);
    const [on, setOn] = createSignal(false);
    const Kid = (): unknown[] => [() => on() ? h('b', {}, 'in') : h('i', {}, 'out'), h('i', {}, 'x')];
    return {
        app: () => h('div', {}, () => ready() && Kid()),
        steps: [() => setOn(true), () => setReady(false), () => setReady(true), () => setOn(false), () => setReady(false), () => setReady(true)]
    };
}

describe('a hole whose value holds a live inner hole or For', () =>
{
    it('drops the rows a For added once the hole hides it', () =>
    {
        const seq = '1 > 123 > 31 >  > 31 >  >  > ';
        expect(lanes(forHole)).toEqual({ render: seq, hydrate: seq, adopted: true });
    });

    it('swaps a fragment root whose head is a live hole', () =>
    {
        const seq = 'outx > inx >  > inx > outx >  > outx';
        expect(lanes(kidHole)).toEqual({ render: seq, hydrate: seq, adopted: true });
    });

    it('clears an array of a hole, a For and a trailing hole', () =>
    {
        const make = (): { app: () => HTMLElement; steps: Steps } =>
        {
            const [ready, setReady] = createSignal(true);
            const [list, setList] = createSignal([1]);
            const [on, setOn] = createSignal(false);
            return {
                app: () => h('ul', {}, () => ready() && [
                    () => on() ? h('b', {}, 'in') : [h('i', {}, 'o1'), h('i', {}, 'o2')],
                    For({ each: list, key: (x: number) => x, children: (x: () => number) => h('li', {}, () => x()) }),
                    () => on() ? 'T' : h('u', {}, 'U')
                ]),
                steps: [() => setList([1, 2]), () => setOn(true), () => setReady(false), () => setReady(true), () => setOn(false), () => setList([3])]
            };
        };
        const seq = 'o1o21U > o1o212U > in12T >  > in12T > o1o212U > o1o23U';
        expect(lanes(make)).toEqual({ render: seq, hydrate: seq, adopted: true });
    });

    it('patches text over an array that starts with text without keeping the rest', () =>
    {
        const make = (): { app: () => HTMLElement; steps: Steps } =>
        {
            const [on, setOn] = createSignal(false);
            return { app: () => h('div', {}, () => on() ? 'p' : ['a', h('b', {}, 'b')]), steps: [() => setOn(true), () => setOn(false), () => setOn(true)] };
        };
        expect(lanes(make)).toEqual({ render: 'ab > p > ab > p', hydrate: 'ab > p > ab > p', adopted: true });

        const [on, setOn] = createSignal(false);
        const el = container();
        bindContent(el, () => on() ? 'p' : ['a', h('b', {}, 'b')]);
        expect(drive(el, [() => setOn(true), () => setOn(false), () => setOn(true)])).toBe('ab > p > ab > p');
        el.remove();
    });

    it('drops the rows a For added from a template hole', () =>
    {
        const [ready, setReady] = createSignal(true);
        const [list, setList] = createSignal([1]);
        const el = container();
        bindContent(el, () => ready() && For({ each: list, key: (x: number) => x, children: (x: () => number) => h('li', {}, () => x()) }));
        expect(drive(el, [() => setList([1, 2, 3]), () => setReady(false), () => setReady(true)])).toBe('1 > 123 >  > 123');
        el.remove();
    });

    it('toggles a Portal in a hole after hydration', () =>
    {
        const make = (): { app: () => HTMLElement; steps: Steps } =>
        {
            const [ready, setReady] = createSignal(true);
            const [on, setOn] = createSignal(false);
            return {
                app: () => h('div', {}, () => ready() && Portal({ children: () => h('p', {}, () => on() ? 'in' : 'out') })),
                steps: [() => setOn(true), () => setReady(false), () => setReady(true), () => setOn(false)]
            };
        };
        const seq = '|out > |in >  > |in > |out';
        expect(lanes(make)).toMatchObject({ render: seq, hydrate: seq });
    });

    it('toggles an ErrorBoundary in a hole after hydration', () =>
    {
        const make = (): { app: () => HTMLElement; steps: Steps } =>
        {
            const [ready, setReady] = createSignal(true);
            const [on, setOn] = createSignal(false);
            return {
                app: () => h('div', {}, () => ready() && ErrorBoundary({ fallback: () => h('i', {}, 'err'), children: () => h('p', {}, () => on() ? 'in' : 'out') })),
                steps: [() => setOn(true), () => setReady(false), () => setReady(true), () => setOn(false)]
            };
        };
        const seq = 'out > in >  > in > out';
        expect(lanes(make)).toMatchObject({ render: seq, hydrate: seq });
    });

    it('clears a value whose inner hole is the lone member, head or tail', () =>
    {
        const one = (tail: boolean): string =>
        {
            const [ready, setReady] = createSignal(true);
            const [inner, setInner] = createSignal(false);
            const hole = (): unknown => ready() ? [() => inner() ? h('b', {}, 'b') : 'a'] : 'p';
            const c = container();
            render(() => tail ? h('div', {}, h('u', {}, 's'), hole, h('u', {}, 'e')) : h('div', {}, hole), c);
            const seq = drive(c, [() => setInner(true), () => setReady(false), () => setReady(true), () => setInner(false), () => setReady(false)]);
            c.remove();
            return seq;
        };
        expect(one(false)).toBe('a > b > p > b > a > p');
        expect(one(true)).toBe('sae > sbe > spe > sbe > sae > spe');
    });

    it('clears a value whose component replaces its own first node', () =>
    {
        const swapper = (flag: () => boolean): HTMLElement =>
        {
            const first = h('b', {}, 'a');
            createEffect(() =>
            {
                if (flag() && first.parentNode !== null)
                {
                    first.replaceWith(h('b', {}, 'z'));
                }
            });
            return first;
        };
        const run = (shape: 'content' | 'head' | 'tail'): string =>
        {
            const [ready, setReady] = createSignal(true);
            const [flag, setFlag] = createSignal(false);
            const value = (): unknown => ready() && (shape === 'tail' ? [h('i', {}, 'x'), swapper(flag)] : [swapper(flag), h('i', {}, 'x')]);
            const c = container();
            if (shape === 'content')
            {
                bindContent(c, value);
            }
            else
            {
                render(() => h('p', {}, value, h('u', {}, '-')), c);
            }
            const seq = drive(c, [() => setFlag(true), () => setReady(false), () => setReady(true)]);
            c.remove();
            return seq;
        };
        expect(run('content')).toBe('ax > zx >  > zx');
        expect(run('head')).toBe('ax- > zx- > - > zx-');
        expect(run('tail')).toBe('xa- > xz- > - > xz-');
    });

    it('keeps a node the value returns again in place', () =>
    {
        for (const lane of ['child', 'content'])
        {
            const [tick, setTick] = createSignal(0);
            const box = h('input', {}) as HTMLInputElement;
            const c = container();
            if (lane === 'content')
            {
                bindContent(c, () => (tick(), box));
            }
            else
            {
                render(() => h('div', {}, () => (tick(), box)), c);
            }
            box.value = 'typed';
            box.focus();
            setTick(1);
            expect({ lane, connected: box.isConnected, value: box.value, focused: document.activeElement === box })
                .toEqual({ lane, connected: true, value: 'typed', focused: true });
            c.remove();
        }
    });

    it('hydrates a getter nested 28 arrays deep in linear time', () =>
    {
        const [text, setText] = createSignal('x');
        let value: unknown = () => text();
        for (let depth = 0; depth < 28; depth++)
        {
            value = [value];
        }
        const app = (): HTMLElement => h('div', {}, () => value);
        const c = container();
        c.innerHTML = renderToString(app);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        hydrate(app, c);
        setText('y');
        expect({ text: c.textContent, warned: warn.mock.calls.length }).toEqual({ text: 'y', warned: 0 });
        warn.mockRestore();
        c.remove();
    }, 1000);
});
