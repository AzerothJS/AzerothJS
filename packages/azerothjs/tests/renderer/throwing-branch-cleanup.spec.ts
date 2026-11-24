// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createSignal, destroyComponent, Dynamic, h, hydrate, onCleanup, onUncaughtError, render, renderToString } from 'azerothjs';
import { setDestroyHooks } from '../../src/component/destroy-hooks.ts';

describe.each(['render', 'hydrate'])('Dynamic cleanup during %s', mode =>
{
    it('preserves the root error, detaches the branch, and mounts a fresh component on reopening', () =>
    {
        const root = document.createElement('div');
        const [open, setOpen] = createSignal(true);
        const error = new Error('scope cleanup');
        const cleaned = vi.fn();
        let armed = false;
        const editor = () =>
        {
            onCleanup(() =>
            {
                if (armed)
                {
                    armed = false;
                    cleaned();
                    throw error;
                }
            });
            return h('input', {});
        };
        const app = () => h('main', {}, 'before', Dynamic({ component: () => open() ? editor : null }), 'after');
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            const served = root.querySelector('input');
            hydrate(app, root);
            expect(root.querySelector('input')).toBe(served);
        }
        else
        {
            render(app, root);
        }
        const first = root.querySelector('input');
        armed = true;
        expect(() => setOpen(false)).toThrow(error);
        expect(cleaned).toHaveBeenCalledOnce();
        expect(root.querySelector('input')).toBeNull();
        setOpen(true);
        expect(root.querySelectorAll('input')).toHaveLength(1);
        expect(root.querySelector('input')).not.toBe(first);
        expect(root.textContent).toBe('beforeafter');
        render(() => h('div', {}), root);
    });
});

it.each(['detach', 'move'])('owns its outgoing nodes before a root cleanup can %s the end marker', change =>
{
    const root = document.createElement('div');
    const [open, setOpen] = createSignal(true);
    const error = new Error('scope');
    const calls: string[] = [];
    const panel = () =>
    {
        const first = document.createElement('section');
        const last = document.createElement('aside');
        const child = document.createElement('span');
        const nested = document.createElement('i');
        last.append(child, nested);
        const fragment = document.createDocumentFragment();
        fragment.append(first, last);
        setDestroyHooks(first, [() => calls.push('first')]);
        setDestroyHooks(child, [() => calls.push('child')]);
        setDestroyHooks(nested, [() => calls.push('nested')]);
        onCleanup(() =>
        {
            const end = last.nextSibling!;
            if (change === 'move')
            {
                root.querySelector('footer')!.after(end);
            }
            else
            {
                end.remove();
            }
            first.remove();
            child.remove();
            destroyComponent(nested);
            throw error;
        });
        return fragment;
    };
    render(() => h('main', {}, h('header', {}, 'before'), Dynamic({ component: () => open() ? panel : null }), h('footer', {}, 'after')), root);
    const header = root.querySelector('header');
    const footer = root.querySelector('footer')!;
    setDestroyHooks(footer, [() => calls.push('outside')]);
    try
    {
        expect(() => setOpen(false)).toThrow(error);
        expect(calls).toEqual(['nested', 'first', 'child']);
        expect(root.querySelector('section, aside')).toBeNull();
        expect(root.querySelector('header')).toBe(header);
        expect(root.querySelector('footer')).toBe(footer);
    }
    finally
    {
        destroyComponent(footer);
    }
});

it.each([false, true])('runs all DOM destroy hooks when cleanup fails (root also throws=%s)', async rootThrows =>
{
    const root = document.createElement('div');
    const [open, setOpen] = createSignal(true);
    const scopeError = new Error('scope');
    const nodeError = new Error('node');
    const descendantError = new Error('descendant');
    const calls: string[] = [];
    const reports: unknown[] = [];
    const uninstall = onUncaughtError(error => reports.push(error));
    const editor = () =>
    {
        onCleanup(() =>
        {
            calls.push('scope');
            if (rootThrows)
            {
                throw scopeError;
            }
        });
        const fragment = document.createDocumentFragment();
        const first = document.createElement('article');
        const child = document.createElement('input');
        const last = document.createElement('aside');
        first.append(child);
        fragment.append(first, last);
        setDestroyHooks(first, [() =>
        {
            calls.push('first');
            child.remove();
            last.remove();
            throw nodeError;
        }, () => calls.push('first again')]);
        setDestroyHooks(child, [() =>
        {
            calls.push('child');
            throw descendantError;
        }]);
        setDestroyHooks(last, [() => calls.push('last')]);
        return fragment;
    };
    try
    {
        render(() => h('main', {}, h('header', {}, 'before'), Dynamic({ component: () => open() ? editor : null }), h('footer', {}, 'after')), root);
        const header = root.querySelector('header');
        const footer = root.querySelector('footer');
        expect(() => setOpen(false)).toThrow(rootThrows ? scopeError : nodeError);
        expect(calls).toEqual(['scope', 'first', 'first again', 'child', 'last']);
        expect(root.querySelector('article, aside')).toBeNull();
        expect(root.querySelector('header')).toBe(header);
        expect(root.querySelector('footer')).toBe(footer);
        expect(reports).toEqual([]);
        await Promise.resolve();
        expect(reports).toEqual(rootThrows ? [nodeError, descendantError] : [descendantError]);
    }
    finally
    {
        uninstall();
    }
});
