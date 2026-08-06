import { App, json, type ErrorObserver, type RequestObserver } from '@azerothjs/http';
import { feature, manifestOf, register } from '@azerothjs/http/api';
import { mountPages, type KitOptions } from '@azerothjs/kit';
import { array } from '@azerothjs/schema';
import { entry, entryInput, type Entry } from './schemas.ts';

const ASSISTANT_REPLY = 'Streaming works: each word arrived as its own server-sent event, appended to one reactive string.';

const entries: Entry[] = [];
let nextId = 1;

// The whole API, declared once: routes, schemas, handlers, colocated. The route name is written
// exactly once - it keys this object, the manifest, the browser's `client.guestbook.sign`, and
// the OpenAPI operation. Validation happens at the boundary, so `input` is already the schema's
// type; swap the array for a database and nothing else moves. The stream is a first-class route
// kind, not a hand-mounted exception - it inherits any feature guard and appears in the manifest.
export const api = {
    guestbook: feature('/guestbook', (routes) => ({
        list: routes.get('/', { output: array(entry) }, () => entries),
        sign: routes.post('/', { input: entryInput, output: entry }, ({ input }) =>
        {
            const created: Entry = { id: nextId++, ...input, at: new Date().toISOString() };
            entries.unshift(created);
            return created;
        })
    })),
    assistant: feature('/assistant', (routes) => ({
        ask: routes.stream('/', {}, async (context, connection) =>
        {
            const question = context.url.searchParams.get('q')?.trim();
            connection.send(`${ question === undefined || question === '' ? 'Ask me anything.' : `You asked: ${ question }.` } `);

            for (const word of ASSISTANT_REPLY.split(' '))
            {
                // Where a real handler cancels its upstream model call: an abandoned tab must
                // stop costing money.
                if (connection.signal.aborted)
                {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 90));
                // The separator rides IN the payload, as a tokenizer emits it: a trailing space
                // survives SSE framing, a leading one is eaten.
                connection.send(`${ word } `);
            }
            // Emits the [DONE] terminator the client's stream parser waits for.
            connection.close();
        })
    }))
};

export interface AppOptions
{
    dev: boolean;
    observe?: RequestObserver;
    onError?: ErrorObserver;

    /** The built client + SSR renderer (production); omit in dev - vite serves the client. */
    pages?: KitOptions;
}

export function buildApp(options: AppOptions): App
{
    const app = new App({ dev: options.dev, observe: options.observe, onError: options.onError });

    app.get('/api/healthz', () => json({ ok: true, at: new Date().toISOString() }));

    register(app, api);

    // The typed client's runtime half: method + path per route, projected from the SAME
    // declaration register just installed. The browser fetches it once at boot.
    app.get('/api/_manifest', () => json(manifestOf(api)));

    // Mounted LAST so nothing shadows /api: everything else is a page or an asset, and the
    // kit reads each route's `render` mode - the static home is served as a file, /guestbook
    // SSRs per request, and the rest falls through to the built client.
    if (options.pages !== undefined)
    {
        mountPages(app, options.pages);
    }

    return app;
}
