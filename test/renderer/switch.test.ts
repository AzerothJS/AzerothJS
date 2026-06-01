import { describe, it, expect } from 'vitest';
import { createSignal, h, Switch, Match  } from '@azerothjs/core';

describe('Switch() and Match()', () =>
{
    it('should render the first matching case', () =>
    {
        const [status] = createSignal('loading');

        const el = Switch({ children: [
            Match({ when: () => status() === 'loading', children: () => h('p', {}, 'Loading...') }),
            Match({ when: () => status() === 'error', children: () => h('p', {}, 'Error!') }),
            Match({ when: () => status() === 'success', children: () => h('p', {}, 'Done!') })
        ] });

        expect(el.textContent).toBe('Loading...');
    });

    it('should render nothing when no case matches', () =>
    {
        const [status] = createSignal('unknown');

        const el = Switch({ children: [
            Match({ when: () => status() === 'loading', children: () => h('p', {}, 'Loading...') }),
            Match({ when: () => status() === 'success', children: () => h('p', {}, 'Done!') })
        ] });

        expect(el.textContent).toBe('');
    });

    it('should render the fallback when no case matches', () =>
    {
        const [status] = createSignal('unknown');

        const el = Switch({
            fallback: () => h('p', {}, 'Fallback'),
            children: [
                Match({ when: () => status() === 'loading', children: () => h('p', {}, 'Loading...') })
            ]
        });

        expect(el.textContent).toBe('Fallback');
    });

    it('should swap content when condition changes', () =>
    {
        const [status, setStatus] = createSignal('loading');

        const el = Switch({ children: [
            Match({ when: () => status() === 'loading', children: () => h('p', {}, 'Loading...') }),
            Match({ when: () => status() === 'error', children: () => h('p', {}, 'Error!') }),
            Match({ when: () => status() === 'success', children: () => h('p', {}, 'Done!') })
        ] });

        expect(el.textContent).toBe('Loading...');

        setStatus('error');
        expect(el.textContent).toBe('Error!');

        setStatus('success');
        expect(el.textContent).toBe('Done!');
    });

    it('should support a default match case', () =>
    {
        const [status, setStatus] = createSignal('unknown');

        const el = Switch({ children: [
            Match({ when: () => status() === 'loading', children: () => h('p', {}, 'Loading...') }),
            Match({ when: () => true, children: () => h('p', {}, 'Default') })
        ] });

        expect(el.textContent).toBe('Default');

        setStatus('loading');
        expect(el.textContent).toBe('Loading...');

        setStatus('anything');
        expect(el.textContent).toBe('Default');
    });

    it('accepts children as a thunk (the compiled .azeroth form)', () =>
    {
        const [status, setStatus] = createSignal('b');

        const el = Switch({ children: () => [
            Match({ when: () => status() === 'a', children: () => h('p', {}, 'A') }),
            Match({ when: () => status() === 'b', children: () => h('p', {}, 'B') })
        ] });

        expect(el.textContent).toBe('B');
        setStatus('a');
        expect(el.textContent).toBe('A');
    });

    it('should only render the FIRST matching case', () =>
    {
        const el = Switch({ children: [
            Match({ when: () => true, children: () => h('p', {}, 'First') }),
            Match({ when: () => true, children: () => h('p', {}, 'Second') })
        ] });

        expect(el.textContent).toBe('First');
        expect(el.children.length).toBe(1);
    });
});
