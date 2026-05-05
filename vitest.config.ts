import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve:
    {
        alias:
        {
            '@azerothjs/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
            '@azerothjs/reactivity': path.resolve(__dirname, 'packages/reactivity/src/index.ts'),
            '@azerothjs/renderer': path.resolve(__dirname, 'packages/renderer/src/index.ts'),
            '@azerothjs/component': path.resolve(__dirname, 'packages/component/src/index.ts'),
            '@azerothjs/router': path.resolve(__dirname, 'packages/router/src/index.ts'),
            '@azerothjs/store': path.resolve(__dirname, 'packages/store/src/index.ts'),
            '@azerothjs/form': path.resolve(__dirname, 'packages/form/src/index.ts'),
            '@azerothjs/compiler': path.resolve(__dirname, 'packages/compiler/src/index.ts')
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
        pool: 'forks'
    }
});
