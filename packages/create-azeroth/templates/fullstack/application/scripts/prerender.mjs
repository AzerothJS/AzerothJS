// Prerenders the home route at BUILD time. Runs after `vite build` (the client,
// dist/) and `vite build --ssr` (the server bundle, dist-server/):
//
//   1. dist/index.html (vite's SPA shell, hashed asset tags) is kept as dist/spa.html -
//      the server serves it for client-routed pages like /guestbook.
//   2. The home route is rendered through the SSR bundle and spliced into the shell's
//      root element - dist/index.html becomes real, hydratable content.
//
// One route prerendered is the pattern; add more by rendering other URLs the same way.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

const { renderPage } = await import(new URL('../dist-server/entry-server.js', import.meta.url).href);

const shell = readFileSync(join(dist, 'index.html'), 'utf8');
copyFileSync(join(dist, 'index.html'), join(dist, 'spa.html'));

const html = shell.replace('<div id="root"></div>', `<div id="root">${ renderPage('/') }</div>`);
if (html === shell)
{
    throw new Error('prerender: could not find <div id="root"></div> in dist/index.html');
}
writeFileSync(join(dist, 'index.html'), html);
console.log('prerendered / -> dist/index.html (SPA shell kept as dist/spa.html)');
