// The in-page devtools panel: builds its model from hook events, renders
// coalesced, and uninstalls back to pristine.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { installDevtools } from '@azerothjs/devtools';
import { createSignal, createEffect } from '@azerothjs/reactivity';

let uninstall: (() => void) | null = null;

afterEach(() =>
{
    uninstall?.();
    uninstall = null;
    vi.useRealTimers();
});

function panel(): HTMLElement | null
{
    return document.getElementById('azeroth-devtools');
}

describe('installDevtools', () =>
{
    it('renders live counts, activity, and the last writer', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();

        const [count, setCount] = createSignal(0, { name: 'count' });
        const dispose = createEffect(() =>
        {
            count();
        }, { name: 'count-binding' });

        setCount(1);
        setCount(2);

        vi.advanceTimersByTime(150);

        const view = panel();
        expect(view).not.toBeNull();

        const summary = view!.querySelector('[data-devtools-summary]')!.textContent!;
        expect(summary).toContain('1 signals');
        expect(summary).toContain('1 effects');
        expect(summary).toContain('last write: count');

        const list = view!.querySelector('[data-devtools-list]')!.textContent!;
        expect(list).toContain('count-binding');
        expect(list).toContain('3 runs');   // initial + 2 writes
        expect(list).toContain('2 writes');

        dispose();
        vi.advanceTimersByTime(150);
        expect(panel()!.querySelector('[data-devtools-summary]')!.textContent).toContain('0 effects');
        expect(panel()!.querySelector('[data-devtools-list]')!.textContent).toContain('(disposed)');
    });

    it('coalesces a write storm into one render pass', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();

        const [, setN] = createSignal(0, { name: 'n' });
        for (let i = 1; i <= 100; i++)
        {
            setN(i);
        }

        // Nothing rendered yet - the panel waits out the coalescing window.
        expect(panel()).toBeNull();

        vi.advanceTimersByTime(150);
        expect(panel()).not.toBeNull();
        expect(panel()!.textContent).toContain('100 writes');
    });

    it('is idempotent and uninstall removes the panel and the hook', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        expect(installDevtools()).toBe(uninstall);

        createSignal(0, { name: 'x' });
        vi.advanceTimersByTime(150);
        expect(panel()).not.toBeNull();

        uninstall();
        uninstall = null;
        expect(panel()).toBeNull();
    });
});
