// The SSR bundle: `vite build --ssr src/entry.server.ts` compiles the SAME App the
// browser runs into one self-contained file. `renderPage` renders one url through the
// route table into the built shell (hashed asset tags kept) - running any guards and
// loaders those routes declare; the production server SSRs `render: 'server'` pages
// with it per request (server/src/main.ts imports THIS file's two exports), and
// `azeroth-kit-prerender` writes `render: 'static'` pages through it at build time.
import { createPageRenderer } from '@azerothjs/kit/ssr';

import App from './App.azeroth';
import { routes } from './routes.ts';

export { routes };
export const renderPage = createPageRenderer(App, routes);
