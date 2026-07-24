// The app, built pure: routes in, App out. API routes live under /api - the same
// prefix the application's dev proxy forwards - and in production the server also
// serves the built client, so the deployed app is ONE origin (no CORS to configure
// between your own halves).
import { App, json, staticFiles, type RequestObserver } from '@azerothjs/http';

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

    if (options.clientDir !== undefined)
    {
        // One origin in production: everything that is not /api is the client.
        const client = staticFiles(options.clientDir);
        app.get('/', client);
        app.get('/*path', client);
    }

    return app;
}
