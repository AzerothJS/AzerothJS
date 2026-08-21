import { azeroth } from '@azerothjs/compiler';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [azeroth(), tailwindcss()],
    // The SSR bundle (src/entry.server.ts) inlines the APPLICATION's dependencies, so
    // production needs no client node_modules. The `azerothjs` runtime is deliberately
    // external: the server process must hold ONE instance of it - @azerothjs/http installs
    // the request scope on the copy it resolves, and a second inlined copy would silently
    // split the per-request data cache - and server/package.json already declares it, so
    // every deploy layout this template produces has it installed.
    ssr:
    {
        noExternal: true,
        external: ['azerothjs']
    },
    server:
    {
        // Declared, not inherited: the README and the devtools bridge URL name these ports.
        port: 5173,
        proxy:
        {
            // The whole dev wiring to the server half; in production the server itself
            // serves the built client (one origin) - see server/src/app.ts.
            '/api': 'http://localhost:3000',
            '/_image': 'http://localhost:3000'
        }
    },
    test:
    {
        environment: 'happy-dom'
    }
});
