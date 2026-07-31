// @vitest-environment node
//
// Scoped CSS registered DURING a string render goes into a single module-level frame
// (`frameCss`/`frameOwner` in renderer/css.ts), keyed by the render's store scope and drained by
// collectStyleSheet. There is exactly ONE frame, replaced whenever the owner changes.
//
// That design is correct only while a render cannot be interleaved with another. If one ever
// could - a component that awaits, or renderToString becoming async - request A would resume to
// find request B's frame in place and collect B's styles into A's page. The failure is a
// cross-request data bleed on a shared server, not a crash, so nothing would surface it.
//
// The invariant is load-bearing and was pinned by nothing. These tests pin it: the first two hold
// the synchrony that makes interleaving impossible, the rest hold the isolation that synchrony
// buys. If someone later makes rendering async, the first test fails and points here.
import { describe, expect, it } from 'vitest';

import { collectStyleSheet, css, h, renderToStaticMarkup, renderToString, resetStyleSheet } from '../../src/index.ts';

describe('a string render cannot interleave with another', () =>
{
    it('renderToString returns a string, not a promise', () =>
    {
        const result = renderToString(() => h('div', {}, 'x'));

        expect(typeof result).toBe('string');
        expect(result).not.toBeInstanceOf(Promise);
    });

    it('completes without yielding to the microtask queue', async () =>
    {
        // If the render yielded, this flag would flip before renderToString returned.
        let yielded = false;
        void Promise.resolve().then(() =>
        {
            yielded = true;
        });

        renderToStaticMarkup(() => h('div', {}, 'x'));

        expect(yielded).toBe(false);
        await Promise.resolve();
        expect(yielded).toBe(true); // the microtask really was pending, so the check meant something
    });
});

describe('scoped css does not bleed between renders', () =>
{
    it('gives each render only the styles that render registered', () =>
    {
        resetStyleSheet();

        const first = renderToStaticMarkup(() =>
        {
            const scoped = css`.only-first { color: rgb(1, 1, 1); }`;
            return h('div', { class: scoped['only-first'] }, 'a');
        });
        const firstSheet = collectStyleSheet();

        const second = renderToStaticMarkup(() =>
        {
            const scoped = css`.only-second { color: rgb(2, 2, 2); }`;
            return h('div', { class: scoped['only-second'] }, 'b');
        });
        const secondSheet = collectStyleSheet();

        expect(first).not.toBe(second);
        expect(firstSheet).toContain('rgb(1, 1, 1)');
        expect(firstSheet).not.toContain('rgb(2, 2, 2)');
        expect(secondSheet).toContain('rgb(2, 2, 2)');
        expect(secondSheet).not.toContain('rgb(1, 1, 1)');
    });

    it('does not accumulate a render-registered scope into later renders', () =>
    {
        resetStyleSheet();

        for (let i = 0; i < 5; i++)
        {
            renderToStaticMarkup(() =>
            {
                const scoped = css`.row { color: rgb(${ i }, 0, 0); }`;
                return h('div', { class: scoped.row }, `row ${ i }`);
            });
            collectStyleSheet();
        }

        // A sixth render must see its own scope and nothing from the five before it - otherwise
        // the module registry is growing by one entry per render, forever.
        renderToStaticMarkup(() =>
        {
            const scoped = css`.row { color: rgb(9, 9, 9); }`;
            return h('div', { class: scoped.row }, 'last');
        });
        const sheet = collectStyleSheet();

        expect(sheet).toContain('rgb(9, 9, 9)');
        for (let i = 0; i < 5; i++)
        {
            expect(sheet).not.toContain(`rgb(${ i }, 0, 0)`);
        }
    });

    it('leaves nothing behind for the next render to collect', () =>
    {
        resetStyleSheet();

        renderToStaticMarkup(() =>
        {
            const scoped = css`.transient { color: rgb(7, 7, 7); }`;
            return h('div', { class: scoped.transient }, 'x');
        });
        expect(collectStyleSheet()).toContain('rgb(7, 7, 7)');

        // Draining is what stops one request's styles reaching the next.
        expect(collectStyleSheet()).not.toContain('rgb(7, 7, 7)');
    });
});
