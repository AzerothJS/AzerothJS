// ============================================================================
// AZEROTHJS DEMO — Router & Route Table
// ============================================================================
//
// The demo IS a routed app: AzerothJS's own router is the shell.
// This module defines the route table and the single shared router
// instance that the shell and every page import.
//
// Route components only receive `{ children }`; they reach the
// router (for <Link>, useParams, useNavigate) by importing the
// `router` singleton from here. The cyclic import (pages → router →
// pages) is safe because pages touch `router` only at render time,
// never at module-eval time.
//
// ============================================================================

import { createRouter, type Route } from '@azerothjs/core';
import { HomePage } from './pages/home.ts';
import { ReactivityPage } from './pages/reactivity.ts';
import { RenderingPage } from './pages/rendering.ts';
import { ComponentsPage } from './pages/components.ts';
import { DataPage } from './pages/data.ts';
import { FormsPage } from './pages/forms.ts';
import { RoutingPage, RoutingIndex, UserDetail } from './pages/routing.ts';

/** Nav entries the sidebar renders, in order. */
export const NAV = [
    { path: '/', label: 'Home', icon: '⚛️' },
    { path: '/reactivity', label: 'Reactivity', icon: '⚡' },
    { path: '/rendering', label: 'Rendering', icon: '🧩' },
    { path: '/components', label: 'Components', icon: '📦' },
    { path: '/data', label: 'Data', icon: '🔌' },
    { path: '/forms', label: 'Forms', icon: '📝' },
    { path: '/routing', label: 'Routing', icon: '🧭' }
];

const routes: Route[] = [
    { path: '/', component: HomePage },
    { path: '/reactivity', component: ReactivityPage },
    { path: '/rendering', component: RenderingPage },
    { path: '/components', component: ComponentsPage },
    { path: '/data', component: DataPage },
    { path: '/forms', component: FormsPage },
    {
        // A layout route: RoutingPage renders an <Outlet> for the
        // nested children below.
        path: '/routing',
        component: RoutingPage,
        children: [
            { path: '', component: RoutingIndex },
            { path: 'users/:id', component: UserDetail }
        ]
    }
];

/** The shared router instance for the whole demo. */
export const router = createRouter({ routes });
