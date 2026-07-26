#!/usr/bin/env node
// Binary entry for `azeroth-kit-prerender`. Runs the static pass over the SSR
// bundle: `--entry` is the built server module (exporting `renderPage` from
// createPageRenderer and the `routes` table), `--client` the vite dist. Defaults
// match the template layout, so a bare invocation works there.

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { prerender } from './prerender.ts';
import type { PageRoute } from './index.ts';
import type { PageRenderer } from './ssr.ts';

const { values } = parseArgs({
    options: {
        entry: { type: 'string', default: 'dist-server/entry.server.js' },
        client: { type: 'string', default: 'dist' }
    }
});

const entryUrl = pathToFileURL(resolve(values.entry)).href;
const module = await import(entryUrl) as {
    renderPage?: PageRenderer;
    routes?: PageRoute[];
};
if (typeof module.renderPage !== 'function' || !Array.isArray(module.routes))
{
    console.error(`azeroth-kit-prerender: ${ values.entry } must export \`renderPage\` (createPageRenderer) and \`routes\`.`);
    process.exit(1);
}

const written = await prerender({
    routes: module.routes,
    clientDir: resolve(values.client),
    renderer: module.renderPage
});
console.log(written.length === 0
    ? 'kit prerender: no render: \'static\' pages - shell preserved.'
    : `kit prerender: ${ written.join(', ') } -> ${ values.client }`);
