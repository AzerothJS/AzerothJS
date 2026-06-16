import { defineConfig } from 'vitest/config';
import path from 'path';
import os from 'os';

export default defineConfig({
    resolve:
    {
        alias:
        {
            '@azerothjs/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
            '@azerothjs/reactivity': path.resolve(__dirname, 'packages/reactivity/src/index.ts'),
            '@azerothjs/renderer': path.resolve(__dirname, 'packages/renderer/src/index.ts'),
            '@azerothjs/component': path.resolve(__dirname, 'packages/component/src/index.ts'),
            '@azerothjs/server': path.resolve(__dirname, 'packages/server/src/index.ts'),
            '@azerothjs/router': path.resolve(__dirname, 'packages/router/src/index.ts'),
            '@azerothjs/store': path.resolve(__dirname, 'packages/store/src/index.ts'),
            '@azerothjs/testing': path.resolve(__dirname, 'packages/testing/src/index.ts'),
            '@azerothjs/devtools-overlay': path.resolve(__dirname, 'packages/devtools-overlay/src/index.ts'),
            '@azerothjs/devtools': path.resolve(__dirname, 'packages/devtools/src/index.ts'),
            '@azerothjs/eslint-plugin': path.resolve(__dirname, 'packages/eslint-plugin/src/index.ts'),
            '@azerothjs/form': path.resolve(__dirname, 'packages/form/src/index.ts'),
            '@azerothjs/compiler': path.resolve(__dirname, 'packages/compiler/src/index.ts'),
            '@azerothjs/language-service': path.resolve(__dirname, 'packages/language-service/src/index.ts')
        }
    },
    test:
    {
        environment: 'happy-dom',

        // happy-dom 20.x is incompatible with vitest 4.x's default
        // worker-thread pool (the test files crash at the first
        // `describe()` with "Cannot read properties of undefined
        // (reading 'config')"). Forks isolate each file in a child
        // process, which works correctly. Marginally slower than
        // threads but rock-solid for our suite size.
        pool: 'forks',

        // Many files spin a REAL TypeScript program; unbounded fork
        // fan-out lets peak memory/CPU starve a worker and produce
        // transient file-level failures that pass in isolation. Cap
        // forks (still parallel) so contention can't flake the suite.
        poolOptions:
        {
            forks:
            {
                maxForks: Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)))
            }
        },

        // The slow-but-correct TS-program tests can exceed the 5s
        // default under load; give them headroom without masking hangs.
        testTimeout: 15000
    }
});
