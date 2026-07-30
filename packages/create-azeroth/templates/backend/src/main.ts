import { pipeline, requestId, securityHeaders, cors, rateLimit, logRequests, loadConfig, num, oneOf } from '@azerothjs/http';
import { serve, handleShutdownSignals } from '@azerothjs/http/node';
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

const config = loadConfig({
    port: num('PORT', { default: 3000 }),
    env: oneOf('NODE_ENV', ['development', 'production', 'test'], { default: 'development' })
});
const isProduction = config.env === 'production';

const log = createLogger({ stream: fileStream('logs/'), fields: { service: '{{name}}' } });

const handler = pipeline(
    buildApp({ dev: !isProduction, observe: logRequests(log) }),
    requestId(),
    securityHeaders(),
    // Origins are named, never reflected: `origin: true` with credentials would echo whatever
    // Origin the caller sent and honour cookies with it, which any website could then read.
    // Add your deployed frontends to the production list.
    cors({ origin: isProduction ? [] : ['http://localhost:3000'], credentials: true }),
    // The default key is the TCP peer, so behind a proxy every client shares one bucket. Declare
    // the proxy (`trustProxy`, plus `trustedHops` for a chain) or the limit is a global budget.
    rateLimit({ limit: 100, windowMs: 60_000 })
);

const served = await serve(handler, { port: config.port });
handleShutdownSignals(served);

log.info('Listening', { port: served.port, env: config.env });
