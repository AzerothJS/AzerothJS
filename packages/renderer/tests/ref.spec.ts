// @vitest-environment happy-dom
//
// Behavioral coverage for createRef (ref.ts) and its integration with h()'s
// `ref` prop wiring.
import { describe, it, expect } from 'vitest';
import { h, createRef } from '@azerothjs/renderer';

describe('createRef', () =>
{
    it('starts with current === null before attachment', () =>
    {
        const ref = createRef();
        expect(ref.current).toBeNull();
    });

    it('is populated with the live element once attached via h()', () =>
    {
        const ref = createRef<HTMLInputElement>();
        const input = h('input', { type: 'text', ref }) as HTMLInputElement;
        expect(ref.current).toBe(input);
        expect(ref.current!.type).toBe('text');
    });

    it('gives imperative access to the real node for DOM APIs', () =>
    {
        const ref = createRef<HTMLInputElement>();
        const input = h('input', { ref }) as HTMLInputElement;
        document.body.appendChild(input);
        ref.current!.value = 'typed';
        expect(input.value).toBe('typed');
        input.remove();
    });

    it('allocates independent boxes per call', () =>
    {
        const a = createRef();
        const b = createRef();
        h('div', { ref: a });
        expect(a.current).not.toBeNull();
        expect(b.current).toBeNull();
    });

    it('is not auto-nulled when the element is removed from the DOM', () =>
    {
        const ref = createRef();
        const el = h('div', { ref });
        document.body.appendChild(el);
        el.remove();
        // Documented behavior: ref stays pointing at the (now-detached) node.
        expect(ref.current).toBe(el);
    });
});
