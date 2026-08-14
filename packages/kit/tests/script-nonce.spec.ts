// @vitest-environment node
//
// The scriptNonce option is a per-request callback over the live RequestContext, so its
// value is host code output, not framework-vetted data. A CSP nonce is a base64/base64url
// token by grammar; anything else is either an injection attempt riding request data or a
// broken generator, and both must be REFUSED loudly - a policy would reject the token
// anyway, so escaping garbage into the attribute only hides the misconfiguration.
import { describe, expect, it } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, css, h } from 'azerothjs';
import type { LoaderHandoff, Route } from 'azerothjs';
import { createPageRenderer } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

const routes: Route[] = [{
    path: '/',
    component: () =>
    {
        const styles = css('.pin { color: rgb(3, 3, 3); }');
        return h('p', { class: styles.pin }, 'hello');
    }
}];

const PageApp = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({
            routes,
            history: createMemoryHistory(props.url ?? '/'),
            initialLoaderData: props.handoff
        }),
        children: () => Routes({ fallback: () => h('h1', {}, 'nf') })
    }) as HTMLElement;

const render = createPageRenderer(PageApp, routes);

describe('scriptNonce is validated as a CSP token', () =>
{
    it.each([
        'abc" onmouseover="alert(1)',
        '"><script>alert(1)</script>',
        'with space',
        'tab\there',
        ''
    ])('refuses %j on the buffered path', async (nonce) =>
    {
        await expect(render('/', SHELL, { scriptNonce: nonce })).rejects.toThrow(/CSP nonce/);
    });

    it('refuses a hostile nonce on the streaming path too', async () =>
    {
        await expect(render('/', SHELL, { stream: true, scriptNonce: 'x" onload="evil' }))
            .rejects.toThrow(/CSP nonce/);
    });

    it('accepts the full base64/base64url alphabet and stamps it verbatim', async () =>
    {
        const result = await render('/', SHELL, { scriptNonce: 'ok+Base64/chars_-==' });
        expect(result.kind).toBe('html');
        const html = (result as { html: string }).html;

        expect(html).toContain('<style data-azeroth-css nonce="ok+Base64/chars_-==">');
    });
});
