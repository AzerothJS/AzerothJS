// @vitest-environment happy-dom
//
// The select-value regression guard for SLOT-MOUNTED selects.
// A <select> whose options arrive through a <For> AFTER the framework wrote its value must
// still land on that value when the select lives inside a route slot (a rebuilt leaf). The
// positive control disables the write-intent (a plain DOM write records no intent and no
// observer) and proves this probe CAN fail - without it, a broken repair path would pass
// vacuously. The compiled select suite (compiler tests) re-runs green in the same gate.
import { describe, it, expect } from 'vitest';
import { createSignal, h, render, For } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet } from 'azerothjs';
import type { Route, Router, MountNode } from 'azerothjs';

const settled = (): Promise<void> => Promise.resolve();

const ALL = ['us', 'de', 'jp'];

function mountApp(routes: Route[], initialUrl: string): { router: Router; container: HTMLElement; cleanup: () => void }
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
        return h('div', { id: 'app' }, Routes({ router }));
    }, container);
    return {
        router,
        container,
        cleanup: (): void =>
        {
            render(() => h('div', {}), container);
            container.remove();
        }
    };
}

describe('slot-mounted <select> with <For> options', () =>
{
    it('a select in a slot-REBUILT leaf lands on its written value when the rows arrive late', async () =>
    {
        const [list, setList] = createSignal<string[]>([]);
        const SelectLeaf = (): HTMLElement =>
            h('select', { id: 'sel', value: 'de' },
                For({
                    each: list,
                    key: (code) => code,
                    children: (code) => h('option', { value: code() }, 'pick')
                }));
        const routes: Route[] =
        [{
            path: '/p',
            component: (props: { children?: MountNode | undefined }): MountNode =>
                h('div', { id: 'layout' }, Outlet({ children: props.children })),
            children:
            [
                { path: '', component: (): HTMLElement => h('b', { id: 'home' }, 'home') },
                { path: 'form', component: SelectLeaf }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/p');

        // The leaf below is built by a slot-effect RE-RUN, not the initial chain walk.
        router.navigate('/p/form');
        const select = container.querySelector<HTMLSelectElement>('#sel')!;
        expect(select.options.length).toBe(0);

        setList(ALL);
        await settled();

        // Seed 'de' is the SECOND option: a select with no valid selection reports
        // option 0, so a first-option seed would pass against broken code.
        expect(select.options.length).toBe(3);
        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
        cleanup();
    });

    it('POSITIVE CONTROL: with the write-intent disabled (a plain DOM write) the same probe fails', async () =>
    {
        const [list, setList] = createSignal<string[]>([]);
        const PlainLeaf = (): HTMLElement =>
        {
            // NO framework value write: the plain assignment below records no intent
            // and arms no observer, so the late-arriving rows cannot be repaired.
            const select = h('select', { id: 'sel' },
                For({
                    each: list,
                    key: (code) => code,
                    children: (code) => h('option', { value: code() }, 'pick')
                })) as HTMLSelectElement;
            select.value = 'de';
            return select;
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: (props: { children?: MountNode | undefined }): MountNode =>
                h('div', { id: 'layout' }, Outlet({ children: props.children })),
            children:
            [
                { path: '', component: (): HTMLElement => h('b', { id: 'home' }, 'home') },
                { path: 'form', component: PlainLeaf }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/p');

        router.navigate('/p/form');
        const select = container.querySelector<HTMLSelectElement>('#sel')!;
        setList(ALL);
        await settled();

        // The value did NOT land on 'de': the probe genuinely discriminates - a repair
        // regression in the slot-mounted case fails the test above, not silently.
        expect(select.options.length).toBe(3);
        expect(select.selectedIndex).not.toBe(1);
        cleanup();
    });
});
