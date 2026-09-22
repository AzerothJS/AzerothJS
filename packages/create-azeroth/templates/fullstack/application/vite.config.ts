import { azeroth } from '@azerothjs/compiler';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [azeroth()],
    // The SSR bundle inlines the application's dependencies, but `azerothjs` stays external so
    // the server process holds one copy of the runtime, the one server/package.json installs.
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
