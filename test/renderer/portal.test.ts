import { describe, it, expect } from 'vitest';
import { createSignal, h, Portal, destroyPortal } from '@azerothjs/core';

describe('Portal()', () =>
{
    it('should render content into the target element', () =>
    {
        const target = document.createElement('div');

        Portal({ target }, () => h('p', {}, 'Portaled!'));

        expect(target.children.length).toBe(1);
        expect(target.children[0].textContent).toBe('Portaled!');
    });

    it('should return a hidden placeholder', () =>
    {
        const target = document.createElement('div');

        const placeholder = Portal({ target }, () => h('p', {}, 'Hello'));

        expect(placeholder.style.display).toBe('none');
        expect(placeholder.getAttribute('data-azeroth-portal')).toBe('');
    });

    it('should render into document.body by default', () =>
    {
        const el = Portal({}, () => h('p', { id: 'portal-test' }, 'Body!'));

        const portaled = document.getElementById('portal-test');
        expect(portaled).not.toBeNull();
        expect(portaled!.textContent).toBe('Body!');

        destroyPortal(el);
    });

    it('should remove content when destroyPortal is called', () =>
    {
        const target = document.createElement('div');

        const placeholder = Portal({ target }, () => h('p', {}, 'Remove me'));

        expect(target.children.length).toBe(1);

        destroyPortal(placeholder);
        expect(target.children.length).toBe(0);
    });

    it('should dispose the content\'s reactive effects on destroyPortal', () =>
    {
        const target = document.createElement('div');
        const [count, setCount] = createSignal(0);
        const seen: number[] = [];

        const placeholder = Portal({ target }, () => h('p', {}, () =>
        {
            seen.push(count());
            return String(count());
        }));

        expect(seen).toEqual([0]);

        destroyPortal(placeholder);

        // Content removed AND its effect torn down — later signal
        // changes must not re-run the disposed effect.
        setCount(1);
        setCount(2);
        expect(seen).toEqual([0]);
        expect(target.children.length).toBe(0);
    });
});
