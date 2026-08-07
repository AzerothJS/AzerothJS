import { azeroth } from '@azerothjs/compiler';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [azeroth(), tailwindcss()],
    // The SSR bundle (src/entry.server.ts) inlines its dependencies, so dist-server
    // is ONE self-contained file - production imports it with no client node_modules.
    ssr:
    {
        noExternal: true
    },
    server:
    {
        // Declared, not inherited: the README and the devtools bridge URL name these ports.
        port: 5173,
        proxy:
        {
            // The whole dev wiring to the server half; in production the server itself
            // serves the built client (one origin) - see server/src/app.ts.
            '/api': 'http://localhost:3000'
        }
    },
    test:
    {
        environment: 'happy-dom'
    }
});
