// The dev error overlay: renders on the first uncaught reactive error,
// shows the effect's debug name, accumulates, dismisses, and uninstalls
// back to pristine (handlers unregistered, panel gone, rethrow restored).

import { describe, it, expect, afterEach } from 'vitest';
import { installOverlay } from '@azerothjs/devtools-overlay';
import { createSignal, createEffect } from '@azerothjs/reactivity';

let uninstall: (() => void) | null = null;

afterEach(() =>
{
    uninstall?.();
    uninstall = null;
});

function panel(): HTMLElement | null
{
    return document.getElementById('azeroth-error-overlay');
}

describe('installOverlay', () =>
{
    it('renders a panel when an uncaught reactive error fires', () =>
    {
        uninstall = installOverlay();
        expect(panel()).toBeNull();

        const [count, setCount] = createSignal(0);
        const dispose = createEffect(() =>
        {
            if (count() > 0)
            {
                throw new Error('binding exploded');
            }
        }, { name: 'cart-total' });

        setCount(1);

        const overlay = panel();
        expect(overlay).not.toBeNull();
        expect(overlay!.textContent).toContain('cart-total');
        expect(overlay!.textContent).toContain('binding exploded');
        expect(overlay!.querySelector('[data-overlay-count]')!.textContent).toBe('1');

        dispose();
    });

    it('accumulates errors and dismiss clears the panel', () =>
    {
        uninstall = installOverlay();

        const [count, setCount] = createSignal(0);
        const dispose = createEffect(() =>
        {
            if (count() > 0)
            {
                throw new Error(`boom ${ count() }`);
            }
        });

        setCount(1);
        setCount(2);
        expect(panel()!.querySelector('[data-overlay-count]')!.textContent).toBe('2');

        (panel()!.querySelector('button') as HTMLButtonElement).click();
        expect(panel()).toBeNull();

        dispose();
    });

    it('is idempotent and uninstall restores rethrow', () =>
    {
        uninstall = installOverlay();
        const second = installOverlay();
        expect(second).toBe(uninstall);

        uninstall();
        uninstall = null;
        expect(panel()).toBeNull();

        expect(() => createEffect(() =>
        {
            throw new Error('no overlay anymore');
        })).toThrow('no overlay anymore');
    });
});
