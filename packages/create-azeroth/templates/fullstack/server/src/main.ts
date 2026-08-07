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

// Dev: vite serves the client and proxies /api here. Production: this server serves the
// whole app from one origin; the self-contained SSR bundle carries routes + renderer.
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
