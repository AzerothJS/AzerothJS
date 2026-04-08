import { describe, it, expect } from 'vitest';
import { createSignal, h, Show } from '@quantum/core';

describe('Show()', () =>
{
    it('should render children when condition is true', () =>
    {
        const [visible] = createSignal(true);

        const el = Show(
            { when: visible },
            () => h('p', {}, 'Hello')
        );

        expect(el.textContent).toBe('Hello');
    });

    it('should render nothing when condition is false', () =>
    {
        const [visible] = createSignal(false);

        const el = Show(
            { when: visible },
            () => h('p', {}, 'Hello')
        );

        expect(el.textContent).toBe('');
    });

    it('should render fallback when condition is false', () =>
    {
        const [visible] = createSignal(false);

        const el = Show({
            when: visible,
            fallback: () => h('p', {}, 'Hidden')
        }, () => h('p', {}, 'Visible'));

        expect(el.textContent).toBe('Hidden');
    });

    it('should swap content when condition changes', () =>
    {
        const [visible, setVisible] = createSignal(true);

        const el = Show({
            when: visible,
            fallback: () => h('p', {}, 'Hidden')
        }, () => h('p', {}, 'Visible'));

        expect(el.textContent).toBe('Visible');

        setVisible(false);
        expect(el.textContent).toBe('Hidden');

        setVisible(true);
        expect(el.textContent).toBe('Visible');
    });

    it('should use display: contents on container', () =>
    {
        const [visible] = createSignal(true);

        const el = Show(
            { when: visible },
            () => h('p', {}, 'Hello')
        );

        expect(el.style.display).toBe('contents');
    });
});
