// @vitest-environment node
//
// Page actions: a plain `<form method="post">` posting to its own page, with no client JS.
// Measured before this existed, that submit answered 405 with `Allow: GET, HEAD` - mountPages
// registered GET only, so a page could not receive the form it rendered.
//
// The CSRF arms are the reason this file is careful. A page action is a browser-reachable write
// endpoint, and the header guard cannot cover it: a plain form cannot set a header, which is why
// the token travels in a hidden field and is checked before the action runs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { App, csrfToken } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import type { PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const COOKIE = 'azcsrf';
const CSRF = { cookie: COOKIE };

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
    const dir = mkdtempSync(join(tmpdir(), 'az-action-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    return dir;
}

const component = (): HTMLElement => (undefined as unknown as HTMLElement);

/** Renders the action's refusal into the markup, so a test can see it reached the page. */
const renderer = (url: string, shell: string, options?: { actionResult?: unknown }): Promise<PageResult> =>
    Promise.resolve({
        kind: 'html',
        status: 200,
        html: shell.replace('<div id="root"></div>',
            `<div id="root">SSR:${ url }|refusal:${ JSON.stringify(options?.actionResult ?? null) }</div>`)
    });

interface Harness { app: App; token: string; post: (fields: Record<string, string>, headers?: Record<string, string>) => Promise<Response> }

function harness(action: PageRoute['action'], withRenderer = true): Harness
{
    const app = new App();
    const routes: PageRoute[] = [{ path: '/todos', component, ...(action !== undefined ? { action } : {}) }];
    mountPages(app, {
        routes,
        clientDir: clientDir(),
        csrf: CSRF,
        ...(withRenderer ? { renderer } : {})
    });
    const token = csrfToken();
    const post = (fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> =>
        app.handle(new Request('http://local/todos', {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                cookie: `${ COOKIE }=${ token }`,
                origin: 'http://local',
                ...headers
            },
            body: new URLSearchParams(fields).toString()
        }));
    return { app, token, post };
}

describe('a page action receives the form its page renders', () =>
{
    it('a successful action answers 303 back to the page, so a refresh cannot re-post', async () =>
    {
        const seen: string[] = [];
        const { token, post } = harness(async ({ form }) =>
        {
            seen.push(form.get('text') ?? '');
            return undefined;
        });

        const response = await post({ text: 'ship it', _csrf: token });
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/todos');
        // Identity-dependent by definition: a shared cache must not replay one visitor's write.
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(seen).toEqual(['ship it']);
    });

    it('the CSRF token never reaches the action', async () =>
    {
        const seen: string[][] = [];
        const { token, post } = harness(async ({ form }) =>
        {
            seen.push([...form.keys()]);
            return undefined;
        });

        await post({ text: 'ship it', _csrf: token });
        // Leaving it in would put it in front of every schema that validates the fields.
        expect(seen[0]).toEqual(['text']);
    });

    it('a REFUSED action re-renders the page at 422 with its result in hand', async () =>
    {
        const { token, post } = harness(async () => ({ fields: { text: 'Required' } }));

        const response = await post({ text: '', _csrf: token });
        expect(response.status).toBe(422);
        const html = await response.text();
        // The page rendered again, and the refusal reached it.
        expect(html).toContain('SSR:/todos');
        expect(html).toContain('"text":"Required"');
    });

    it('an action that throws redirect() sends the visitor there instead', async () =>
    {
        const { redirect } = await import('azerothjs');
        const { token, post } = harness(async () =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a redirect sentinel is a branded value, not an Error: throwing it IS the documented API
            throw redirect('/signed-in');
        });

        const response = await post({ _csrf: token });
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/signed-in');
    });

    it('a page with NO action still answers 405 - nothing there accepts a write', async () =>
    {
        const { post } = harness(undefined);
        const response = await post({ text: 'ship it' });
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('GET, HEAD');
    });
});

describe('a page action is CSRF-guarded before it runs', () =>
{
    it('refuses a submit carrying no token, without running the action', async () =>
    {
        const action = vi.fn(async () => undefined);
        const { post } = harness(action);

        const response = await post({ text: 'forged' });
        expect(response.status).toBe(403);
        expect(action).not.toHaveBeenCalled();
    });

    it('refuses a mismatched token', async () =>
    {
        const action = vi.fn(async () => undefined);
        const { post } = harness(action);

        const response = await post({ text: 'forged', _csrf: csrfToken() });
        expect(response.status).toBe(403);
        expect(action).not.toHaveBeenCalled();
    });

    it('refuses a cross-site origin even with a valid token', async () =>
    {
        const action = vi.fn(async () => undefined);
        const { token, post } = harness(action);

        // The token is right; the request is not from this site. A stolen token must not be
        // enough on its own.
        const response = await post({ text: 'forged', _csrf: token }, { origin: 'https://evil.example' });
        expect(response.status).toBe(403);
        expect(action).not.toHaveBeenCalled();
    });

    it('refuses a cross-site request that sends NO Origin at all', async () =>
    {
        const action = vi.fn(async () => undefined);
        const { token, post } = harness(action);

        // Origin omitted, so the origin comparison has nothing to judge; Sec-Fetch-Site is what
        // is left, and it says cross-site. (A request carrying a SAME-origin Origin alongside a
        // cross-site Sec-Fetch-Site is contradictory - no browser emits it - and the Origin is
        // authoritative there, which is pre-existing csrfProtect behaviour this shares.)
        const response = await post({ text: 'forged', _csrf: token },
            { 'sec-fetch-site': 'cross-site', origin: '' });
        expect(response.status).toBe(403);
        expect(action).not.toHaveBeenCalled();
    });

    it('CONTROL: the same submit succeeds same-origin with the right token', async () =>
    {
        const action = vi.fn(async () => undefined);
        const { token, post } = harness(action);

        const response = await post({ text: 'fine', _csrf: token }, { 'sec-fetch-site': 'same-origin' });
        expect(response.status).toBe(303);
        expect(action).toHaveBeenCalledTimes(1);
    });
});
