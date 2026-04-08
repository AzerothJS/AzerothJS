import { describe, it, expect } from 'vitest';
import { createSignal, h, Switch, Match  } from '@azerothjs/core';

describe('Switch() and Match()', () =>
{
    it('should render the first matching case', () =>
    {
        const [status] = createSignal('loading');

        const el = Switch(
            Match({ when: () => status() === 'loading' },
                () => h('p', {}, 'Loading...')),
            Match({ when: () => status() === 'error' },
                () => h('p', {}, 'Error!')),
            Match({ when: () => status() === 'success' },
                () => h('p', {}, 'Done!'))
        );

        expect(el.textContent).toBe('Loading...');
    });

    it('should render nothing when no case matches', () =>
    {
        const [status] = createSignal('unknown');

        const el = Switch(
            Match({ when: () => status() === 'loading' },
                () => h('p', {}, 'Loading...')),
            Match({ when: () => status() === 'success' },
                () => h('p', {}, 'Done!'))
        );

        expect(el.textContent).toBe('');
    });

    it('should swap content when condition changes', () =>
    {
        const [status, setStatus] = createSignal('loading');

        const el = Switch(
            Match({ when: () => status() === 'loading' },
                () => h('p', {}, 'Loading...')),
            Match({ when: () => status() === 'error' },
                () => h('p', {}, 'Error!')),
            Match({ when: () => status() === 'success' },
                () => h('p', {}, 'Done!'))
        );

        expect(el.textContent).toBe('Loading...');

        setStatus('error');
        expect(el.textContent).toBe('Error!');

        setStatus('success');
        expect(el.textContent).toBe('Done!');
    });

    it('should support a default fallback case', () =>
    {
        const [status, setStatus] = createSignal('unknown');

        const el = Switch(
            Match({ when: () => status() === 'loading' },
                () => h('p', {}, 'Loading...')),
            Match({ when: () => true },
                () => h('p', {}, 'Default'))
        );

        expect(el.textContent).toBe('Default');

        setStatus('loading');
        expect(el.textContent).toBe('Loading...');

        setStatus('anything');
        expect(el.textContent).toBe('Default');
    });

    it('should only render the FIRST matching case', () =>
    {
        const el = Switch(
            Match({ when: () => true },
                () => h('p', {}, 'First')),
            Match({ when: () => true },
                () => h('p', {}, 'Second'))
        );

        expect(el.textContent).toBe('First');
        expect(el.children.length).toBe(1);
    });
});
