// The whole environment, read ONCE into a typed object. A missing or invalid value
// fails boot with a single error naming every problem - a misconfigured server never
// reaches traffic. Add variables here as your app grows; .env.example documents them.
import { loadConfig, num, oneOf } from '@azerothjs/http';

// Load .env before any value is read. In production the real environment is already
// populated, so a missing file is not an error.
try
{
    process.loadEnvFile();
}
catch
{
    // No .env file - the ambient environment is the configuration.
}

export const config = loadConfig({
    port: num('PORT', { default: 3000 }),
    env: oneOf('NODE_ENV', ['development', 'production', 'test'], { default: 'development' })
});

export const isProduction = config.env === 'production';
