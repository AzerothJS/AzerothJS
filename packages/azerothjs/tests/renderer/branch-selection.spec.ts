// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batch, catchError, createEffect, createRoot, createSignal, h, hydrate, Match, onCleanup, render, renderToString, Show, Switch } from 'azerothjs';
import { subscriberCount } from 'azerothjs/internal';

const root = document.createElement('div');
beforeEach(() => document.body.append(root));
afterEach(() =>
{
    render(() => h('i', {}), root);
    root.remove();
});

describe.each(['render', 'hydrate'])('%s Switch selection', mode =>
{
    it('only evaluates eligible cases and retains a lower winner across changes to a losing condition', () =>
    {
        const [session, setSession] = createSignal<{ priority: number } | null>(null);
        const probes = vi.fn(() =>
        {
            const user = session();
            if (!user)
            {
                throw new Error('lower Match ran without a session');
            }
            return user.priority > 0;
        });
        const project = () => h('main', {}, Switch({ children: [
            Match({ when: () => session() === null, children: () => h('b', {}, 'sign in') }),
            Match({ when: probes, children: () => h('input', {}) })
        ], fallback: () => h('i', {}, 'no access') }));
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(project);
            const served = root.querySelector('b');
            hydrate(project, root);
            expect(root.querySelector('b')).toBe(served);
        }
        else
        {
            render(project, root);
        }
        expect(probes).not.toHaveBeenCalled();
        setSession({ priority: 1 });
        const input = root.querySelector('input')!;
        expect(probes).toHaveBeenCalledTimes(1);
        input.value = 'draft';
        setSession({ priority: 2 });
        expect(probes).toHaveBeenCalledTimes(2);
        expect(root.querySelector('input')).toBe(input);
        expect(input.value).toBe('draft');
        setSession({ priority: 0 });
        expect(root.textContent).toBe('no access');
        setSession(null);
        expect(root.textContent).toBe('sign in');
        expect(probes).toHaveBeenCalledTimes(3);
    });
});

it('different case positions and fallback can use one render function and still have distinct lifetimes', () =>
{
    const [index, setIndex] = createSignal(0);
    const clean = vi.fn();
    const factory = () =>
    {
        onCleanup(clean);
        return h('input', {});
    };
    render(() => Switch({ children: [0, 1].map(i => ({ when: () => index() === i, render: factory })), fallback: factory }), root);
    const first = root.querySelector('input')!;
    first.value = 'first draft';
    setIndex(1);
    const second = root.querySelector('input')!;
    expect(second).not.toBe(first);
    expect(clean).toHaveBeenCalledTimes(1);
    setIndex(2);
    const fallback = root.querySelector('input')!;
    expect(fallback).not.toBe(second);
    expect(clean).toHaveBeenCalledTimes(2);
    fallback.value = 'fallback draft';
    setIndex(3);
    expect(root.querySelector('input')).toBe(fallback);
    expect(fallback.value).toBe('fallback draft');
    expect(clean).toHaveBeenCalledTimes(2);
});

it('rechecks custom predicates and uses the current render method when their case next wins', () =>
{
    const [revision, revise] = createSignal(1);
    const eligible = {
        allow: true,
        when()
        {
            revision();
            return this.allow;
        },
        render: () => h('b', {}, 'first')
    };
    const lower = { when: vi.fn(() => true), render: () => h('i', {}, 'lower') };
    render(() => Switch({ children: [eligible, lower] }), root);
    expect(lower.when).not.toHaveBeenCalled();
    eligible.when = () =>
    {
        revision();
        return false;
    };
    revise(2);
    expect(root.textContent).toBe('lower');
    eligible.when = () => revision() >= 3;
    eligible.render = () => h('b', {}, 'replacement');
    revise(3);
    expect(root.textContent).toBe('replacement');
    expect(lower.when).toHaveBeenCalledOnce();
});

it.each(['Show', 'Switch'])('%s selection does not subscribe to a reactive fallback getter', tag =>
{
    const [revision, revise] = createSignal(1);
    const [open, setOpen] = createSignal(false);
    const build = vi.fn(() => h('input', {}));
    const props = {
        when: open,
        get fallback()
        {
            revision();
            return build;
        },
        children: (read: () => boolean) => h('b', {}, String(read()))
    };
    render(() => tag === 'Show' ? Show(props) : Switch({
        children: Match({ when: open, children: () => h('b', {}, 'true') }),
        get fallback()
        {
            return props.fallback;
        }
    }), root);
    const draft = root.querySelector('input')!;
    draft.focus();
    draft.value = 'held text';
    revise(2);
    expect(build).toHaveBeenCalledOnce();
    expect(root.querySelector('input')).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe('held text');
    expect(subscriberCount(revision)).toBe(0);
    setOpen(true);
    expect(root.textContent).toBe('true');
});

