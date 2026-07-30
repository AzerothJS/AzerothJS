import { pathToFileURL } from 'node:url';

import { pipeline, requestId, securityHeaders, rateLimit, logRequests, loadConfig, num, oneOf, str } from '@azerothjs/http';
import { serve, handleShutdownSignals } from '@azerothjs/http/node';
import type { PageRenderer, PageRoute } from '@azerothjs/kit';
import { createLogger } from '@azerothjs/logger';
import { fileStream } from '@azerothjs/logger/node';

import { buildApp } from './app.ts';

try
{
    process.loadEnvFile();
}
catch
{
    // No .env file - the ambient environment is the configuration.
}

const config = loadConfig
({
    port: num('PORT', { default: 3000 }),
    env: oneOf('NODE_ENV', ['development', 'production', 'test'], { default: 'development' }),
    clientDir: str('CLIENT_DIR', { default: '../application/dist' }),
    ssrEntry: str('SSR_ENTRY', { default: '../application/dist-server/entry.server.js' })
});
const isProduction = config.env === 'production';

const log = createLogger({ stream: fileStream('logs/'), fields: { service: '{{name}}-server' } });

// In dev, vite serves the client and proxies /api here; in production this server serves
// the whole app - one origin, no CORS between halves. The SSR bundle is ONE self-contained
// file, so importing it gives the kit both the route table and the page renderer.
const ssr = isProduction
    ? await import(pathToFileURL(config.ssrEntry).href) as { routes: PageRoute[]; renderPage: PageRenderer }
    : undefined;

const app = buildApp
({
    dev: !isProduction,
    observe: logRequests(log),
    pages: ssr === undefined
        ? undefined
        : { routes: ssr.routes, clientDir: config.clientDir, renderer: ssr.renderPage }
});

const handler = pipeline
(
    app,
    requestId(),
    securityHeaders(),
    rateLimit({ limit: 200, windowMs: 60_000 })
);

const served = await serve(handler, { port: config.port });
handleShutdownSignals(served);

// The panel's Server tab connects here and mirrors the server's reactive graph: request
// roots, their per-request state, and long-lived stores. `attachDevtools` throws under
// NODE_ENV=production so it cannot ship by accident, and accepts only localhost origins.
if (!isProduction)
{
    const { attachDevtools } = await import('@azerothjs/devtools/server');
    attachDevtools(served.server);
}

log.info('Listening', { port: served.port, env: config.env });
