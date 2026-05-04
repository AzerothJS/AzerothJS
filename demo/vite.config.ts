import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// Vite config for the demo. Mirrors the workspace aliases in
// vitest.config.ts so the demo imports @azerothjs/* directly from
// package source — no build step required.
export default defineConfig({
    resolve:
    {
        alias:
        {
            '@azerothjs/core': path.resolve(repoRoot, 'packages/core/src/index.ts'),
            '@azerothjs/reactivity': path.resolve(repoRoot, 'packages/reactivity/src/index.ts'),
            '@azerothjs/renderer': path.resolve(repoRoot, 'packages/renderer/src/index.ts'),
            '@azerothjs/component': path.resolve(repoRoot, 'packages/component/src/index.ts'),
            '@azerothjs/router': path.resolve(repoRoot, 'packages/router/src/index.ts'),
            '@azerothjs/store': path.resolve(repoRoot, 'packages/store/src/index.ts'),
            '@azerothjs/compiler': path.resolve(repoRoot, 'packages/compiler/src/index.ts')
        }
    },
    server:
    {
        fs:
        {
            // Allow Vite to read files from outside demo/ (the
            // package sources live in ../packages).
            allow: [repoRoot]
        }
    }
});