it.each(['Show', 'Switch'])('%s discards only the served range when its fallback getter throws during hydration', tag =>
{
    const [open, setOpen] = createSignal(false);
    const failure = new Error('cannot read fallback');
    const caught: unknown[] = [];
    let broken = false;
    const build = () => h('input', {});
    const props = {
        when: open,
        get fallback()
        {
            if (broken)
            {
                throw failure;
            }
            return build;
        },
        children: (read: () => boolean) => h('b', {}, String(read()))
    };
    const app = () => h('main', {}, tag === 'Show' ? Show(props) : Switch({
        children: Match({ when: open, children: () => h('b', {}, 'true') }),
        get fallback()
        {
            return props.fallback;
        }
    }), h('i', {}, 'sibling'));
    root.innerHTML = renderToString(app);
    const served = root.querySelector('input');
    const sibling = root.querySelector('i');
    expect(served).toBeInstanceOf(HTMLInputElement);
    broken = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
    {});
    catchError(() => hydrate(app, root), err => caught.push(err));
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBe(failure);
    expect(root.querySelector('input')).toBeNull();
    broken = false;
    setOpen(true);
    expect(root.querySelector('b')?.textContent).toBe('true');
    setOpen(false);
    expect(root.querySelector('input')).toBeInstanceOf(HTMLInputElement);
    expect(root.querySelector('input')).not.toBe(served);
    expect(root.querySelector('i')).toBe(sibling);
    expect(caught).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
});

it('changing a winning case render method cannot supply its value to the outgoing renderer', () =>
{
    const [count, setCount] = createSignal(1);
    const current = Match({ when: count, children: read => h('b', {}, () => read().toFixed(0)) });
    const next = Match({ when: 'new record', children: read => h('i', {}, () => read().toUpperCase()) });
    render(() => Switch({ children: current }), root);
    expect(root.textContent).toBe('1');
    current.render = next.render;
    setCount(2);
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('i')?.textContent).toBe('NEW RECORD');
});

it('each Switch publishes the selected record only to its own active rendering of a shared Match', () =>
{
    const [row, setRow] = createSignal<string | null>('Alpha');
    const [firstHidden, hideFirst] = createSignal(false);
    const [secondHidden, hideSecond] = createSignal(false);
    const reads: Array<() => string> = [];
    const shared = Match({ when: row, children: read =>
    {
        reads.push(read);
        return h('input', {});
    } });
    const app = (hidden: () => boolean) => Switch({ children: [Match({ when: hidden, children: () => h('i', {}) }), shared] });
    render(() => h('main', {}, app(firstHidden), app(secondHidden)), root);
    setRow('Birch');
    hideFirst(true);
    setRow('Cedar');
    hideSecond(true);
    setRow('Maple');
    expect(reads).toHaveLength(2);
    expect(reads.map(read => read())).toEqual(['Birch', 'Cedar']);
    hideFirst(false);
    expect(reads[2]!()).toBe('Maple');
    render(() => h('i', {}), root);
    expect(subscriberCount(row)).toBe(0);
});

it.each([true, false])('a retained Match observes only samples seen before a batched close (pull=%s)', pull =>
{
    const [row, setRow] = createSignal<string | null>('Alpha');
    let saved!: () => string;
    render(() => Switch({ children: Match({ when: row, children: read =>
    {
        saved = read;
        return h('input', {});
    } }) }), root);
    batch(() =>
    {
        setRow('Birch');
        if (pull)
        {
            expect(saved()).toBe('Birch');
        }
        setRow(null);
    });
    expect(root.querySelector('input')).toBeNull();
    expect(saved()).toBe(pull ? 'Birch' : 'Alpha');
    setRow('Cedar');
    expect(root.querySelector('input')).not.toBeNull();
});

it('a caught Switch predicate failure clears its prior winner and recovers on the same case', () =>
{
    const [state, setState] = createSignal('ready');
    const failure = new Error('selection failed');
    const caught: unknown[] = [];
    const app = () => Switch({ children: Match({ when: () =>
    {
        if (state() === 'failed')
        {
            throw failure;
        }
        return true;
    }, children: () => h('input', {}) }), fallback: () => h('b', {}, 'fallback') });
    catchError(() => render(app, root), error => caught.push(error));
    const first = root.querySelector('input')!;
    first.value = 'failed draft';
    setState('failed');
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBe(failure);
    expect(root.querySelector('input, b')).toBeNull();
    setState('recovered');
    const replacement = root.querySelector('input')!;
    expect(replacement).not.toBe(first);
    expect(replacement.value).toBe('');
});

