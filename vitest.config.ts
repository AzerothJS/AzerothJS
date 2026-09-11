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
            ['dev/entry', 'dev/entry.ts'],
            ['dev', 'dev/index.ts'],
            ['language-service', 'language-service/index.ts'],
            ['ssr', 'ssr.ts'],
            ['client', 'client.ts'],
            ['prerender', 'prerender.ts'],
            ['api', 'api/index.ts'],
            ['internal', 'internal.ts'],
            ['semantics', 'semantics.ts'],
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
        // One level of `tests/` per package, which deliberately EXCLUDES the scaffold payload
        // under `packages/create-azeroth/templates|overlays`. Those specs are not repo tests -
        // they ship to the user's generated project and run there, against that project's own
        // vite config and installed dependencies. They cannot run here: their sources carry
        // `{{name}}`/`{{version}}` placeholders, the template directories are not workspaces
        // (root `workspaces` is `packages/*`), and this config registers no `.azeroth`
        // transform, so a spec importing a component fails at import analysis. The templates
        // are covered instead by `create-azeroth`'s own suite for GENERATION, and by
        // scaffolding each flavour and running its build/check/test before a release.
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
        restoreMocks: true,
        // Two projects, because ONE spec needs the opposite of the alias table above. The dev
        // session hands its fixture to a real vite, and vite loads `azerothjs` from
        // node_modules - so the spec must bind that same installed (BUILT) package, or the
        // session and the render hold two instances of the runtime. Every `@azerothjs/*` alias
        // stays on `src` in both projects.
        projects: [
            {
                extends: true,
                test:
                {
                    name: 'unit',
                    // An `exclude` entry replaces vitest's defaults, deliberately: the root
                    // `include` already scopes discovery to `packages/*/tests/**/*.spec.ts`.
                    exclude: ['**/node_modules/**', 'packages/kit/tests/dev.spec.ts']
                }
            },
            {
                // A BARE entry: `extends: true` inherits everything and cannot SUBTRACT an
                // inherited alias, which is the one thing this project exists to do.
                resolve:
                {
                    alias: alias.filter((entry) => entry.find !== 'azerothjs' && !entry.find.startsWith('azerothjs/'))
                },
                test:
                {
                    name: 'dev',
                    globals: true,
                    environment: 'node',
                    include: ['packages/kit/tests/dev.spec.ts'],
                    testTimeout: 15000,
                    hookTimeout: 15000,
                    clearMocks: true,
                    restoreMocks: true,
                    // A REGEX, not a bare string: the id vitest sees for a symlinked workspace
                    // package carries no `node_modules` segment, so a bare name never matches
                    // and `azerothjs` would be inlined into this project instead.
                    server: { deps: { external: [/[\\/]packages[\\/]azerothjs[\\/]/] } }
                }
            }
        ]
    }
});
