// @vitest-environment node
//
// Full behavioral coverage for createDeferred (create-deferred.ts): a timer-driven
// debounced getter. Uses fake timers for determinism - no real waiting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    createSignal,
    createDeferred,
    createRoot
} from '@azerothjs/reactivity';

describe('createDeferred', () =>
{
    beforeEach(() =>
    {
        vi.useFakeTimers();
    });

    afterEach(() =>
    {
        vi.useRealTimers();
    });

    it('exposes the source value immediately (no first-read delay)', () =>
    {
        createRoot((dispose) =>
        {
            const [text] = createSignal('hello');
            const deferred = createDeferred(text, { timeout: 100 });
            expect(deferred()).toBe('hello');
            dispose();
        });
    });

    it('updates only after the debounce window elapses', () =>
    {
        createRoot((dispose) =>
        {
            const [text, setText] = createSignal('a');
            const deferred = createDeferred(text, { timeout: 100 });
            setText('b');
            expect(deferred()).toBe('a');
            vi.advanceTimersByTime(99);
            expect(deferred()).toBe('a');
            vi.advanceTimersByTime(1);
            expect(deferred()).toBe('b');
            dispose();
        });
    });

    it('coalesces a burst: only the final value survives the quiet period', () =>
    {
        createRoot((dispose) =>
        {
            const [text, setText] = createSignal('a');
            const deferred = createDeferred(text, { timeout: 100 });
            setText('b');
            vi.advanceTimersByTime(50);
            setText('c'); // resets the debounce timer
            vi.advanceTimersByTime(50);
            expect(deferred()).toBe('a'); // 100ms since last change not yet reached
            vi.advanceTimersByTime(50);
            expect(deferred()).toBe('c'); // intermediate 'b' never surfaced
            dispose();
        });
    });

    it('stops updating after the owning root is disposed', () =>
    {
        let setText!: (v: string) => void;
        let deferred!: () => string;
        const dispose = createRoot((d) =>
        {
            const [text, set] = createSignal('a');
            setText = set;
            deferred = createDeferred(text, { timeout: 100 });
            return d;
        });
        dispose();
        setText('b');
        vi.advanceTimersByTime(1000);
        expect(deferred()).toBe('a');
    });
});
