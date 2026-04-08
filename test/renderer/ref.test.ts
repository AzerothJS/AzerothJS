import { describe, it, expect } from 'vitest';
import { createRef, h } from '@azerothjs/core';

describe('createRef()', () =>
{
    it('should start with current as null', () =>
    {
        const ref = createRef();
        expect(ref.current).toBeNull();
    });

    it('should hold a reference to a DOM element', () =>
    {
        const ref = createRef<HTMLInputElement>();
        const input = h('input', { type: 'text' }) as HTMLInputElement;

        ref.current = input;

        expect(ref.current).toBe(input);
        expect(ref.current.tagName).toBe('INPUT');
    });

    it('should allow calling methods on the referenced element', () =>
    {
        const ref = createRef<HTMLInputElement>();
        const input = h('input', { type: 'text' }) as HTMLInputElement;

        ref.current = input;
        document.body.appendChild(input);

        expect(() => ref.current!.focus()).not.toThrow();

        document.body.removeChild(input);
    });
});
