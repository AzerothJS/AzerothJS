// @vitest-environment happy-dom
//
// Placement fixtures (h-land half): the hand-written h() layout (the appendChild
// funnel point), the pass-through layout ((props) => props.children - the router's own
// appendToCo path), the ErrorBoundary-wrapped placement, the Transition and Portal
// REFUSALS (DEV throws by name), and the resolveThunks invariant. The compiled
// half lives in the compiler package (router-slot-compiled.spec.ts).
import { describe, it, expect } from 'vitest';
import { h, render, renderToString, ErrorBoundary, Transition, Portal } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes } from 'azerothjs';
import { resolveThunks } from 'azerothjs/internal';
import type { Route, Router, MountNode } from 'azerothjs';

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

const leafRoutes = (layout: (props: { children?: MountNode | undefined }) => MountNode): Route[] =>
    [{
        path: '/p',
        component: layout,
        children: [{ path: '', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
    }];

describe('the hand-written h() layout (appendChild funnel point)', () =>
{
    it('a handle as a direct h() child places its markers and content, no stringification', () =>
    {
        const HLayout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' }, h('header', {}, 'top'), props.children);
        const { container, cleanup } = mountApp(leafRoutes(HLayout), '/p');

        const layout = container.querySelector('#layout')!;
        expect(layout.querySelector('#leaf')).not.toBeNull();
        expect(layout.textContent).not.toContain('[object Object]');
        const comments = Array.from(layout.childNodes).filter((n) => n.nodeType === 8).map((n) => (n as Comment).data);
        expect(comments).toContain('outlet');
        expect(comments).toContain('/outlet');
        cleanup();
    });
});

describe('pass-through and boundary-wrapped placements', () =>
{
    it('a pass-through layout ((props) => props.children - the appendToCo path) renders the chain', () =>
    {
        const PassThrough = (props: { children?: MountNode | undefined }): MountNode =>
            props.children as never;
        const { container, cleanup } = mountApp(leafRoutes(PassThrough), '/p');
        expect(container.querySelector('#leaf')).not.toBeNull();
        expect(container.textContent).not.toContain('[object Object]');
        cleanup();
    });

    it('an ErrorBoundary-wrapped placement renders the chain through the boundary', () =>
    {
        const Guarded = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' },
                ErrorBoundary({
                    fallback: (error) => h('div', { id: 'caught' }, String(error)),
                    children: () => props.children as never
                }));
        const { container, cleanup } = mountApp(leafRoutes(Guarded), '/p');
        expect(container.querySelector('#leaf')).not.toBeNull();
        expect(container.querySelector('#caught')).toBeNull();
        cleanup();
    });

    it('a Transition-wrapped placement hits the REFUSAL diagnostic', () =>
    {
        const Refused = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' },
                Transition({ when: true, name: 'fade', children: () => props.children as never }));
        const container = document.createElement('div');
        document.body.appendChild(container);
        expect(() =>
        {
            render(() =>
            {
                const router = createRouter({ routes: leafRoutes(Refused), history: createMemoryHistory('/p') });
                return h('div', {}, Routes({ router }));
            }, container);
        }).toThrow(/cannot be placed inside <Transition>/);
        container.remove();
    });
});

describe('the Portal refusal', () =>
{
    const host = (): HTMLElement =>
    {
        const el = document.createElement('div');
        document.body.appendChild(el);
        return el;
    };
    const PortalLayout = (target: HTMLElement) => (props: { children?: MountNode | undefined }): MountNode =>
        h('div', { id: 'layout' },
            Portal({ target, children: () => props.children as never }));

    it('dom mode: DEV-throws by name', () =>
    {
        const target = host();
        const container = document.createElement('div');
        document.body.appendChild(container);
        expect(() =>
        {
            render(() =>
            {
                const router = createRouter({ routes: leafRoutes(PortalLayout(target)), history: createMemoryHistory('/p') });
                return h('div', {}, Routes({ router }));
            }, container);
        }).toThrow(/cannot be placed inside <Portal>/);
        container.remove();
        target.remove();
    });

    it('string mode: DEV-throws by name (a slot cannot escape its range into the body)', () =>
    {
        const target = host();
        expect(() =>
        {
            const router = createRouter({ routes: leafRoutes(PortalLayout(target)), history: createMemoryHistory('/p') });
            renderToString(() => h('div', {}, Routes({ router })));
        }).toThrow(/cannot be placed inside <Portal>/);
        target.remove();
    });
});

describe('the resolveThunks invariant', () =>
{
    it('resolveThunks(handle) === handle - the non-callable brand passes through untouched', () =>
    {
        let captured: unknown = null;
        const Capturing = (props: { children?: MountNode | undefined }): MountNode =>
        {
            captured = props.children;
            return h('div', { id: 'layout' }, props.children);
        };
        const { container, cleanup } = mountApp(leafRoutes(Capturing), '/p');

        expect(captured).not.toBeNull();
        expect(typeof captured).toBe('object');
        expect(resolveThunks(captured)).toBe(captured);
        expect(container.querySelector('#leaf')).not.toBeNull();
        cleanup();
    });
});

describe('a LITERAL handle inside a reactive array is refused', () =>
{
    it('DEV-throws by name instead of corrupting the slot bookkeeping', () =>
    {
        const ArrayLayout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' }, () => [props.children]);
        const container = document.createElement('div');
        document.body.appendChild(container);
        expect(() =>
        {
            render(() =>
            {
                const router = createRouter({ routes: leafRoutes(ArrayLayout), history: createMemoryHistory('/p') });
                return h('div', {}, Routes({ router }));
            }, container);
        }).toThrow(/reactive array value/);
        container.remove();
    });
});
