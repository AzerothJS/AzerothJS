// The app, built pure: routes in, App out. API routes live under /api - the same
// prefix the application's dev proxy forwards - and in production the server also
// serves the built client, so the deployed app is ONE origin (no CORS to configure
// between your own halves).
import { App, json, type RequestObserver } from '@azerothjs/http';
import { mountApi } from '@azerothjs/http/api';
import { staticFiles } from '@azerothjs/http/node';
import { contract, type Entry } from './contract.ts';

export interface AppOptions
{
    dev: boolean;
    observe?: RequestObserver;

    /** Serve the built client from this directory (production); omit in dev - vite serves it. */
    clientDir?: string;
}

export function buildApp(options: AppOptions): App
{
    const app = new App({ dev: options.dev, observe: options.observe });

    // The orchestrator probe: cheap, dependency-free, always 200 when the process lives.
    app.get('/api/healthz', () => json({ ok: true, at: new Date().toISOString() }));

    // The typed contract, mounted with validation AT the boundary: a request that
    // fails the shared schema never reaches a handler - it gets the 422 whose field
    // map the application's form displays directly. Swap the in-memory array for a
    // database and nothing else changes.
    const entries: Entry[] = [];
    let nextId = 1;
    mountApi(app, contract, {
        handlers: {
            guestbook: {
                list: () => entries,
                sign: ({ input }) =>
                {
                    const created: Entry = { id: nextId++, ...input, at: new Date().toISOString() };
                    entries.unshift(created);
                    return created;
                }
            }
        }
    });

    if (options.clientDir !== undefined)
    {
        // One origin in production: everything that is not /api is the client.
        // '/' serves the PRERENDERED home (index.html - SSR'd at build time and
        // hydrated in the browser); client-routed pages get the plain SPA shell
        // (spa.html) so a direct load of /guestbook renders client-side without a
        // markup mismatch.
        const client = staticFiles(options.clientDir);
        const shell = staticFiles(options.clientDir, { index: 'spa.html' });
        app.get('/', client);
        app.get('/guestbook', shell);
        app.get('/*path', client);
    }

    return app;
}
