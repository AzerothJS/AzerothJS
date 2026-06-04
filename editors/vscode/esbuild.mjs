// Bundles the extension and the language server into two self-contained CJS
// files so the packaged .vsix needs no node_modules tree (which a symlinked
// monorepo can't produce reliably).
//
//   dist/extension.js - the VS Code entry point (vscode is external; the LSP
//                       client is bundled in).
//   dist/server.js    - the language server, with @azerothjs/* and the LSP
//                       server libs bundled. `typescript` stays external and is
//                       shipped beside the bundle (it needs its lib/*.d.ts on
//                       disk), resolved from the extension's own node_modules.

import { build } from 'esbuild';

const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: false,
    logLevel: 'info',
    // Prefer ESM entry points: vscode-html-languageservice's UMD build uses
    // dynamic requires esbuild can't follow, so bundling it would leave broken
    // relative requires. Its `module` (ESM) build bundles statically.
    mainFields: ['module', 'main']
};

await build({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode']
});

await build({
    ...common,
    entryPoints: ['../../packages/language-server/dist/cli.js'],
    outfile: 'dist/server.js',
    // typescript ships separately (needs its on-disk lib files); vscode is only
    // referenced by the client, never the server. vite/esbuild are reachable
    // only through the compiler's unused Vite-plugin export - keep them out.
    external: ['typescript', 'vscode', 'vite', 'esbuild', 'lightningcss', 'fsevents']
});

console.log('bundled extension + server');
