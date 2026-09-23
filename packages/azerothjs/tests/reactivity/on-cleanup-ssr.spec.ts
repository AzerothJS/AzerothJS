// @vitest-environment node
//
// onCleanup during a server render: outside an effect or memo it registers nothing, so a
// cleanup that touches a browser global cannot break the render. Runs with no DOM on purpose.
import { describe, it, expect } from 'vitest';
import { createMemo, getOwner, h, onCleanup, renderToStream, renderToString, runWithOwner } from 'azerothjs';

describe('onCleanup during a server render', () =>
{
    it('does not run a component-body cleanup that reads window', () =>
    {
        expect(typeof window).toBe('undefined');
        const Timer = (): HTMLElement =>
        {
            onCleanup(() => window.clearTimeout(1));
            return h('p', {}, 'a');
        };
        expect(renderToString(() => Timer())).toBe('<p>a</p>');
    });

    it('registers nothing from a component body in renderToString or renderToStream', async () =>
    {
        let ran = 0;
        const Flag = (): HTMLElement =>
        {
            onCleanup(() =>
            {
                ran++;
            });
            return h('p', {}, 'a');
        };
        renderToString(() => Flag());
        expect(ran).toBe(0);
        const html = await new Response(renderToStream(() => Flag())).text();
        expect(html).toContain('<p');
        expect(ran).toBe(0);
    });

    it('still runs a cleanup registered inside a memo when the render disposes it', () =>
    {
        let ran = 0;
        renderToString(() =>
        {
            const label = createMemo(() =>
            {
                onCleanup(() =>
                {
                    ran++;
                });
                return 'a';
            });
            return h('p', {}, () => label());
        });
        expect(ran).toBe(1);
    });

    it('releases a runWithOwner continuation that resumes after the render', async () =>
    {
        let ticks = 0;
        let id: ReturnType<typeof setInterval> | undefined;
        let resumed!: Promise<void>;
        try
        {
            renderToString(() =>
            {
                const owner = getOwner();
                resumed = Promise.resolve().then(() => runWithOwner(owner, () =>
                {
                    const interval = setInterval(() =>
                    {
                        ticks++;
                    }, 1);
                    id = interval;
                    onCleanup(() => clearInterval(interval));
                }));
                return h('p', {}, 'a');
            });
            await resumed;
            expect(id).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(ticks).toBe(0);
        }
        finally
        {
            clearInterval(id);
        }
    });
});
