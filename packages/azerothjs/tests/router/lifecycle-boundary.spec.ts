// @vitest-environment happy-dom
//
// Error delivery is capture-at-creation, and placement-time slot
// creation is what makes an <ErrorBoundary> around the Outlet the captured handler for the
// CHILD segment's construction errors and its lazy-chunk load failure. Boundary reset
// re-places the slot handle: fresh markers, fresh effect, fresh build of the current
// committed segment. A boundary OUTSIDE <Routes> still catches segment-0 errors.
import { describe, it, expect } from 'vitest';
import { h, render, ErrorBoundary } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet } from 'azerothjs';
import type { Route, Router, MountNode } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface App { router: Router; container: HTMLElement; cleanup: () => void }

function mountApp(routes: Route[], initialUrl: string): App
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

/** A layout whose Outlet is guarded by an in-layout boundary with a reset button. */
const guardedLayout = (props: { children?: MountNode | undefined }): MountNode =>
    h('div', { id: 'layout' },
        ErrorBoundary({
            fallback: (error, reset) => h('div', { id: 'caught' },
                h('em', {}, String(error instanceof Error ? error.message : error)),
                h('button', { id: 'reset', onClick: reset }, 'retry')),
            children: () => Outlet({ children: props.children })
        }));

describe('ErrorBoundary around the Outlet', () =>
{
    it('catches the child segment\'s construction throw; reset re-mounts the current committed segment', async () =>
    {
        let attempts = 0;
        const Exploding = (): HTMLElement =>
        {
            attempts += 1;
            if (attempts === 1)
            {
                throw new Error('leaf exploded');
            }
            return h('span', { id: 'leaf' }, 'recovered');
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: guardedLayout,
            children: [{ path: 'x', component: Exploding }]
        }];
        const { container, cleanup } = mountApp(routes, '/p/x');

        // The boundary caught the CHILD's construction throw; the layout survived it.
        expect(container.querySelector('#layout')).not.toBeNull();
        expect(container.querySelector('#caught')!.textContent).toContain('leaf exploded');
        expect(container.querySelector('#leaf')).toBeNull();

        // Reset re-invokes the boundary's children, re-placing the slot handle: fresh
        // markers, fresh effect, fresh build of the CURRENT committed segment.
        container.querySelector<HTMLButtonElement>('#reset')!.click();
        await flush();
        expect(container.querySelector('#caught')).toBeNull();
        expect(container.querySelector('#leaf')!.textContent).toBe('recovered');
        expect(attempts).toBe(2);
        cleanup();
    });

    it('catches the child segment\'s lazy-chunk load FAILURE', async () =>
    {
        const routes: Route[] =
        [{
            path: '/p',
            component: guardedLayout,
            children: [{ path: 'x', lazy: () => Promise.reject(new Error('chunk gone')) }]
        }];
        const { container, cleanup } = mountApp(routes, '/p/x');
        await flush();

        expect(container.querySelector('#layout')).not.toBeNull();
        expect(container.querySelector('#caught')).not.toBeNull();
        expect(container.querySelector('#caught')!.textContent).toContain('chunk');
        cleanup();
    });

    it('a boundary OUTSIDE <Routes> still catches segment-0 errors', () =>
    {
        const routes: Route[] =
        [{
            path: '/',
            component: (): HTMLElement =>
            {
                throw new Error('root exploded');
            }
        }];
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() =>
        {
            const router = createRouter({ routes, history: createMemoryHistory('/') });
            return ErrorBoundary({
                fallback: (error) => h('div', { id: 'outer-caught' }, String(error instanceof Error ? error.message : error)),
                children: () => h('div', { id: 'app' }, Routes({ router }))
            });
        }, container);

        expect(container.querySelector('#outer-caught')!.textContent).toContain('root exploded');
        render(() => h('div', {}), container);
        container.remove();
    });

    it('a NAVIGATION into an exploding child routes the throw to the in-layout boundary (capture-at-creation on a re-run)', async () =>
    {
        const Fine = (): HTMLElement => h('span', { id: 'fine' }, 'fine');
        const Exploding = (): HTMLElement =>
        {
            throw new Error('later leaf exploded');
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: guardedLayout,
            children:
            [
                { path: 'ok', component: Fine },
                { path: 'boom', component: Exploding }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/p/ok');
        expect(container.querySelector('#fine')).not.toBeNull();

        router.navigate('/p/boom');
        await flush();
        // The slot effect was created at placement, INSIDE the boundary's capture: the
        // re-run's throw is delivered there, and the retained layout survives.
        expect(container.querySelector('#layout')).not.toBeNull();
        expect(container.querySelector('#caught')!.textContent).toContain('later leaf exploded');
        expect(container.querySelector('#fine')).toBeNull();
        cleanup();
    });
});
