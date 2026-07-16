// Full behavioral coverage for <Outlet> (outlet.ts): it returns the forwarded
// children element when present, and an invisible display:contents placeholder
// when this layout is the leaf (no nested level). Real DOM elements via happy-dom.
import { describe, it, expect } from 'vitest';
import { Outlet } from '@azerothjs/router';

describe('Outlet', () =>
{
    it('returns the children element unchanged when present', () =>
    {
        const child = document.createElement('section');
        const result = Outlet({ children: child });
        expect(result).toBe(child);
    });

    it('returns a placeholder span when there are no children', () =>
    {
        const result = Outlet({}) as HTMLElement;
        expect(result.tagName).toBe('SPAN');
    });

    it('the placeholder uses display:contents so it does not disturb layout', () =>
    {
        const result = Outlet({}) as HTMLElement;
        expect(result.style.display).toBe('contents');
    });

    it('treats explicitly undefined children as the leaf case', () =>
    {
        const result = Outlet({ children: undefined }) as HTMLElement;
        expect(result.tagName).toBe('SPAN');
        expect(result.style.display).toBe('contents');
    });

    it('forwards a populated element, preserving its own children', () =>
    {
        const child = document.createElement('div');
        child.appendChild(document.createElement('p'));
        const result = Outlet({ children: child });
        expect(result.querySelector('p')).not.toBeNull();
    });

    it('allocates a fresh placeholder per leaf call (no shared singleton)', () =>
    {
        const a = Outlet({});
        const b = Outlet({});
        expect(a).not.toBe(b);
    });
});
