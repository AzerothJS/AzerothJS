// The SSR bundle's entry - the same App the browser runs, built into one self-contained
// file. The two exports are the contract with the server AND the prerenderer; renaming
// either breaks both.
import { createPageRenderer } from '@azerothjs/kit/ssr';

import App from './App.azeroth';
import { routes } from './routes.ts';

export { routes };
export const renderPage = createPageRenderer(App, routes);
