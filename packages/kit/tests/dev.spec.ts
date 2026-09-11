// @vitest-environment node
//
// The dev session serves the page contract production serves. Every arm drives the REAL session
// over the fixture application at tests/fixtures/dev-app - one vite, one App, the same
// mountPages - so a divergence between the two modes shows up here rather than in a browser.
//
// This spec runs in its OWN vitest project, with the `azerothjs` alias off: vite loads the
// runtime from node_modules (the BUILT package), and the spec must bind that same copy or the
// session and the render hold two instances of it. The gate arms below refuse to trust anything
// else first.
import { execSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { cached, createSignal, createStore } from 'azerothjs';
import { App, CSRF_FIELD, json, onWorkUnitCleanup, pipeline } from '@azerothjs/http';
import type { HandlerWrapper, RequestObserver, WebHandler } from '@azerothjs/http';
import { serve } from '@azerothjs/http/node';
import { imageHandler, mountPages } from '@azerothjs/kit';
import type { KitOptions, PageRoute } from '@azerothjs/kit';
import type { PageRenderer } from '@azerothjs/kit/ssr';
import * as devByName from '@azerothjs/kit/dev';
import * as devBySource from '../src/dev/index.ts';
import { SSR_SOURCE_ENTRY } from '@azerothjs/kit/dev/entry';

const { devPages, isLoopbackAddress, supportsVite } = devByName;
type DevSession = devByName.DevSession;

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const FIXTURE = join(here, 'fixtures', 'dev-app');
const TEMP = join(here, 'fixtures', 'dev-tmp');
const ESC = String.fromCharCode(27);

const ORIGIN = 'http://local.test';
/** What a browser sends navigating, and what a module fetch or an image sends. */
const NAVIGATE = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const JSON_ACCEPT = 'application/json';
const TOKEN = 'a'.repeat(32);
const CSRF = { cookie: 'azcsrf', secure: false };

/** What the spec needs from vite, typed structurally so this file imports no vite type. */
interface ViteProbe
{
    config: {
        root: string;
        plugins: Array<{ name: string; watchChange?: unknown }>;
        logger: { warn: (message: string) => void };
        server: { ws: { server: { listenerCount: (event: string) => number } } };
    };
    restart: () => Promise<void>;
    environments: { ssr: { moduleGraph: { onFileChange: (file: string) => void } } };
    middlewares: (request: unknown, response: unknown, next: (error?: unknown) => void) => void;
    ssrLoadModule: (id: string) => Promise<Record<string, unknown>>;
}

interface Probe
{
    server?: ViteProbe | undefined;
    onWatchChange?: ((id: string, change: unknown) => void) | undefined;
    onConfigureServer?: ((server: unknown) => Promise<void>) | undefined;
}

/** The fixture's own vite config publishes this: the session keeps its server private. */
function probe(): Probe
{
    const scope = globalThis as unknown as { __azerothDevProbe?: Probe };
    scope.__azerothDevProbe ??= {};
    return scope.__azerothDevProbe;
}

function assertFresh(src: string, dist: string): void
{
    const srcTime = statSync(join(repo, src)).mtimeMs;
    const distTime = statSync(join(repo, dist)).mtimeMs;
    if (srcTime > distTime)
    {
        throw new Error(`${ dist } is STALE (older than ${ src }) - run \`npm run build -w azerothjs\` before `
            + 'this project: vite loads the BUILT package and every arm here asserts against it.');
    }
}

type PageOptions = Omit<KitOptions, 'routes' | 'renderer' | 'shell' | 'clientDir'>;

interface OpenOptions
{
    root?: string;
    entry?: string;
    pages?: PageOptions;
    routes?: (app: App) => void;
    app?: { dev?: boolean; onError?: (error: unknown, mapped: { status: number }) => void; observe?: RequestObserver };
}

const live: DevSession[] = [];

/** One session over the fixture, closed by the suite whatever an arm does with it. */
async function open(options: OpenOptions = {}): Promise<DevSession>
{
    const session = await devPages({
        root: options.root ?? FIXTURE,
        pages: options.pages ?? { csrf: CSRF },
        routes: options.routes ?? ((): void => undefined),
        app: { dev: true, ...options.app },
        ...(options.entry !== undefined ? { entry: options.entry } : {})
    });
    live.push(session);
    return session;
}

/** A session plus the vite server its fixture config just published. */
async function openWithVite(options: OpenOptions = {}): Promise<{ session: DevSession; vite: ViteProbe }>
{
    const session = await open(options);
    const vite = probe().server;
    if (vite === undefined)
    {
        throw new Error('the fixture config published no vite server - its probe plugin is missing');
    }
    return { session, vite };
}

async function closeSession(session: DevSession): Promise<void>
{
    const at = live.indexOf(session);
    if (at >= 0)
    {
        live.splice(at, 1);
    }
    await session.close();
}

function get(session: DevSession, path: string, headers: Record<string, string> = {}): Promise<Response>
{
    return session.app.handle(new Request(`${ ORIGIN }${ path }`, { headers: { accept: NAVIGATE, ...headers } }));
}

function post(session: DevSession, path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response>
{
    const body = new URLSearchParams({ ...fields, [CSRF_FIELD]: TOKEN });
    return session.app.handle(new Request(`${ ORIGIN }${ path }`, {
        method: 'POST',
        headers: {
            accept: NAVIGATE,
            'content-type': 'application/x-www-form-urlencoded',
            cookie: `${ CSRF.cookie }=${ TOKEN }`,
            origin: ORIGIN,
            ...headers
        },
        body
    }));
}

/** A per-arm copy of the fixture, so no arm writes the tree every other arm reads. */
let copies = 0;
function copyFixture(): string
{
    copies += 1;
    const root = join(TEMP, `app-${ copies }`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    cpSync(FIXTURE, root, { recursive: true, filter: (source) => !source.includes('node_modules') });
    return root;
}

/** A watcher that reports nothing, so an arm sees the session's own invalidation alone. */
const BLIND_WATCH = 'server: { watch: { ignored: ["**/*"] } }';

/** The same tree with a variant vite config beside the fixture's own, which it extends. */
function rootWith(override: string): string
{
    const root = copyFixture();
    writeFileSync(join(root, 'vite.config.js'),
        'import base from \'./vite.config.ts\';\n'
        + `export default { ...base, ${ override } };\n`);
    return root;
}

/** The session's own recorder hook, called the way a watcher event calls it. */
function fireWatchChange(vite: ViteProbe, id: string): void
{
    const recorder = vite.config.plugins.find((plugin) => plugin.name === 'azeroth:dev-session');
    const hook = recorder?.watchChange;
    if (typeof hook !== 'function')
    {
        throw new Error('the session registered no watchChange hook');
    }
    (hook as (this: unknown, id: string, change: { event: string }) => void).call(recorder, id, { event: 'update' });
}

/** Resolves when the session's watcher reports this file, so an arm never races chokidar. */
function watched(name: string): Promise<void>
{
    return new Promise<void>((done) =>
    {
        probe().onWatchChange = (id): void =>
        {
            if (id.endsWith(name))
            {
                probe().onWatchChange = undefined;
                done();
            }
        };
    });
}

/** A built client on disk, for the arms that compare the session with a production mount. */
let clients = 0;
function clientDir(shell: string): string
{
    clients += 1;
    const dir = join(TEMP, `client-${ clients }`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), shell);
    return dir;
}

/** The message a mount that must refuse threw, or a failure saying it did not refuse. */
function mountError(build: () => void): string
{
    try
    {
        build();
    }
    catch (error)
    {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('the mount was expected to throw and did not');
}

beforeAll(() =>
{
    rmSync(TEMP, { recursive: true, force: true });
    mkdirSync(TEMP, { recursive: true });
});

afterEach(() =>
{
    probe().onWatchChange = undefined;
    probe().onConfigureServer = undefined;
});

afterAll(async () =>
{
    for (const session of [...live])
    {
        await session.close();
    }
    live.length = 0;
    rmSync(TEMP, { recursive: true, force: true });
});

describe('gate: the spec binds what the session binds', () =>
{
    it('the built azerothjs is present and fresh', () =>
    {
        assertFresh('packages/azerothjs/src/index.ts', 'packages/azerothjs/dist/index.js');
        assertFresh('packages/azerothjs/src/internal.ts', 'packages/azerothjs/dist/internal.js');
    });

    it('@azerothjs/kit/dev by name is the module this repository builds it from', () =>
    {
        expect(devByName).toBe(devBySource);
        expect(devByName.devPages).toBe(devBySource.devPages);
        expect(SSR_SOURCE_ENTRY).toBe('src/entry.server.ts');
    });

    it('azerothjs by name is the installed package, and is the one the fixture binds', async () =>
    {
        const { session, vite } = await openWithVite();
        await get(session, '/');
        const entry = await vite.ssrLoadModule(join(FIXTURE, 'src', 'entry.server.ts'));
        const source = await import('../../azerothjs/src/index.ts');

        // One process, one runtime: the request scope, the data cache and the store registry all
        // live on the copy each side resolved.
        expect(entry.createSignal).toBe(createSignal);
        expect(source.createSignal).not.toBe(createSignal);
        await closeSession(session);
    });
});

describe('the page contract, through the session', () =>
{
    let session: DevSession;
    let vite: ViteProbe;

    beforeAll(async () =>
    {
        const opened = await openWithVite({
            pages: { csrf: CSRF },
            routes: (app) =>
            {
                app.get('/_image', imageHandler({ root: join(FIXTURE, 'public') }));
                app.get('/api/ping', () => json({ ok: true }));
            }
        });
        session = opened.session;
        vite = opened.vite;
    });

    it('a guarded page answers 401 with the blocked UI, never the protected page', async () =>
    {
        const response = await get(session, '/guarded');
        const body = await response.text();

        expect(response.status).toBe(401);
        expect(body).toContain('id="blocked"');
        expect(body).toContain('NO ACCESS');
        expect(body).toContain('>401<');
        expect(body).not.toContain('THE PROTECTED PAGE');
    });

    it('a vetoed page answers 403', async () =>
    {
        const response = await get(session, '/forbidden');

        expect(response.status).toBe(403);
        expect(await response.text()).toContain('>403<');
    });

    it('a loader that throws notFound() answers 404', async () =>
    {
        const response = await get(session, '/missing');

        expect(response.status).toBe(404);
    });

    it('an unrouted navigation gets the app\'s own 404 page', async () =>
    {
        const response = await get(session, '/nothing-here');

        expect(response.status).toBe(404);
        expect(await response.text()).toContain('NOT FOUND');
    });

    it('GET / renders the home page', async () =>
    {
        const response = await get(session, '/');

        expect(response.status).toBe(200);
        expect(await response.text()).toContain('HOME PAGE');
    });

    it('an enumerated static parameterised page renders live, listed params and unlisted alike', async () =>
    {
        const listed = await get(session, '/item/one');
        const unlisted = await get(session, '/item/two');

        expect(listed.status).toBe(200);
        expect(await listed.text()).toContain('ITEM one');
        expect(unlisted.status).toBe(200);
        expect(await unlisted.text()).toContain('ITEM two');
    });

    it('a page action POST answers 303 and the write ran', async () =>
    {
        const response = await post(session, '/sign', { text: 'WELL MET' });

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/sign');
        expect(await (await get(session, '/sign')).text()).toContain('WELL MET');
    });

    it('an enhanced submit gets the JSON envelope', async () =>
    {
        const response = await post(session, '/sign', { text: 'ENHANCED' }, { accept: JSON_ACCEPT });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('a page action over a non-loopback origin passes with csrf threaded', async () =>
    {
        const lan = 'http://desk.lan:3000';
        const threaded = await open({ pages: { csrf: { ...CSRF, allowedOrigins: [lan] } } });
        const response = await post(threaded, '/sign', { text: 'FROM THE LAN' }, { origin: lan });

        expect(response.status).toBe(303);
        await closeSession(threaded);
    });

    it('a POST to a page with an action and to one without answers what a production mount answers', async () =>
    {
        const production = await productionMount(vite);

        for (const path of ['/sign', '/read'])
        {
            const seam = await post(session, path, { text: 'x' });
            const built = await production.handle(new Request(`${ ORIGIN }${ path }`, {
                method: 'POST',
                headers: {
                    accept: NAVIGATE,
                    'content-type': 'application/x-www-form-urlencoded',
                    cookie: `${ CSRF.cookie }=${ TOKEN }`,
                    origin: ORIGIN
                },
                body: new URLSearchParams({ text: 'x', [CSRF_FIELD]: TOKEN })
            }));

            expect([path, seam.status, seam.headers.get('allow')])
                .toEqual([path, built.status, built.headers.get('allow')]);
        }
    });

    it('a verb outside the seam\'s two answers the seam\'s Allow list, the divergence rule 11 names', async () =>
    {
        const production = await productionMount(vite);
        const put = (target: App): Promise<Response> =>
            target.handle(new Request(`${ ORIGIN }/read`, { method: 'PUT', headers: { accept: NAVIGATE } }));

        const seam = await put(session.app);
        const built = await put(production);

        expect(seam.status).toBe(405);
        expect(seam.headers.get('allow')).toBe('GET, HEAD, POST');
        expect(built.headers.get('allow')).toBe('GET, HEAD');
    });

    it('the shell carries vite\'s client script and the compiled component\'s markup', async () =>
    {
        const body = await (await get(session, '/')).text();

        expect(body).toContain('/@vite/client');
        expect(body).toContain('HOME PAGE');
    });

    it('a revalidating static page renders live on every request', async () =>
    {
        const first = await (await get(session, '/fresh')).text();
        const second = await (await get(session, '/fresh')).text();
        const one = Number(/FRESH (\d+)/.exec(first)?.[1]);
        const two = Number(/FRESH (\d+)/.exec(second)?.[1]);

        expect(one).toBeGreaterThan(0);
        expect(two).toBe(one + 1);
    });

    it('/_image answers from the routes callback', async () =>
    {
        const response = await get(session, '/_image?src=/logo.svg', { accept: '*/*' });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('image/svg+xml');
    });
});

/** The same table and renderer the session mounted, mounted the way production mounts them. */
async function productionMount(vite: ViteProbe): Promise<App>
{
    const entry = await vite.ssrLoadModule(join(FIXTURE, 'src', 'entry.server.ts'));
    const app = new App();
    mountPages(app, {
        routes: entry.routes as PageRoute[],
        renderer: entry.renderPage as PageRenderer,
        clientDir: clientDir('<!doctype html><html><body><div id="root"></div></body></html>'),
        csrf: CSRF
    });
    return app;
}

describe('locale prefixes', () =>
{
    it('a locale-prefixed static page keeps its redirect and renders live in the reader\'s language', async () =>
    {
        const session = await open({
            pages: { csrf: CSRF, locales: { supported: ['en', 'fa'], default: 'en', routing: 'prefix' } }
        });

        const redirect = await get(session, '/about');
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get('location')).toBe('/en/about');

        const page = await get(session, '/en/about');
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('ABOUT PAGE');

        const other = await get(session, '/fa/about');
        expect(other.status).toBe(200);
        expect(await other.text()).toContain('lang="fa"');
        await closeSession(session);
    });
});

describe('the mode-conditioned mount errors read the same under shell', () =>
{
    const shell = '<!doctype html><html><body><div id="root"></div></body></html>';

    async function throughSession(entry: string): Promise<{ session: DevSession; message: string; routes: PageRoute[]; renderer: PageRenderer }>
    {
        const { session, vite } = await openWithVite({ entry });
        const response = await get(session, '/', { accept: JSON_ACCEPT });
        const body = await response.json() as { error: { message: string } };
        const loaded = await vite.ssrLoadModule(join(FIXTURE, entry));
        return {
            session,
            message: body.error.message,
            routes: loaded.routes as PageRoute[],
            renderer: loaded.renderPage as PageRenderer
        };
    }

    it('a static page under a guarded chain throws the same error a built mount throws', async () =>
    {
        const { session, message, routes, renderer } = await throughSession('src/entry.static-guarded.ts');
        const built = mountError(() => mountPages(new App(), { routes, renderer, clientDir: clientDir(shell) }));

        expect(message).toBe(built);
        expect(message).toContain('its route chain');
        await closeSession(session);
    });

    it('a static page with an action throws the same error a built mount throws', async () =>
    {
        const { session, message, routes, renderer } = await throughSession('src/entry.static-action.ts');
        const built = mountError(() => mountPages(new App(), { routes, renderer, clientDir: clientDir(shell) }));

        expect(message).toBe(built);
        expect(message).toContain('declares an action');
        await closeSession(session);
    });
});

describe('the shell and the rebuild', () =>
{
    it('an index.html edit is reflected, on a change set holding only index.html', async () =>
    {
        const root = copyFixture();
        const { session, vite } = await openWithVite({ root });
        expect(await (await get(session, '/')).text()).not.toContain('EDITED SHELL');

        writeFileSync(
            join(root, 'index.html'),
            readFileSync(join(root, 'index.html'), 'utf8').replace('<body>', '<body><p id="edit">EDITED SHELL</p>'));
        fireWatchChange(vite, `${ root.replace(/\\/g, '/') }/index.html`);

        const body = await (await get(session, '/')).text();
        expect(body).toContain('EDITED SHELL');
        // Re-transformed per rebuild, not held from the first read, and still the same page.
        expect(body).toContain('/@vite/client');
        expect(body).toContain('HOME PAGE');
        await closeSession(session);
    });

    it('a route added to the table is served on the first request after the hook', async () =>
    {
        const root = copyFixture();
        const { session } = await openWithVite({ root });
        expect((await get(session, '/added')).status).toBe(404);

        const seen = watched('routes.ts');
        writeFileSync(join(root, 'src', 'pages', 'added.azeroth'),
            'export default component Added()\n{\n    <main id="added">THE ADDED PAGE</main>\n}\n');
        writeFileSync(join(root, 'src', 'routes.ts'),
            `${ readFileSync(join(root, 'src', 'routes.ts'), 'utf8') }\n`
            + 'import Added from \'./pages/added.azeroth\';\n'
            + 'routes.push({ path: \'/added\', component: Added });\n');
        await seen;

        const response = await get(session, '/added');
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('THE ADDED PAGE');
        await closeSession(session);
    });

    it('two requests issued together after the hook both see the new text', async () =>
    {
        const root = copyFixture();
        const { session, vite } = await openWithVite({ root });
        expect(await (await get(session, '/')).text()).toContain('HOME PAGE');
        const page = join(root, 'src', 'pages', 'home.azeroth');
        writeFileSync(page, readFileSync(page, 'utf8').replace('HOME PAGE', 'JOINED PAGE'));
        fireWatchChange(vite, page);

        const [first, second] = await Promise.all([get(session, '/'), get(session, '/')]);

        expect(await first.text()).toContain('JOINED PAGE');
        expect(await second.text()).toContain('JOINED PAGE');
        await closeSession(session);
    });

    it('a request issued from inside the watchChange hook already sees the change', async () =>
    {
        const root = copyFixture();
        const { session } = await openWithVite({ root });
        await get(session, '/');

        let answered: Promise<Response> | undefined;
        const fired = new Promise<void>((done) =>
        {
            probe().onWatchChange = (id): void =>
            {
                if (id.endsWith('home.azeroth') && answered === undefined)
                {
                    // Inside the window between the hook and vite's own invalidation.
                    answered = get(session, '/');
                    done();
                }
            };
        });
        writeFileSync(join(root, 'src', 'pages', 'home.azeroth'),
            'export default component Home()\n{\n    <main id="home">HOME PAGE V2</main>\n}\n');
        await fired;

        expect(await (await answered!).text()).toContain('HOME PAGE V2');
        await closeSession(session);
    });

    it('a real save is seen with no help from the spec', async () =>
    {
        const root = copyFixture();
        const { session } = await openWithVite({ root });
        expect(await (await get(session, '/')).text()).toContain('HOME PAGE');

        const seen = watched('home.azeroth');
        writeFileSync(join(root, 'src', 'pages', 'home.azeroth'),
            'export default component Home()\n{\n    <main id="home">SAVED PAGE</main>\n}\n');
        await seen;

        expect(await (await get(session, '/')).text()).toContain('SAVED PAGE');
        await closeSession(session);
    });

    it('Regression: the recorded id reaches onFileChange verbatim', async () =>
    {
        const root = copyFixture();
        const { session, vite } = await openWithVite({ root });
        await get(session, '/');

        const spy = vi.spyOn(vite.environments.ssr.moduleGraph, 'onFileChange');
        const id = `${ root.replace(/\\/g, '/') }/src/routes.ts`;
        fireWatchChange(vite, id);
        await get(session, '/');

        expect(spy).toHaveBeenCalledWith(id);
        await closeSession(session);
    });

    it('the drain is what the next request re-reads, with vite invalidating nothing itself', async () =>
    {
        // A root vite's own watcher ignores: no invalidation but the session's own can happen
        // here, so what this arm sees is the drain and nothing else.
        const { session, vite } = await openWithVite({ root: rootWith(BLIND_WATCH) });
        expect(await (await get(session, '/')).text()).toContain('HOME PAGE');

        writeFileSync(join(vite.config.root, 'src', 'pages', 'home.azeroth'),
            'export default component Home()\n{\n    <main id="home">DRAINED PAGE</main>\n}\n');
        fireWatchChange(vite, `${ vite.config.root }/src/pages/home.azeroth`);

        expect(await (await get(session, '/')).text()).toContain('DRAINED PAGE');
        await closeSession(session);
    });

    it('Regression: a backslash-spelled id is recorded and drained like any other', async () =>
    {
        const { session, vite } = await openWithVite({ root: rootWith(BLIND_WATCH) });
        expect(await (await get(session, '/')).text()).toContain('HOME PAGE');

        writeFileSync(join(vite.config.root, 'src', 'pages', 'home.azeroth'),
            'export default component Home()\n{\n    <main id="home">BACKSLASH PAGE</main>\n}\n');
        // Driven directly, win32-spelled: a containment test that compares a backslash id against
        // vite's POSIX root records nothing, and the request then serves the module it had.
        fireWatchChange(vite, join(vite.config.root, 'src', 'pages', 'home.azeroth').replace(/\//g, '\\'));

        expect(await (await get(session, '/')).text()).toContain('BACKSLASH PAGE');
        await closeSession(session);
    });

    it('a config-file edit restarts vite, and the source edit after it is still seen', async () =>
    {
        const root = copyFixture();
        const { session } = await openWithVite({ root });
        expect(await (await get(session, '/')).text()).toContain('HOME PAGE');

        writeFileSync(join(root, 'vite.config.ts'), `${ readFileSync(join(root, 'vite.config.ts'), 'utf8') }\n// touched\n`);
        // Vite restarts itself, keeping its object by identity and replacing its fields; the
        // plugin, and its hook, is re-created with the new server.
        await new Promise((done) => setTimeout(done, 2000));

        const seen = watched('home.azeroth');
        writeFileSync(join(root, 'src', 'pages', 'home.azeroth'),
            'export default component Home()\n{\n    <main id="home">AFTER RESTART</main>\n}\n');
        await seen;

        expect(await (await get(session, '/')).text()).toContain('AFTER RESTART');
        await closeSession(session);
    });
});

describe('startup refusals, each naming its setting', () =>
{
    async function refusal(override: string): Promise<string>
    {
        const root = rootWith(override);
        try
        {
            const session = await open({ root });
            await closeSession(session);
        }
        catch (error)
        {
            return error instanceof Error ? error.message : String(error);
        }
        throw new Error('the session was expected to refuse this config and did not');
    }

    it('a server.proxy is refused, naming the setting and the config file', async () =>
    {
        const message = await refusal('server: { proxy: { "/api": "http://localhost:9" } }');

        expect(message).toContain('server.proxy');
        expect(message).toContain('vite.config.js');
    });

    it('a base other than / is refused', async () =>
    {
        const message = await refusal('base: "/app/"');

        expect(message).toContain('base');
        expect(message).toContain('/app/');
    });

    it('server.watch: null is refused and server.watch: false is not', async () =>
    {
        expect(await refusal('server: { watch: null }')).toContain('server.watch');

        const session = await open({ root: rootWith('server: { watch: false }') });
        expect((await get(session, '/')).status).toBe(200);
        await closeSession(session);
    });

    it('a pinned hmr port, ws clientPort or ws host is refused, and a ws path is not', async () =>
    {
        expect(await refusal('server: { hmr: { port: 24678 } }')).toContain('port');
        expect(await refusal('server: { ws: { clientPort: 443 } }')).toContain('clientPort');
        expect(await refusal('server: { ws: { host: "localhost" } }')).toContain('host');

        const session = await open({ root: rootWith('server: { ws: { path: "/__hmr" } }') });
        expect((await get(session, '/')).status).toBe(200);
        await closeSession(session);
    });

    it('the vite import failure carries the kit\'s own message, never a bare ERR_MODULE_NOT_FOUND', async () =>
    {
        vi.resetModules();
        vi.doMock('vite', () =>
        {
            throw new Error('ERR_MODULE_NOT_FOUND');
        });
        try
        {
            const fresh = await import('../src/dev/index.ts');
            await expect(fresh.devPages({ root: FIXTURE, pages: {}, routes: () => undefined }))
                .rejects.toThrow(/@azerothjs\/kit\/dev needs vite \^8/);
        }
        finally
        {
            vi.doUnmock('vite');
            vi.resetModules();
        }
    });

    it('supportsVite accepts the measured major and refuses its neighbours', () =>
    {
        expect(supportsVite('8.1.5')).toBe(true);
        expect(supportsVite('8.0.0-beta.1')).toBe(true);
        expect(supportsVite('7.9.0')).toBe(false);
        expect(supportsVite('9.0.0')).toBe(false);
    });
});

describe('the seam: only vite-owned requests enter vite', () =>
{
    let session: DevSession;
    let vite: ViteProbe;

    beforeAll(async () =>
    {
        const opened = await openWithVite({ routes: (app) => app.get('/api/x', () => json({ api: true })) });
        session = opened.session;
        vite = opened.vite;
    });

    interface Seen
    {
        answeredByVite: boolean;
        body: string;
    }

    /** Drives `before` with a connect-shaped pair, and says which side answered. */
    function through(url: string, peer = '127.0.0.1', headers: Record<string, string> = {}): Promise<Seen>
    {
        return new Promise<Seen>((done, fail) =>
        {
            let body = '';
            const response = {
                statusCode: 200,
                headersSent: false,
                destroyed: false,
                setHeader(): void
                {
                    // vite sets its own
                },
                getHeader(): undefined
                {
                    return undefined;
                },
                removeHeader(): void
                {
                    // vite removes its own
                },
                writeHead(): unknown
                {
                    return response;
                },
                write(chunk: string | Buffer): boolean
                {
                    body += chunk.toString();
                    return true;
                },
                end(chunk?: string | Buffer): void
                {
                    if (chunk !== undefined)
                    {
                        body += chunk.toString();
                    }
                    done({ answeredByVite: true, body });
                },
                on(): unknown
                {
                    return response;
                },
                once(): unknown
                {
                    return response;
                },
                emit(): boolean
                {
                    return false;
                }
            };
            const request = { url, method: 'GET', headers: { host: '127.0.0.1:3000', ...headers }, socket: { remoteAddress: peer } };
            const broke = (error: unknown): void => fail(error instanceof Error ? error : new Error(String(error)));
            try
            {
                session.before(
                    request as unknown as IncomingMessage,
                    response as unknown as ServerResponse,
                    (error?: unknown) => (error === undefined ? done({ answeredByVite: false, body: '' }) : broke(error)));
            }
            catch (error)
            {
                broke(error);
            }
        });
    }

    /**
     * Whether `before` handed this url to vite at all - vite's own stack stands in for itself,
     * so a url vite would merely DECLINE is still counted as forwarded.
     */
    async function forwarded(url: string, peer = '127.0.0.1', headers: Record<string, string> = {}): Promise<boolean>
    {
        const own = vite.middlewares;
        let reached = false;
        vite.middlewares = (_request, _response, next): void =>
        {
            reached = true;
            next();
        };
        try
        {
            await through(url, peer, headers);
        }
        finally
        {
            vite.middlewares = own;
        }
        return reached;
    }

    it('vite\'s own urls and the application\'s source files reach vite', async () =>
    {
        expect((await through('/@vite/client')).answeredByVite).toBe(true);
        expect((await through('/src/main.ts')).answeredByVite).toBe(true);
        expect((await through('/src/main.ts?t=1')).answeredByVite).toBe(true);
        expect((await through('/src/styles.css?direct')).answeredByVite).toBe(true);
    });

    it('public assets are served by vite, flat and nested, .html included', async () =>
    {
        expect((await through('/flat.txt')).body).toContain('PUBLIC FLAT ASSET');
        expect((await through('/nested/deep.txt')).body).toContain('PUBLIC NESTED ASSET');
        expect((await through('/flat.html')).body).toContain('PUBLIC FLAT HTML');
        expect((await through('/nested/deep.html')).body).toContain('PUBLIC NESTED HTML');
    });

    it('a plain root .html is forwarded, declined by vite, and decided by the page table', async () =>
    {
        // No .html exclusion exists in the file test, and the adapter's own `next` carries the
        // decline back to the kernel.
        expect(await forwarded('/page.html')).toBe(true);
        expect((await through('/page.html')).answeredByVite).toBe(false);
        expect((await get(session, '/page.html')).status).toBe(404);
    });

    it('/index.html answers the app\'s 404 under shell', async () =>
    {
        expect((await through('/index.html')).answeredByVite).toBe(false);

        const response = await get(session, '/index.html');
        expect(response.status).toBe(404);
        expect(await response.text()).toContain('NOT FOUND');
    });

    it('a traversal never reaches vite, in any spelling', async () =>
    {
        for (const url of [
            '/../package.json',
            '/%2e%2e/package.json',
            '/..%2Fpackage.json',
            '/../../../package.json',
            '/src/../../../package.json'
        ])
        {
            expect([url, await forwarded(url)]).toEqual([url, false]);
        }
    });

    it('/__open-in-editor reaches vite for a loopback peer only', async () =>
    {
        for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
        {
            expect([peer, await forwarded('/__open-in-editor?file=src/main.ts', peer)]).toEqual([peer, true]);
        }
        expect(await forwarded('/__open-in-editor?file=src/main.ts', '192.168.1.20')).toBe(false);
    });

    it('the api never enters vite, whatever Host it carries', async () =>
    {
        expect(await forwarded('/api/x', '127.0.0.1', { host: 'app.example.com' })).toBe(false);

        const response = await session.app.handle(new Request('http://app.example.com/api/x', { headers: { accept: JSON_ACCEPT } }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ api: true });
    });

    it('isLoopbackAddress reads every spelling a dual-stack bind reports', () =>
    {
        expect(isLoopbackAddress('127.0.0.1')).toBe(true);
        expect(isLoopbackAddress('127.5.5.5')).toBe(true);
        expect(isLoopbackAddress('::1')).toBe(true);
        expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
        expect(isLoopbackAddress('192.168.1.20')).toBe(false);
        expect(isLoopbackAddress('::ffff:192.168.1.20')).toBe(false);
        expect(isLoopbackAddress(undefined)).toBe(false);
    });
});

/** Opens one upgrade and says what happened to it. */
function upgrade(url: string, protocol: string): Promise<'open' | 'error' | 'timeout'>
{
    return new Promise((done) =>
    {
        const socket = new WebSocket(url, protocol);
        const timer = setTimeout(() => done('timeout'), 4000);
        socket.addEventListener('open', () =>
        {
            clearTimeout(timer);
            socket.close();
            done('open');
        });
        socket.addEventListener('error', () =>
        {
            clearTimeout(timer);
            done('error');
        });
    });
}

/** An upgrade request written on a raw socket, so the Host header and the timing are the arm's. */
function rawUpgrade(port: number, host: string, protocol: string, ready?: Promise<void>): Promise<string>
{
    return new Promise((done) =>
    {
        const socket = connect(port, '127.0.0.1');
        let answer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) =>
        {
            answer += chunk;
            if (answer.includes('\r\n\r\n'))
            {
                socket.destroy();
                done(answer.split('\r\n')[0] ?? '');
            }
        });
        socket.on('error', () => done('error'));
        socket.on('close', () => done(answer.split('\r\n')[0] ?? 'closed'));
        socket.on('connect', () =>
        {
            void (ready ?? Promise.resolve()).then(() =>
            {
                socket.write(`GET / HTTP/1.1\r\nHost: ${ host }\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
                    + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${ protocol }\r\n\r\n`);
            });
        });
    });
}

describe('the HMR socket rides the app\'s own server', () =>
{
    let session: DevSession;
    let served: Awaited<ReturnType<typeof serve>>;
    let origin: string;

    beforeAll(async () =>
    {
        session = await open();
        served = await serve(session.app, { port: 0, hostname: '127.0.0.1', before: session.before });
        session.attach(served.server);
        origin = `http://127.0.0.1:${ served.port }`;
    });

    afterAll(async () =>
    {
        await served.shutdown();
    });

    it('the compiled client carries a null hmr port and no literal hostname', async () =>
    {
        const client = await (await fetch(`${ origin }/@vite/client`)).text();

        expect(client).toContain('const hmrPort = null;');
        expect(client).toContain('${null || importMetaUrl.hostname}');
    });

    it('a vite-hmr upgrade at the app origin answers 101, and vite-ping too', async () =>
    {
        expect(await upgrade(`ws://127.0.0.1:${ served.port }/`, 'vite-hmr')).toBe('open');
        expect(await upgrade(`ws://127.0.0.1:${ served.port }/`, 'vite-ping')).toBe('open');
    });

    it('a vite-hmr upgrade is refused under a foreign Host and accepted under an ip literal', async () =>
    {
        expect(await rawUpgrade(served.port, 'evil.example', 'vite-hmr')).not.toContain('101');
        expect(await rawUpgrade(served.port, `127.0.0.1:${ served.port }`, 'vite-hmr')).toContain('101');
    });

    it('an upgrade forwarded while vite restarts itself leaves the process serving', async () =>
    {
        const vite = probe().server;
        if (vite === undefined)
        {
            throw new Error('the fixture config published no vite server');
        }
        const relay = vite.config.server.ws.server;
        let insideWindow = false;
        let release!: () => void;
        const inside = new Promise<void>((done) =>
        {
            release = done;
        });
        // The new server's configureServer runs while both of vite's listeners sit on the relay.
        probe().onConfigureServer = async (): Promise<void> =>
        {
            insideWindow = relay.listenerCount('upgrade') === 2;
            release();
            for (let turn = 0; turn < 20; turn += 1)
            {
                await new Promise<void>((next) => setImmediate(next));
            }
        };
        const answer = rawUpgrade(served.port, `127.0.0.1:${ served.port }`, 'vite-ping', inside);
        await vite.restart();

        expect(insideWindow).toBe(true);
        expect(['HTTP/1.1 101 Switching Protocols', 'closed', 'error']).toContain(await answer);
        expect((await fetch(`${ origin }/`, { headers: { accept: NAVIGATE } })).status).toBe(200);
    });

    it('a vite-hmr upgrade with an ip-literal Host is accepted', async () =>
    {
        expect(await upgrade(`ws://127.0.0.1:${ served.port }/`, 'vite-hmr')).toBe('open');
        expect((await fetch(`${ origin }/@vite/client`)).status).toBe(200);
    });

    it('an upgrade nobody claims answers 404 a tick later, and the process keeps serving', async () =>
    {
        expect(await upgrade(`ws://127.0.0.1:${ served.port }/nobody`, 'vite-hmr')).toBe('error');
        expect((await fetch(`${ origin }/`, { headers: { accept: NAVIGATE } })).status).toBe(200);
    });

    it('a second attach on the same server is a no-op, and the socket still answers', async () =>
    {
        session.attach(served.server);
        session.attach(served.server);

        expect(served.server.listenerCount('upgrade')).toBe(1);
        expect(await upgrade(`ws://127.0.0.1:${ served.port }/`, 'vite-ping')).toBe('open');
    });

    it('attach after close, and close before attach, are benign no-ops', async () =>
    {
        const closedFirst = await open();
        const target = await serve(closedFirst.app, { port: 0, hostname: '127.0.0.1' });
        await closeSession(closedFirst);
        closedFirst.attach(target.server);

        expect(target.server.listenerCount('upgrade')).toBe(0);
        await target.shutdown();

        const neverAttached = await open();
        await expect(closeSession(neverAttached)).resolves.toBeUndefined();
    });

    it('a pinned ws path is where the socket connects', async () =>
    {
        // The client and vite's listener derive the same path from the setting, which is why
        // rule 1 refuses a pinned port, clientPort or host but not this.
        const pinned = await open({ root: rootWith('server: { ws: { path: "/__hmr" } }') });
        const pinnedServed = await serve(pinned.app, { port: 0, hostname: '127.0.0.1', before: pinned.before });
        pinned.attach(pinnedServed.server);
        try
        {
            expect(await upgrade(`ws://127.0.0.1:${ pinnedServed.port }/__hmr`, 'vite-hmr')).toBe('open');
        }
        finally
        {
            await pinnedServed.shutdown();
            await closeSession(pinned);
        }
    });

    it('a second session on a server re-bound on the SAME port accepts the ping, and close leaves no listener', async () =>
    {
        const first = await open();
        const firstServed = await serve(first.app, { port: 0, hostname: '127.0.0.1', before: first.before });
        first.attach(firstServed.server);
        const port = firstServed.port;
        expect(await upgrade(`ws://127.0.0.1:${ port }/`, 'vite-ping')).toBe('open');

        await firstServed.shutdown();
        await closeSession(first);
        expect(firstServed.server.listenerCount('upgrade')).toBe(0);

        const second = await open();
        const secondServed = await serve(second.app, { port, hostname: '127.0.0.1', before: second.before });
        second.attach(secondServed.server);
        try
        {
            expect(secondServed.port).toBe(port);
            expect(await upgrade(`ws://127.0.0.1:${ port }/`, 'vite-ping')).toBe('open');
        }
        finally
        {
            await secondServed.shutdown();
            await closeSession(second);
        }
    });
});

describe('the policy reaches both roots, and a failure is an answer', () =>
{
    it('a throwing pipeline middleware gets the app\'s envelope and reaches onError once', async () =>
    {
        const onError = vi.fn();
        const session = await open({ app: { dev: true, onError } });
        const explode: HandlerWrapper = () => ({
            handle: (): Promise<Response> =>
            {
                throw new Error('PIPELINE EXPLODED');
            }
        });
        const handler: WebHandler = pipeline(session.app, explode);

        const response = await handler.handle(new Request(`${ ORIGIN }/`, { headers: { accept: JSON_ACCEPT } }));
        const body = await response.json() as { error: { message: string } };

        expect(response.status).toBe(500);
        expect(body.error.message).toContain('PIPELINE EXPLODED');
        expect(onError).toHaveBeenCalledTimes(1);
        await closeSession(session);
    });

    it('a throwing page handler gets the app\'s envelope and reaches onError once', async () =>
    {
        const onError = vi.fn();
        const session = await open({ app: { dev: true, onError } });

        const response = await get(session, '/explodes', { accept: JSON_ACCEPT });
        const body = await response.json() as { error: { message: string } };

        expect(response.status).toBe(500);
        expect(body.error.message).toContain('PAGE HANDLER EXPLODED');
        expect(onError).toHaveBeenCalledTimes(1);
        await closeSession(session);
    });

    it('one page request is observed once, not twice', async () =>
    {
        const observe = { onComplete: vi.fn() };
        const session = await open({ app: { dev: true, observe } });

        await get(session, '/');

        expect(observe.onComplete).toHaveBeenCalledTimes(1);
        await closeSession(session);
    });

    it('a broken first build answers an html navigation with the file, the line and the frame', async () =>
    {
        const session = await open({ entry: 'src/entry.broken.ts' });

        const response = await get(session, '/');
        const body = await response.text();

        expect(response.status).toBe(500);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(body).toContain('entry.broken.ts');
        expect(body).toContain(':1:');
        expect(body).toContain('export const broken');
        // Stripped once, at the failure boundary, before either answer renders it.
        expect(body).not.toContain(ESC);
        await closeSession(session);
    });

    it('a broken first build answers every other request with the app\'s envelope', async () =>
    {
        const session = await open({ entry: 'src/entry.broken.ts' });

        const response = await get(session, '/api/nothing', { accept: JSON_ACCEPT });
        const body = await response.json() as { error: { details?: { id?: string } } };

        expect(response.status).toBe(500);
        expect(body.error.details?.id).toContain('entry.broken.ts');
        await closeSession(session);
    });

    it('an entry without renderPage is the mount refusal, naming the entry and both exports', async () =>
    {
        const session = await open({ entry: 'src/entry.no-renderer.ts' });

        const body = await (await get(session, '/')).text();

        expect(body).toContain('entry.no-renderer.ts');
        expect(body).toContain('routes');
        expect(body).toContain('renderPage');
        await closeSession(session);
    });

    it('a later break keeps the previous build serving and prints one line', async () =>
    {
        const root = copyFixture();
        const { session, vite } = await openWithVite({ root });
        expect(await (await get(session, '/')).text()).toContain('HOME PAGE');

        const warn = vi.spyOn(vite.config.logger, 'warn');
        writeFileSync(join(root, 'src', 'pages', 'home.azeroth'), 'export default component Home(\n');
        fireWatchChange(vite, `${ root.replace(/\\/g, '/') }/src/pages/home.azeroth`);

        const response = await get(session, '/');
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('HOME PAGE');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('kept serving the previous build');
        await closeSession(session);
    });
});

describe('one runtime, proved both ways', () =>
{
    function tree(name: string, nested: boolean): { root: string; anchor: string }
    {
        const root = join(TEMP, name);
        rmSync(root, { recursive: true, force: true });
        mkdirSync(join(root, 'node_modules', 'azerothjs'), { recursive: true });
        writeFileSync(join(root, 'package.json'), '{ "name": "copies-root", "type": "module" }');
        writeFileSync(join(root, 'node_modules', 'azerothjs', 'package.json'), '{ "name": "azerothjs", "version": "0.0.0" }');
        mkdirSync(join(root, 'server'), { recursive: true });
        const anchor = join(root, 'server', 'main.js');
        writeFileSync(anchor, 'export const anchor = true;\n');
        if (nested)
        {
            mkdirSync(join(root, 'server', 'node_modules', 'azerothjs'), { recursive: true });
            writeFileSync(join(root, 'server', 'node_modules', 'azerothjs', 'package.json'), '{ "name": "azerothjs", "version": "0.0.0" }');
        }
        return { root, anchor };
    }

    it('a single copy does not throw, and a nested second copy does, naming both real paths', async () =>
    {
        const single = tree('copies-single', false);
        const session = await devPages({
            root: single.root,
            pages: {},
            routes: (): void => undefined,
            serverAnchor: single.anchor
        });
        await session.close();

        const split = tree('copies-split', true);
        await expect(devPages({
            root: split.root,
            pages: {},
            routes: (): void => undefined,
            serverAnchor: split.anchor
        })).rejects.toThrow(/two copies of "azerothjs"/);
    });

    it('a root that resolves no azerothjs at all gets its own message', async () =>
    {
        // Outside the repository, so nothing above it holds the runtime.
        const root = mkdtempSync(join(tmpdir(), 'az-dev-unresolved-'));
        writeFileSync(join(root, 'package.json'), '{ "name": "unresolved", "type": "module" }');
        try
        {
            await expect(devPages({ root, pages: {}, routes: (): void => undefined }))
                .rejects.toThrow(/cannot resolve "azerothjs" from the application root/);
        }
        finally
        {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('nesting: the shape the session delegates through', () =>
{
    const useCounter = createStore(() =>
    {
        const [value, setValue] = createSignal(0);
        return { value, setValue };
    });

    it('a store created inside the inner handler is invisible outside it', async () =>
    {
        const inner = new App();
        inner.get('/*path', () =>
        {
            useCounter().setValue(7);
            return json({ inside: useCounter().value() });
        });
        const outer = new App();
        let outside = -1;
        outer.get('/*path', async (context) =>
        {
            const response = await inner.handle(context.request);
            outside = useCounter().value();
            return response;
        });

        const body = await (await outer.handle(new Request(`${ ORIGIN }/x`))).json() as { inside: number };

        expect(body.inside).toBe(7);
        expect(outside).toBe(0);
    });

    it('an inner cleanup runs exactly once, before the outer resumes', async () =>
    {
        const order: string[] = [];
        const inner = new App();
        inner.get('/*path', () =>
        {
            onWorkUnitCleanup((): void =>
            {
                order.push('inner-cleanup');
            });
            return json({ ok: true });
        });
        const outer = new App();
        outer.get('/*path', async (context) =>
        {
            const response = await inner.handle(context.request);
            order.push('outer-resumed');
            return response;
        });

        await outer.handle(new Request(`${ ORIGIN }/x`));

        expect(order).toEqual(['inner-cleanup', 'outer-resumed']);
    });

    it('a disconnect aborts inside the inner handler', async () =>
    {
        const controller = new AbortController();
        const inner = new App();
        let abortedInside = false;
        inner.get('/*path', async (context) =>
        {
            controller.abort();
            await new Promise((done) => setTimeout(done, 0));
            abortedInside = context.request.signal.aborted;
            return json({ ok: true });
        });
        const outer = new App();
        outer.get('/*path', (context) => inner.handle(context.request));

        await outer.handle(new Request(`${ ORIGIN }/x`, { signal: controller.signal })).catch(() => undefined);

        expect(abortedInside).toBe(true);
    });

    it('a cached() key read in both roots fetches twice', async () =>
    {
        let fetches = 0;
        const family = cached('dev-spec-nesting', () =>
        {
            fetches += 1;
            return Promise.resolve(fetches);
        });
        const inner = new App();
        inner.get('/*path', async () => json({ inner: await family() }));
        const outer = new App();
        outer.get('/*path', async (context) =>
        {
            await family();
            return inner.handle(context.request);
        });

        await outer.handle(new Request(`${ ORIGIN }/x`));

        expect(fetches).toBe(2);
    });
});

describe('under the conductor, and over a root spelled another way', () =>
{
    // Windows keeps an 8.3 spelling for every long directory name; vite compares what it
    // serves against real paths, so a root given in that spelling 403s every source file.
    it.skipIf(process.platform !== 'win32')('Regression: a root spelled by its 8.3 short name 403s every source file', async () =>
    {
        const short = execSync(`for %I in ("${ FIXTURE }") do @echo %~sI`, { encoding: 'utf8', shell: 'cmd.exe' }).trim();
        if (short === FIXTURE)
        {
            return;
        }
        const session = await open({ root: short });
        const served = await serve(session.app, { port: 0, hostname: '127.0.0.1', before: session.before });
        try
        {
            const module = await fetch(`http://127.0.0.1:${ served.port }/src/main.ts`, { headers: { accept: '*/*' } });
            expect(module.status).toBe(200);
            expect((await get(session, '/')).status).toBe(200);
        }
        finally
        {
            await served.shutdown();
            await closeSession(session);
        }
    });

    it('Regression: loading the vite config restarts the process under node --watch', { timeout: 45_000 }, async () =>
    {
        // The default config loader bundles the config into a temp file, imports it through node
        // and deletes it; node --watch counts that as a change and restarts, forever.
        const script = join(TEMP, `conductor-${ Date.now() }.mjs`);
        writeFileSync(script, [
            `import { devPages } from ${ JSON.stringify(pathToFileURL(resolve(here, '..', 'src', 'dev', 'index.ts')).href) };`,
            `const session = await devPages({ root: ${ JSON.stringify(FIXTURE) }, pages: {}, routes: () => undefined });`,
            'console.log(\'BOOT\');',
            'await new Promise((keep) => setTimeout(keep, 3000));',
            'await session.close();'
        ].join('\n'));
        const child = spawn(process.execPath, ['--watch', '--watch-preserve-output', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) =>
        {
            output += chunk.toString();
        });
        const boots = await new Promise<number>((done) =>
        {
            const finish = (): void =>
            {
                child.kill();
                done(output.split('BOOT').length - 1);
            };
            const poll = setInterval(() =>
            {
                if (output.includes('BOOT'))
                {
                    clearInterval(poll);
                    setTimeout(finish, 2500);
                }
            }, 100);
            setTimeout(() =>
            {
                clearInterval(poll);
                finish();
            }, 30_000);
        });

        expect(boots).toBe(1);
    });
});
