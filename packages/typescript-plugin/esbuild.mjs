// Bundles the plugin into a single self-contained CommonJS file. tsserver loads
// plugins with require(), so the entry must be CJS; the AzerothJS packages it
// reuses (language-service, compiler) are ESM, so they are inlined here rather
// than required at runtime. `typescript` stays external - tsserver passes its
// own copy to the plugin factory.

import esbuild from 'esbuild';

await esbuild.build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: 'dist/index.js',
    external: ['typescript'],
    logLevel: 'info'
});
