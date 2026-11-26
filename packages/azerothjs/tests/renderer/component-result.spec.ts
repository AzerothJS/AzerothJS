import { describe, expect, it } from 'vitest';
import { ErrorBoundary, For, Portal, Transition, h, render, renderToString, ssr } from 'azerothjs';

// A compiled component can return an expression even when its consumer requires an
// element for live DOM work. Exercise the same value through both public writers.
const results = [
    { name: 'text', make: () => 'plain text', html: 'plain text', liveText: 'plain text' },
    { name: 'number', make: () => 7, html: '7', liveText: '7' },
    { name: 'server markup', make: () => ssr('<b>parcel</b>'), html: '<b>parcel</b>', liveText: '[object Object]' },
    { name: 'element', make: () => h('b', {}, 'parcel'), html: '<b>parcel</b>', liveText: 'parcel' }
];

describe.each(results)('a $name component result', ({ name, make, html, liveText }) =>
{
    // Emulate the runtime value produced by a component expression at a typed element slot.
    const child = (): HTMLElement => make() as HTMLElement;
    const positions = {
        For: () => For({ each: [1], key: n => n, children: child }),
        Transition: () => Transition({ when: true, children: child }),
        Portal: (host: HTMLElement) => Portal({ target: host, children: child })
    };
    it.each(Object.entries(positions))('serializes static content and requires a live element in %s', (_label, build) =>
    {
        const host = document.createElement('div');
        const app = (): HTMLElement => h('main', {}, build(host));
        expect(renderToString(app)).toContain(html);
        if (name === 'element')
        {
            render(app, host);
            expect(host.querySelector('b')?.textContent).toBe('parcel');
            render(() => h('aside', {}), host);
        }
        else
        {
            expect(() => render(app, host)).toThrow();
        }
    });

    it('materializes a protected result and an error fallback in an ErrorBoundary', () =>
    {
        const host = document.createElement('div');
        for (const fail of [false, true])
        {
            const app = (): HTMLElement => h('main', {}, ErrorBoundary({
                children: () =>
                {
                    if (fail)
                    {
                        throw new Error('parcel unavailable');
                    }
                    return child();
                },
                fallback: child
            }));
            expect(renderToString(app)).toContain(html);
            render(app, host);
            expect(host.textContent).toBe(liveText);
            expect(host.querySelector('b') !== null).toBe(name === 'element');
        }
        render(() => h('aside', {}), host);
    });
});
