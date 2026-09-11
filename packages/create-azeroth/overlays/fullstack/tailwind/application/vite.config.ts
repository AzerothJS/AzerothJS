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
    // Nothing declares a dev server here: `azeroth dev` runs vite inside the API process
    // through @azerothjs/kit, which owns the port and the HMR socket. Plugins, `resolve`,
    // `css`, `define` and the rest of this file are read by that session as they are.
    test:
    {
        environment: 'happy-dom'
    }
});
