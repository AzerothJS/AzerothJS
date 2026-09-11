// The two exports the session, a production mount and the prerender bin all read.
import { createPageRenderer } from '@azerothjs/kit/ssr';

import App from './App.azeroth';
import { routes } from './routes.ts';

export { routes };
export const renderPage = createPageRenderer(App, routes);

// The gate arm compares this against the `azerothjs` the spec imports: one process, one runtime
// instance, or the per-request store scope and data cache are split in silence.
export { createSignal } from 'azerothjs';