it('a live Match read in a batch observes an update and then stops pulling once a higher case wins', () =>
{
    const [priority, setPriority] = createSignal(false);
    const [row, setRow] = createSignal('Alpha');
    let saved!: () => string;
    const selected = vi.fn(() =>
    {
        if (priority())
        {
            throw new Error('ineligible row read');
        }
        return row();
    });
    render(() => Switch({ children: [
        Match({ when: priority, children: () => h('b', {}, 'priority') }),
        Match({ when: selected, children: read =>
        {
            saved = read;
            return h('input', {});
        } })
    ] }), root);
    selected.mockClear();
    batch(() =>
    {
        setRow('Birch');
        expect(saved()).toBe('Birch');
        setPriority(true);
        setRow('Cedar');
        expect(saved()).toBe('Birch');
    });
    expect(selected).toHaveBeenCalledTimes(1);
    expect(root.textContent).toBe('priority');
    expect(saved()).toBe('Birch');
});

describe.each(['ownerless', 'in a root'])('failed Switch construction %s', scope =>
{
    it.each(['predicate', 'child'])('a throwing %s releases only its own subscriptions', point =>
    {
        const [selection, setSelection] = createSignal(1);
        const [child] = createSignal(1);
        const [other, setOther] = createSignal(1);
        const failure = new Error('failed to open');
        const unaffected = vi.fn();
        const fail = () => Switch({ children: Match({ when: () =>
        {
            const next = selection();
            if (point === 'predicate')
            {
                throw failure;
            }
            return next;
        }, children: read =>
        {
            expect(read()).toBe(1);
            createEffect(() =>
            {
                child();
            });
            throw failure;
        } }) });
        const attempt = () =>
        {
            expect(fail).toThrow(failure);
            expect(subscriberCount(selection)).toBe(0);
            expect(subscriberCount(child)).toBe(0);
            expect(() => setSelection(2)).not.toThrow();
        };
        if (scope === 'ownerless')
        {
            attempt();
            return;
        }
        const stop = createRoot(dispose =>
        {
            createEffect(() =>
            {
                unaffected(other());
            });
            attempt();
            return dispose;
        });
        try
        {
            setOther(2);
            expect(unaffected.mock.calls).toEqual([[1], [2]]);
        }
        finally
        {
            stop();
        }
        expect(subscriberCount(other)).toBe(0);
    });
});

describe.each(['render', 'hydrate'])('%s after a throwing branch cleanup', mode =>
{
    it.each(['thunk Show', 'value Show', 'Match'])('%s releases its DOM and can re-open only once', shape =>
    {
        const [isOpen, setOpen] = createSignal(true);
        const failure = new Error('cleanup failed');
        let armed = true;
        const cleaned = vi.fn();
        const build = () =>
        {
            onCleanup(() =>
            {
                cleaned();
                if (armed)
                {
                    armed = false;
                    throw failure;
                }
            });
            return h('input', {});
        };
        const app = () =>
        {
            let panel;
            if (shape === 'Match')
            {
                panel = Switch({ children: Match({ when: isOpen, children: build }) });
            }
            else if (shape === 'value Show')
            {
                panel = Show({ when: isOpen, children: value =>
                {
                    expect(value()).toBe(true);
                    return build();
                } });
            }
            else
            {
                panel = Show({ when: isOpen, children: build });
            }
            return h('main', {}, h('b', {}, 'before'), panel, h('i', {}, 'after'));
        };
        const caught = vi.fn();
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            const served = root.querySelector('input');
            catchError(() => hydrate(app, root), caught);
            expect(root.querySelector('input')).toBe(served);
        }
        else
        {
            render(app, root);
        }
        const first = root.querySelector('input')!;
        const close = vi.fn(() => setOpen(false));
        expect(close).toThrow(failure);
        expect(close.mock.results[0]?.value).toBe(failure);
        expect(caught).not.toHaveBeenCalled();
        expect(cleaned).toHaveBeenCalledTimes(1);
        expect(root.querySelector('input')).toBeNull();
        expect(root.textContent).toBe('beforeafter');
        setOpen(true);
        expect(root.querySelectorAll('input')).toHaveLength(1);
        expect(root.querySelector('input')).not.toBe(first);
        setOpen(false);
        expect(root.querySelector('input')).toBeNull();
        expect(cleaned).toHaveBeenCalledTimes(2);
    });
});
