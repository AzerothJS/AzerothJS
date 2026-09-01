// @vitest-environment node
//
// The two representations of one page action, and the token that makes the first submit work.
//
// The gap this closes was found in a browser: `csrfCookie` mints on the RESPONSE, so a
// visitor's very first page load rendered a form with an EMPTY token and its first submit
// would have failed its own check. The token is now resolved before the render, so the markup
// and the Set-Cookie carry the same value.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { App, csrfCookie, csrfToken, pipeline } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import type { PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const COOKIE = 'azcsrf';
const CSRF = { cookie: COOKIE, secure: false };

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function clientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-enh-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    return dir;
}

const component = (): HTMLElement => (undefined as unknown as HTMLElement);

/** Renders the token it was handed, so a test can compare it against the Set-Cookie. */
const renderer = (_url: string, shell: string, options?: { csrfToken?: string }): Promise<PageResult> =>
    Promise.resolve({
        kind: 'html',
        status: 200,
        html: shell.replace('<div id="root"></div>',
            `<div id="root"><input name="_csrf" value="${ options?.csrfToken ?? '' }"></div>`)
    });

function build(action: PageRoute['action']): App
{
    const app = new App();
    const routes: PageRoute[] = [{ path: '/todos', component, ...(action !== undefined ? { action } : {}) }];
    mountPages(app, { routes, clientDir: clientDir(), csrf: CSRF, renderer });
    return app;
}

describe('the token a form renders with', () =>
{
    it('is minted for a FIRST visit, and the markup carries what the cookie will hold', async () =>
    {
        const app = build(async () => undefined);
        // No cookie: exactly a visitor's first load.
        const response = await app.handle(new Request('http://local/todos'));
        const html = await response.text();

        const setCookie = response.headers.getSetCookie().find((entry) => entry.startsWith(`${ COOKIE }=`));
        expect(setCookie).toBeDefined();
        const minted = (setCookie as string).slice(COOKIE.length + 1).split(';')[0] ?? '';
        expect(minted.length).toBeGreaterThan(16);
        // The form and the browser must agree, or the first submit fails its own check.
        expect(html).toContain(`value="${ minted }"`);
    });

    it('reuses the cookie a returning visitor already has, minting nothing', async () =>
    {
        const app = build(async () => undefined);
        const existing = csrfToken();
        const response = await app.handle(new Request('http://local/todos', {
            headers: { cookie: `${ COOKIE }=${ existing }` }
        }));

        expect(response.headers.getSetCookie()).toEqual([]);
        expect(await response.text()).toContain(`value="${ existing }"`);
    });

    it('csrfCookie does not mint a RIVAL token behind the mount', async () =>
    {
        const app = build(async () => undefined);
        const handler = pipeline(app, csrfCookie(CSRF));
        const response = await handler.handle(new Request('http://local/todos'));

        // Two Set-Cookie headers for one name would leave the browser holding the last while
        // the rendered form carried the first: every first submit rejected.
        const minted = response.headers.getSetCookie().filter((entry) => entry.startsWith(`${ COOKIE }=`));
        expect(minted).toHaveLength(1);
        expect(await response.text()).toContain(minted[0]?.slice(COOKIE.length + 1).split(';')[0] as string);
    });
});

describe('a page action answers what the client asked for', () =>
{
    const token = csrfToken();
    const post = (app: App, accept: string, fields: Record<string, string>): Promise<Response> =>
        app.handle(new Request('http://local/todos', {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                cookie: `${ COOKIE }=${ token }`,
                origin: 'http://local',
                accept
            },
            body: new URLSearchParams({ ...fields, _csrf: token }).toString()
        }));

    it('an ENHANCED submit gets the value, not a redirect it cannot follow', async () =>
    {
        const app = build(async ({ form }) => (form.get('text') === '' ? { fields: { text: 'Required' } } : undefined));

        const accepted = await post(app, 'application/json', { text: 'ship it' });
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ ok: true });

        const refused = await post(app, 'application/json', { text: '' });
        expect(refused.status).toBe(422);
        expect(await refused.json()).toEqual({ ok: false, result: { fields: { text: 'Required' } } });
        // A write's answer is about one visitor and must never be replayed to another.
        expect(refused.headers.get('cache-control')).toBe('private, no-store');
    });

    it('a NATIVE submit still gets the redirect and the rendered page', async () =>
    {
        const app = build(async ({ form }) => (form.get('text') === '' ? { fields: { text: 'Required' } } : undefined));

        const accepted = await post(app, 'text/html,application/xhtml+xml', { text: 'ship it' });
        expect(accepted.status).toBe(303);
        expect(accepted.headers.get('location')).toBe('/todos');

        const refused = await post(app, 'text/html,application/xhtml+xml', { text: '' });
        expect(refused.status).toBe(422);
        expect(refused.headers.get('content-type')).toContain('text/html');
    });

    it('a client that sends NO Accept gets the native answer, not a body it cannot follow', async () =>
    {
        const app = build(async () => undefined);
        // Asked positively for JSON, so an unknown client falls to what a browser would get.
        const response = await post(app, '', { text: 'ship it' });
        expect(response.status).toBe(303);
    });
});
