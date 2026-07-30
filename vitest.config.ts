import { defineConfig } from 'vitest/config';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Discovery-first: alias every workspace package to its LIVE source entry, so the
// suite runs against current `src` (real execution, no stale `dist`). Package names
// are read from each package.json rather than hardcoded.
const root = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.join(root, 'packages');

const alias = readdirSync(packagesDir)
    .map((name) => path.join(packagesDir, name))
    .filter((dir) =>
        existsSync(path.join(dir, 'package.json')) &&
        existsSync(path.join(dir, 'src', 'index.ts')))
    .flatMap((dir) =>
    {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string };
        const entries = [];
        // Subpath aliases FIRST: a bare string `find` prefix-matches, so `pkg/internal`
        // must resolve before the bare package name grabs it.
        for (const [sub, file] of [
            ['api/shared', 'api/shared-entry.ts'],
            ['language-service', 'language-service/index.ts'],
            ['ssr', 'ssr.ts'],
            ['client', 'client.ts'],
            ['prerender', 'prerender.ts'],
            ['api', 'api/index.ts'],
            ['internal', 'internal.ts'],
            ['node', 'node.ts']
        ])
        {
            if (existsSync(path.join(dir, 'src', file)))
            {
                entries.push({ find: `${ pkg.name }/${ sub }`, replacement: path.join(dir, 'src', file) });
            }
        }
        entries.push({ find: pkg.name, replacement: path.join(dir, 'src', 'index.ts') });
        return entries;
    });

export default defineConfig({
    resolve: { alias },
    test:
    {
        // `globals: true` so @azerothjs/testing's cleanup() can auto-register with the
        // global afterEach at import time, exactly as a consumer's runner provides it.
        globals: true,
        // Default to a real DOM (happy-dom). SSR / compiler files opt back to a
        // DOM-less environment with a `// @vitest-environment node` docblock, so the
        // "no DOM shim required" SSR contract is genuinely exercised.
        environment: 'happy-dom',
        include: ['packages/*/tests/**/*.spec.ts'],
        // The real-socket / real-process suites (ws close handshakes, the node adapter, sse,
        // kit, npm-spawning scaffold checks) do genuine I/O; under full file parallelism on a
        // loaded machine their aggregate occasionally crosses the 5s default, which read as a
        // flake, not a defect. A higher ceiling only affects tests that would otherwise exceed
        // it - fast unit tests are unchanged - so it removes the false failures without masking
        // a real hang materially (a truly stuck test still fails, just later).
        testTimeout: 15000,
        hookTimeout: 15000,
        clearMocks: true,
        restoreMocks: true
    }
});
