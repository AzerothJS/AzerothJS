// A 'static' page under a guarded chain: the mount error must read the same under the session's
// shell as under a built clientDir.
import { unauthorized } from 'azerothjs';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRoute } from '@azerothjs/kit';

import App from './App.azeroth';
import Guarded from './pages/guarded.azeroth';

export const routes: PageRoute[] = [
    { path: '/locked', component: Guarded, render: 'static', guard: () => unauthorized() }
];
export const renderPage = createPageRenderer(App, routes);
