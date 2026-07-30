import { App, json, type RequestObserver } from '@azerothjs/http';
import { mountApi } from '@azerothjs/http/api';
import { mountPages, type KitOptions } from '@azerothjs/kit';
import { contract, type Entry } from './contract.ts';
import { mountStream } from './stream.ts';

export interface AppOptions
{
    dev: boolean;
    observe?: RequestObserver;

    /** The built client + SSR renderer (production); omit in dev - vite serves the client. */
    pages?: KitOptions;
}

export function buildApp(options: AppOptions): App
{
    const app = new App({ dev: options.dev, observe: options.observe });

    app.get('/api/healthz', () => json({ ok: true, at: new Date().toISOString() }));

    const entries: Entry[] = [];
    let nextId = 1;

    // Handlers are keyed by the contract's dotted route path - the same keys a `guards` map uses,
    // so there is one key space and no tree to mirror. Validation happens at the boundary, so
    // `input` is already the schema's type; swap this array for a database and nothing else moves.
    mountApi(app, contract, {
        handlers:
        {
            'guestbook.list': () => entries,
            'guestbook.sign': ({ input }) =>
            {
                const created: Entry = { id: nextId++, ...input, at: new Date().toISOString() };
                entries.unshift(created);
                return created;
            }
        }
    });

    // The raw half: routes whose request or response is not a JSON value, so the contract
    // would have nothing to validate. A token stream here; uploads, webhooks and downloads
    // belong beside it. This split is the rule, not an exception - see stream.ts.
    mountStream(app);

    // Mounted LAST so nothing shadows /api: everything else is a page or an asset, and the
    // kit reads each route's `render` mode - the static home is served as a file, /guestbook
    // SSRs per request, and the rest falls through to the built client.
    if (options.pages !== undefined)
    {
        mountPages(app, options.pages);
    }

    return app;
}
