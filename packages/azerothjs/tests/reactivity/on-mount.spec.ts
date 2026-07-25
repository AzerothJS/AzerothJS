// @vitest-environment node
//
// onMount: the sanctioned post-connection hook. Runs once, one microtask after the
// synchronous render (by which time every insertion path has connected the DOM),
// UNDER the registering owner - so effects it creates are owned, a returned cleanup
// runs on unmount, and a scope that was disposed before the microtask (a control-flow
// branch that swapped away immediately) never fires its callback at all.
import { describe, it, expect, vi } from 'vitest';
import {
    createSignal, createEffect, createRoot, runInMode, untrack,
    onMount, getOwner, provideContext, useContext, createContext
} from 'azerothjs';

const microtask = (): Promise<void> => Promise.resolve();

describe('onMount', () =>
{
    it('defers past the synchronous scope, then runs exactly once', async () =>
    {
        const calls: string[] = [];
        createRoot(() =>
        {
            onMount(() =>
            {
                calls.push('mount');
            });
            calls.push('setup');
        });
        expect(calls).toEqual(['setup']); // nothing during construction
        await microtask();
        expect(calls).toEqual(['setup', 'mount']);
        await microtask();
        expect(calls).toEqual(['setup', 'mount']); // once, not per tick
    });

    it('runs under the registering owner: created effects die with the root', async () =>
    {
        const [n, setN] = createSignal(0);
        let observed = -1;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            onMount(() =>
            {
                createEffect(() =>
                {
                    observed = n();
                });
            });
        });
        await microtask();
        setN(1);
        expect(observed).toBe(1); // the mount-created effect is live...

        dispose();
        setN(2);
        expect(observed).toBe(1); // ...and OWNED - disposed with the root
    });

    it('is skipped entirely when the owner was disposed before the microtask', async () =>
    {
        const fn = vi.fn();
        createRoot((dispose) =>
        {
            onMount(fn);
            dispose(); // the branch swapped away in the same tick
        });
        await microtask();
        expect(fn).not.toHaveBeenCalled();
    });

    it('a returned cleanup registers on the owner and runs at dispose', async () =>
    {
        const cleanup = vi.fn();
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            onMount(() => cleanup);
        });
        await microtask();
        expect(cleanup).not.toHaveBeenCalled();
        dispose();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('owner context resolves inside the callback', async () =>
    {
        const Ctx = createContext<string>();
        let seen: string | undefined;
        createRoot(() =>
        {
            provideContext(Ctx, 'threaded');
            onMount(() =>
            {
                seen = useContext(Ctx);
            });
        });
        await microtask();
        expect(seen).toBe('threaded');
    });

    it('never runs in string mode (SSR mounts nothing)', async () =>
    {
        const fn = vi.fn();
        runInMode('string', () =>
        {
            createRoot(() =>
            {
                onMount(fn);
            });
        });
        await microtask();
        expect(fn).not.toHaveBeenCalled();
    });

    it('multiple registrations fire in order; outside any owner it still runs', async () =>
    {
        const order: number[] = [];
        createRoot(() =>
        {
            onMount(() =>
            {
                order.push(1);
            });
            onMount(() =>
            {
                order.push(2);
            });
        });
        expect(getOwner()).toBeNull();
        onMount(() =>
        {
            order.push(3); // unowned registration - runs, cleanup would have nowhere to go
        });
        await microtask();
        expect(order).toEqual([1, 2, 3]);
        expect(untrack(() => order.length)).toBe(3);
    });
});
