// The SSR bundle's entry - the same App the browser runs, built into one self-contained
// file. The server and prerenderer read routes and renderPage. For a multilingual site,
// also export locales (supported tags, default and routing) and optionally a public origin.
import { createPageRenderer } from '@azerothjs/kit/ssr';

import App from './App.azeroth';
import { routes } from './routes.ts';

export { routes };
export const renderPage = createPageRenderer(App, routes);
