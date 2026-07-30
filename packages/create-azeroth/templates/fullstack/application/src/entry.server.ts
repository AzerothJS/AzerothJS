// The SSR bundle's entry: `vite build --ssr` compiles the SAME App the browser runs into one
// self-contained file. These two exports are the contract with both consumers - the server
// SSRs `render: 'server'` pages per request, and azeroth-kit-prerender writes the static ones
// at build time. Renaming either breaks both.
import { createPageRenderer } from '@azerothjs/kit/ssr';

import App from './App.azeroth';
import { routes } from './routes.ts';

export { routes };
export const renderPage = createPageRenderer(App, routes);
