// Bundles the plugin into a single self-contained CommonJS file. tsserver loads
// plugins with require(), so the entry must be CJS; the AzerothJS packages it
// reuses (language-service, compiler) are ESM, so they are inlined here rather
// than required at runtime.
//
// Externals:
//   typescript   - tsserver passes its own copy to the plugin factory.
//   vite         - optional peer dep of @azerothjs/compiler; only needed at
//                  build time, never inside tsserver. Marking it external keeps
//                  the Vite plugin code path out of the bundle entirely.
//   lightningcss - native .node binary pulled in transitively by vite; cannot
//                  be bundled (esbuild cannot resolve the glob that selects the
//                  platform binary). External + irrelevant at runtime here.
//   esbuild      - vite's internal bundler; uses require.resolve("esbuild") to
//                  locate itself, which breaks when inlined. External + unused
//                  inside tsserver.

import esbuild from 'esbuild';

await esbuild.build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: 'dist/index.js',
    external: ['typescript', 'vite', 'lightningcss', 'esbuild'],
    logLevel: 'info'
});
