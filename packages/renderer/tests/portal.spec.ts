// @vitest-environment happy-dom
//
// Behavioral coverage for Portal/destroyPortal (portal.ts): relocation to a
// target, hidden placeholder in the local tree, custom targets, manual destroy
// (idempotent), auto-cleanup via the shared MutationObserver when the
// placeholder leaves the document, and cleanup on surrounding-root disposal.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot } from '@azerothjs/reactivity';
import { h, render, Portal, destroyPortal, Show, createRef } from '@azerothjs/renderer';

// Let the shared MutationObserver flush (it fires on a microtask in happy-dom).
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Portal', () =>
{
    it('renders content into document.body and leaves a hidden placeholder locally', () =>
    {
        let placeholder!: HTMLElement;
        createRoot((dispose) =>
        {
            placeholder = Portal({ children: () => h('div', { class: 'modal' }, 'Hi') });
            expect(placeholder.tagName).toBe('SPAN');
            expect(placeholder.style.display).toBe('none');
            expect(placeholder.hasAttribute('data-azeroth-portal')).toBe(true);
            // Content lives in the body, not in the placeholder.
            const modal = document.body.querySelector('.modal');
            expect(modal).not.toBeNull();
            expect(placeholder.contains(modal)).toBe(false);
            dispose();
        });
    });

    it('renders into a custom target element', () =>
    {
        const layer = document.createElement('div');
        layer.id = 'layer';
        document.body.appendChild(layer);
        createRoot((dispose) =>
        {
            Portal({ target: layer, children: () => h('div', { class: 'tip' }, 'Tip') });
            expect(layer.querySelector('.tip')).not.toBeNull();
            dispose();
        });
        layer.remove();
    });

    it('destroyPortal removes the content from the target and is idempotent', () =>
    {
        createRoot((dispose) =>
        {
            const placeholder = Portal({ children: () => h('div', { class: 'm2' }, 'Modal') });
            expect(document.body.querySelector('.m2')).not.toBeNull();

            destroyPortal(placeholder);
            expect(document.body.querySelector('.m2')).toBeNull();
            // Second call is a safe no-op.
            expect(() => destroyPortal(placeholder)).not.toThrow();
            dispose();
        });
    });

    it('destroyPortal on a non-portal element is a safe no-op', () =>
    {
        const plain = h('div', {});
        expect(() => destroyPortal(plain)).not.toThrow();
    });

    it('cleans up when the surrounding root disposes', () =>
    {
        let placeholder!: HTMLElement;
        const dispose = createRoot((d) =>
        {
            placeholder = Portal({ children: () => h('div', { class: 'm3' }, 'X') });
            return d;
        });
        expect(document.body.querySelector('.m3')).not.toBeNull();

        dispose();
        // Root teardown runs cleanup synchronously.
        expect(document.body.querySelector('.m3')).toBeNull();
        // The accessor is unused after dispose; reference placeholder to keep lint happy.
        expect(placeholder.tagName).toBe('SPAN');
    });

    it('auto-removes portaled content when its placeholder leaves the document', async () =>
    {
        const [shown, setShown] = createSignal(true);
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => h('div', {}, Show({
            when: shown,
            children: () => Portal({ children: () => h('div', { class: 'm4' }, 'Modal') })
        })), container);
        expect(document.body.querySelector('.m4')).not.toBeNull();

        // Toggling Show removes the placeholder from the document; the shared
        // observer then disposes the portaled content.
        setShown(false);
        await flush();
        expect(document.body.querySelector('.m4')).toBeNull();
        container.remove();
    });

    it('content built inside a portal is live (effects run in its own root)', () =>
    {
        const ref = createRef<HTMLDivElement>();
        createRoot((dispose) =>
        {
            Portal({ children: () => h('div', { class: 'm5', ref }, 'live') });
            // The ref was populated, proving the content factory ran.
            expect(ref.current).not.toBeNull();
            expect(ref.current!.textContent).toBe('live');
            dispose();
        });
    });
});
