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
    cors({ origin: isProduction ? [] : true, credentials: true }),
    rateLimit({ limit: 100, windowMs: 60_000 })
);

const served = await serve(handler, { port: config.port });
handleShutdownSignals(served);

log.info('Listening', { port: served.port, env: config.env });
