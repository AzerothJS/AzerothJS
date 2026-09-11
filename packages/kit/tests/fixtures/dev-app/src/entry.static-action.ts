// A 'static' page declaring an action: the same mount error under shell and under clientDir.
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRoute } from '@azerothjs/kit';

import App from './App.azeroth';
import Sign from './pages/sign.azeroth';

export const routes: PageRoute[] = [
    { path: '/frozen', component: Sign, render: 'static', action: () => Promise.resolve(undefined) }
];
export const renderPage = createPageRenderer(App, routes);
