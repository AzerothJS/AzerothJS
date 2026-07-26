// Bootstrap: config, logging, the edge pipeline, serve, graceful shutdown. No build
// step - Node >= 24 runs this file directly; `azeroth dev` (from the project root)
// watches it alongside the vite app.
import { pathToFileURL } from 'node:url';

import
{
    pipeline, requestId, securityHeaders, rateLimit, logRequests
} from '@azerothjs/http';
import { serve, handleShutdownSignals } from '@azerothjs/http/node';
import type { PageRenderer, PageRoute } from '@azerothjs/kit';
import { createLogger } from '@azerothjs/logger';
import { fileStream } from '@azerothjs/logger/node';

import { buildApp } from './app.ts';
import { config, isProduction } from './config.ts';

const log = createLogger({ stream: fileStream('logs/'), fields: { service: '{{name}}-server' } });

// In dev, vite serves the client and proxies /api here. In production this server
// serves the whole app itself - one origin, no CORS between halves: the SSR bundle
// (ONE self-contained file from `vite build --ssr`) provides the route table and
// the page renderer the kit mounts.
const ssr = isProduction
    ? await import(pathToFileURL(config.ssrEntry).href) as { routes: PageRoute[]; renderPage: PageRenderer }
    : undefined;

const app = buildApp({
    dev: !isProduction,
    observe: logRequests(log),
    pages: ssr === undefined
        ? undefined
        : { routes: ssr.routes, clientDir: config.clientDir, renderer: ssr.renderPage }
});

const handler = pipeline(
    app,
    requestId(),
    securityHeaders(),
    rateLimit({ limit: 200, windowMs: 60_000 })
);

const served = await serve(handler, { port: config.port });
handleShutdownSignals(served);
log.info('listening', { port: served.port, env: config.env });
