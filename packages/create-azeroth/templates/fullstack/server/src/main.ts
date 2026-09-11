import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { csrfCookie, pipeline, requestId, securityHeaders, rateLimit, logRequests, loadConfig, num, oneOf, str } from '@azerothjs/http';
import type { ErrorObserver } from '@azerothjs/http';
import { serve, handleShutdownSignals } from '@azerothjs/http/node';
import { imageHandler } from '@azerothjs/kit';
import type { PageRenderer, PageRoute } from '@azerothjs/kit';
import { SSR_SOURCE_ENTRY } from '@azerothjs/kit/dev/entry';
import { createLogger, teeSink, terminalSink } from '@azerothjs/logger';
import { fileSink } from '@azerothjs/logger/node';

import { manifestOf } from '@azerothjs/http/api';

import { api, buildApp, csrf, registerApi } from './app.ts';

try
{
    process.loadEnvFile();
}
catch
{
    // No .env file - the ambient environment is the configuration.
}

const config = loadConfig({
    port: num('PORT', { default: 3000 }),
    // Unset means production: `azeroth dev` declares development for its children, so anything
    // that did NOT come from the dev command is a deploy. Defaulting the other way makes a
    // deployment that forgot the variable serve the dev app and open dev-only gates.
    env: oneOf('NODE_ENV', ['development', 'production', 'test'], { default: 'production' }),
    clientDir: str('CLIENT_DIR', { default: '../application/dist' }),
    ssrEntry: str('SSR_ENTRY', { default: '../application/dist-server/entry.server.js' })
});
const isProduction = config.env === 'production';

// Pretty lines on the terminal, clean NDJSON in server/logs/ - both, in every mode.
const log = createLogger({
    sink: teeSink(terminalSink(), fileSink(new URL('../logs/', import.meta.url))),
    fields: { service: '{{name}}-server' }
});

// Production mode with nothing built is the one way the import below dies as a bare missing
// module; say what it means while there is still a logger to say it with.
if (isProduction && !existsSync(config.ssrEntry))
{
    log.error('no SSR bundle on disk - run `azeroth build` first, or start the dev session with `azeroth dev`', { ssrEntry: config.ssrEntry, env: config.env });
}

// Production: the self-contained SSR bundle carries routes + renderer. Dev builds nothing -
// the session below loads the same two exports from source, through vite.
const ssr = isProduction
    ? await import(pathToFileURL(config.ssrEntry).href) as { routes: PageRoute[]; renderPage: PageRenderer }
    : undefined;

const dev = !isProduction;
const observe = logRequests(log);
const onError: ErrorObserver = (error, mapped) =>
{
    if (mapped.status >= 500)
    {
        log.error('unhandled error', { status: mapped.status, error });
    }
};

// Dev: the kit owns a vite session inside THIS process, so one origin serves the pages, the
// api and the HMR socket - no second port, no proxy. The import is dynamic because vite is a
// dev dependency the production image never installs.
const kitDev = dev ? await import('@azerothjs/kit/dev') : undefined;
const session = await kitDev?.devPages({
    root: fileURLToPath(new URL('../../application/', import.meta.url)),
    entry: SSR_SOURCE_ENTRY,
    pages: { manifest: manifestOf(api), csrf },
    routes: (app) =>
    {
        // The dev-only image endpoint beside the api; production gets it from `images: true`.
        app.get('/_image', imageHandler({ root: '../application/public' }));
        registerApi(app);
    },
    app: { dev, observe, onError }
});

const app = session?.app ?? buildApp({
    dev,
    observe,
    onError,
    pages: ssr === undefined ? undefined : { routes: ssr.routes, clientDir: config.clientDir, renderer: ssr.renderPage, manifest: manifestOf(api), images: true, csrf }
});

const handler = pipeline(
    app,
    requestId(),
    securityHeaders(),
    // Mints the readable CSRF token cookie the sign action's guard checks.
    csrfCookie(csrf),
    rateLimit({ limit: 200, windowMs: 60_000 })
);

const served = await serve(handler, {
    port: config.port,
    before: session?.before,
    // Dev binds IPv4 loopback, because `localhost` resolves to ::1 first on some platforms;
    // HOST=0.0.0.0 opens it to the LAN. Production keeps the adapter's own bind.
    hostname: isProduction ? undefined : (process.env.HOST ?? '127.0.0.1')
});
// The HMR socket rides this server: vite was never given one of its own.
session?.attach(served.server);
handleShutdownSignals(served, { beforeExit: () => session?.close() });

// The devtools bridge exposes live server state, so it attaches only under a LITERAL
// NODE_ENV=development (the raw variable - config.env is defaulted and would enable it
// everywhere). The token comes from gitignored .env, never minted per boot: `node --watch`
// restarts on every save, and a fresh token each restart would strand the panel.
if (process.env.NODE_ENV === 'development')
{
    const token = process.env.DEVTOOLS_TOKEN;
    if (token === undefined || token.length < 16)
    {
        log.warn('devtools bridge off - set DEVTOOLS_TOKEN in .env (16+ chars) to enable it');
    }
    else
    {
        const { attachDevtools } = await import('@azerothjs/devtools/server');
        attachDevtools(served.server, { token });
        log.info('devtools bridge', { url: `ws://localhost:${ served.port }/__azeroth/devtools?token=${ token }` });
    }
}

log.info('Listening', { url: `http://localhost:${ served.port }`, env: config.env });
