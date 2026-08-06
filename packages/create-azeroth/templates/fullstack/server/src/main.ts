import { pathToFileURL } from 'node:url';

import { pipeline, requestId, securityHeaders, rateLimit, logRequests, loadConfig, num, oneOf, str } from '@azerothjs/http';
import { serve, handleShutdownSignals } from '@azerothjs/http/node';
import type { PageRenderer, PageRoute } from '@azerothjs/kit';
import { createLogger, teeSink, terminalSink } from '@azerothjs/logger';
import { fileSink } from '@azerothjs/logger/node';

import { manifestOf } from '@azerothjs/http/api';

import { api, buildApp } from './app.ts';

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
    env: oneOf('NODE_ENV', ['development', 'production', 'test'], { default: 'development' }),
    clientDir: str('CLIENT_DIR', { default: '../application/dist' }),
    ssrEntry: str('SSR_ENTRY', { default: '../application/dist-server/entry.server.js' })
});
const isProduction = config.env === 'production';

// Pretty lines on the terminal, clean NDJSON in server/logs/ - both, in every mode.
const log = createLogger({
    sink: teeSink(terminalSink(), fileSink(new URL('../logs/', import.meta.url))),
    fields: { service: '{{name}}-server' }
});

// In dev, vite serves the client and proxies /api here; in production this server serves
// the whole app - one origin, no CORS between halves. The SSR bundle is ONE self-contained
// file, so importing it gives the kit both the route table and the page renderer.
const ssr = isProduction
    ? await import(pathToFileURL(config.ssrEntry).href) as { routes: PageRoute[]; renderPage: PageRenderer }
    : undefined;

const app = buildApp({
    dev: !isProduction,
    observe: logRequests(log),
    onError: (error, mapped) =>
    {
        if (mapped.status >= 500)
        {
            log.error('unhandled error', { status: mapped.status, error });
        }
    },
    pages: ssr === undefined ? undefined : { routes: ssr.routes, clientDir: config.clientDir, renderer: ssr.renderPage, manifest: manifestOf(api) }
});

const handler = pipeline(
    app,
    requestId(),
    securityHeaders(),
    rateLimit({ limit: 200, windowMs: 60_000 })
);

const served = await serve(handler, { port: config.port });
handleShutdownSignals(served);

// The panel's Server tab connects here and mirrors the server's reactive graph: request roots,
// their per-request state, and long-lived stores. That is live application data, so the bridge
// attaches ONLY under NODE_ENV=development and every upgrade must present the token below from a
// loopback peer. The token is minted per boot: it is never written to disk and never committed.
// Reads the RAW variable, not `config.env`. `loadConfig` defaults an unset NODE_ENV to
// 'development' for this app's own purposes, but the bridge refuses anything that is not
// literally development - so guarding on the defaulted value would call it in a scaffold where
// nothing is set, and the boot would die on a bridge that was never going to attach.
// `azeroth dev` sets NODE_ENV=development, so `npm run dev` gets the panel.
if (process.env.NODE_ENV === 'development')
{
    const { attachDevtools } = await import('@azerothjs/devtools/server');
    const token = crypto.randomUUID();
    attachDevtools(served.server, { token });
    log.info('devtools bridge', { url: `ws://localhost:${ served.port }/__azeroth/devtools?token=${ token }` });
}

log.info('Listening', { url: `http://localhost:${ served.port }`, env: config.env });
