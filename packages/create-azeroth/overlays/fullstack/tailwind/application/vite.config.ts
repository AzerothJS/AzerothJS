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
        proxy:
        {
            // The server half of this app. `azeroth dev` runs both halves; this line is
            // the whole DEV wiring. In production the server serves the built client
            // itself (one origin) - see server/src/app.ts.
            '/api': 'http://localhost:3000'
        }
    },
    test:
    {
        environment: 'happy-dom'
    }
});
