// The whole environment, read ONCE into a typed object - one boot error names every
// problem. Add variables here as the app grows; .env.example documents them.
import { loadConfig, num, oneOf, str } from '@azerothjs/http';

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
    env: oneOf('NODE_ENV', ['development', 'production', 'test'], { default: 'development' }),
    // Where the built client lives in production (the server serves it - one origin).
    clientDir: str('CLIENT_DIR', { default: '../application/dist' }),
    // The SSR bundle from `vite build --ssr` - renders `render: 'server'` pages per request.
    ssrEntry: str('SSR_ENTRY', { default: '../application/dist-server/entry.server.js' })
});

export const isProduction = config.env === 'production';
