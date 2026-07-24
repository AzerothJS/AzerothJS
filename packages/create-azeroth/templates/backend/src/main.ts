// Bootstrap: config, logging, the edge pipeline, serve, graceful shutdown. There is
// no build step - Node >= 24 runs this file directly; `azeroth dev` restarts it on
// save and `azeroth build` will tell you there is nothing to build.
import
{
    serve, pipeline, handleShutdownSignals,
    requestId, securityHeaders, cors, rateLimit, logRequests
} from '@azerothjs/http';
import { createLogger, fileStream } from '@azerothjs/logger';

import { buildApp } from './app.ts';
import { config, isProduction } from './config.ts';

// One structured line per request: pretty on a dev terminal, NDJSON persisted to
// logs/ with day-named rotation everywhere.
const log = createLogger({ stream: fileStream('logs/'), fields: { service: '{{name}}' } });

const app = buildApp({ dev: !isProduction, observe: logRequests(log) });

// Cross-cutting response concerns wrap the app ONCE, at the edge.
const handler = pipeline(
    app,
    requestId(),                     // honor/mint X-Request-Id
    securityHeaders(),               // nosniff, frame-options, referrer-policy, ...
    cors({
        // Locked down by default: add your real origins before going live.
        origin: isProduction ? [] : true,
        credentials: true
    }),
    rateLimit({ limit: 100, windowMs: 60_000 })
);

const served = await serve(handler, { port: config.port });
handleShutdownSignals(served);       // SIGTERM/SIGINT: drain in-flight responses, then exit
log.info('listening', { port: served.port, env: config.env });
