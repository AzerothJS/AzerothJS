// The SSR bundle: `vite build --ssr src/entry.server.ts` compiles the SAME App the
// browser runs into one self-contained file. `renderPage` renders one url through
// the router's guards and loaders into the built shell (hashed asset tags kept);
// the production server SSRs `render: 'server'` pages with it per request, and
// `azeroth-kit-prerender` writes `render: 'static'` pages through it at build time.
import { createPageRenderer } from '@azerothjs/kit/ssr';

import App from './App.azeroth';
import { routes } from './routes.ts';

export { routes };
export const renderPage = createPageRenderer(App, routes);
