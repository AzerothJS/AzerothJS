import { describe, it, expect } from 'vitest';
import { createSignal, h, Show, Switch, Match, Dynamic, For, Transition, render } from '@azerothjs/core';
import { ErrorBoundary } from '@azerothjs/component';

// Every control-flow component must render its content as DIRECT children of the
// real parent - no wrapper element - so it can be used inside <table>/<tbody>,
// <select>, and <ul>, where only specific child tags are allowed and where a
// stray <span> would break both layout and `parent > tr` selectors. These mount
// through render() (the marker-range path), which is the path real apps use.
describe('control-flow components inside <tbody> (no wrapper element)', () =>
{
    function mountTable(body: () => HTMLElement): HTMLElement
    {
        const container = document.createElement('div');
        render(() => h('table', {}, h('tbody', { id: 'tbody' }, body())), container);
        return container;
    }

    it('Show renders <tr> directly inside <tbody>', () =>
    {
        const [on, setOn] = createSignal(true);
        const container = mountTable(() => Show({
            when: on,
            fallback: () => h('tr', {}, h('td', {}, 'off')),
            children: () => h('tr', {}, h('td', {}, 'on'))
        }));

        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();
        expect(container.querySelectorAll('tbody > tr').length).toBe(1);
        expect(container.querySelector('tbody > tr')!.textContent).toBe('on');

        setOn(false);
        expect(container.querySelectorAll('tbody > tr').length).toBe(1);
        expect(container.querySelector('tbody > tr')!.textContent).toBe('off');
    });

    it('Switch renders <tr> directly inside <tbody>', () =>
    {
        const [which, setWhich] = createSignal<'a' | 'b'>('a');
        const container = mountTable(() => Switch({
            children: [
                Match({ when: () => which() === 'a', children: () => h('tr', {}, h('td', {}, 'A')) }),
                Match({ when: () => which() === 'b', children: () => h('tr', {}, h('td', {}, 'B')) })
            ]
        }));

        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();
        expect(container.querySelector('tbody > tr')!.textContent).toBe('A');

        setWhich('b');
        expect(container.querySelector('tbody > tr')!.textContent).toBe('B');
    });

    it('Dynamic renders <tr> directly inside <tbody>', () =>
    {
        const RowA = (): HTMLElement => h('tr', {}, h('td', {}, 'A'));
        const RowB = (): HTMLElement => h('tr', {}, h('td', {}, 'B'));
        const [comp, setComp] = createSignal<() => HTMLElement>(RowA);

        const container = mountTable(() => Dynamic({ component: comp }));

        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();
        expect(container.querySelector('tbody > tr')!.textContent).toBe('A');

        setComp(() => RowB);
        expect(container.querySelector('tbody > tr')!.textContent).toBe('B');
    });

    it('For renders <tr> rows directly inside <tbody>', () =>
    {
        const [rows] = createSignal([{ id: 1 }, { id: 2 }]);
        const container = mountTable(() => For({
            each: rows,
            key: (r) => r.id,
            children: (r) => h('tr', {}, h('td', {}, String(r.id)))
        }));

        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();
        expect(container.querySelectorAll('tbody > tr').length).toBe(2);
    });

    it('Transition (instant, no name) renders <tr> directly inside <tbody>', () =>
    {
        const [on, setOn] = createSignal(true);
        const container = mountTable(() => Transition({
            when: on,
            children: () => h('tr', {}, h('td', {}, 'row'))
        }));

        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();
        expect(container.querySelectorAll('tbody > tr').length).toBe(1);

        setOn(false);
        expect(container.querySelectorAll('tbody > tr').length).toBe(0);
        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();
    });

    it('ErrorBoundary renders its children <tr> directly inside <tbody>', () =>
    {
        const container = mountTable(() => ErrorBoundary({
            fallback: () => h('tr', {}, h('td', {}, 'err')),
            children: () => h('tr', {}, h('td', {}, 'ok'))
        }));

        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();
        expect(container.querySelectorAll('tbody > tr').length).toBe(1);
        expect(container.querySelector('tbody > tr')!.textContent).toBe('ok');
    });

    it('nested control flow (Show > For) still places rows directly in <tbody>', () =>
    {
        const [on] = createSignal(true);
        const [rows] = createSignal([{ id: 1 }, { id: 2 }, { id: 3 }]);

        const container = mountTable(() => Show({
            when: on,
            children: () => For({
                each: rows,
                key: (r) => r.id,
                children: (r) => h('tr', {}, h('td', {}, String(r.id)))
            })
        }) as unknown as HTMLElement);

        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();
        expect(container.querySelectorAll('tbody > tr').length).toBe(3);
    });
});
