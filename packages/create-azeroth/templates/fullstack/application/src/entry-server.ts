// The SSR entry: the SAME compiled App, rendered to a hydration-ready markup
// string. `vite build --ssr` bundles this file; scripts/prerender.mjs imports the
// bundle at build time and splices the result into vite's built shell (keeping the
// hashed script/css tags) - view-source on / shows real content, and main.azeroth
// hydrates over it in the browser.
import { renderToString } from 'azerothjs';

import App from './App.azeroth';

export function renderPage(url: string): string
{
    return renderToString(() => App({ url }));
}
