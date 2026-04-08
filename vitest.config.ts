import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig
({
    resolve:
    {
        alias:
        {
            '@quantum/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
            '@quantum/reactivity': path.resolve(__dirname, 'packages/reactivity/src/index.ts'),
            '@quantum/renderer': path.resolve(__dirname, 'packages/renderer/src/index.ts'),
            '@quantum/component': path.resolve(__dirname, 'packages/component/src/index.ts'),
            '@quantum/router': path.resolve(__dirname, 'packages/router/src/index.ts'),
            '@quantum/store': path.resolve(__dirname, 'packages/store/src/index.ts'),
            '@quantum/compiler': path.resolve(__dirname, 'packages/compiler/src/index.ts')
        }
    },
    test:
    {
        environment: 'happy-dom'
    }
});
