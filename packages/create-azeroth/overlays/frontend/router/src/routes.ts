// The one route table. Adding a page is one row plus its component under
// src/pages/; the router matches top-level absolute paths and renders the
// component into <Routes>.
import type { Route } from 'azerothjs';

import Home from './pages/home.azeroth';
import About from './pages/about.azeroth';

export const routes: Route[] =
[
    { path: '/', component: Home },
    { path: '/about', component: About }
];
