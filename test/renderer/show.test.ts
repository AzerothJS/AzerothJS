import { describe, it, expect } from 'vitest';
import { createSignal, h, Show } from '@azerothjs/core';

describe('Show()', () =>
{
    it('should render children when condition is true', () =>
    {
        const [visible] = createSignal(true);

        const el = Show({
            when: visible,
            children: () => h('p', {}, 'Hello')
        });

        expect(el.textContent).toBe('Hello');
    });

    it('should render nothing when condition is false', () =>
    {
        const [visible] = createSignal(false);

        const el = Show({
            when: visible,
            children: () => h('p', {}, 'Hello')
        });

        expect(el.textContent).toBe('');
    });

    it('should render fallback when condition is false', () =>
    {
        const [visible] = createSignal(false);

        const el = Show({
            when: visible,
            fallback: () => h('p', {}, 'Hidden'),
            children: () => h('p', {}, 'Visible')
        });

        expect(el.textContent).toBe('Hidden');
    });

    it('should swap content when condition changes', () =>
    {
        const [visible, setVisible] = createSignal(true);

        const el = Show({
            when: visible,
            fallback: () => h('p', {}, 'Hidden'),
            children: () => h('p', {}, 'Visible')
        });

        expect(el.textContent).toBe('Visible');

        setVisible(false);
        expect(el.textContent).toBe('Hidden');

        setVisible(true);
        expect(el.textContent).toBe('Visible');
    });

    it('renders content with NO wrapper element (so it works in strict parents)', () =>
    {
        const [visible] = createSignal(true);

        // Mounting the returned fragment moves its content (between comment
        // markers) directly into the container - no <span> wrapper, so <Show>
        // is safe inside <table>/<select>/<ul>.
        const container = document.createElement('div');
        container.appendChild(Show({
            when: visible,
            children: () => h('p', {}, 'Hello')
        }));

        expect(container.querySelector('span')).toBeNull();
        expect(container.children.length).toBe(1);
        expect(container.children[0].tagName).toBe('P');
        expect(container.textContent).toBe('Hello');
    });
});
