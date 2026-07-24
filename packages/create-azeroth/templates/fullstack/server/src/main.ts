// Bootstrap: config, logging, the edge pipeline, serve, graceful shutdown. No build
// step - Node >= 24 runs this file directly; `azeroth dev` (from the project root)
// watches it alongside the vite app.
import
{
    serve, pipeline, handleShutdownSignals,
    requestId, securityHeaders, rateLimit, logRequests
} from '@azerothjs/http';
import { createLogger, fileStream } from '@azerothjs/logger';

import { buildApp } from './app.ts';
import { config, isProduction } from './config.ts';

const log = createLogger({ stream: fileStream('logs/'), fields: { service: '{{name}}-server' } });

const app = buildApp({
    dev: !isProduction,
    observe: logRequests(log),
    // In dev, vite serves the client and proxies /api here; in production this
    // server serves the built client itself - one origin, no CORS between halves.
    clientDir: isProduction ? config.clientDir : undefined
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
