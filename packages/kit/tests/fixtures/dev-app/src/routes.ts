// The one route table the session mounts and the renderer renders.
import { forbidden, notFound, unauthorized } from 'azerothjs';
import type { PageRoute } from '@azerothjs/kit';

import About from './pages/about.azeroth';
import Forbidden from './pages/forbidden.azeroth';
import Fresh from './pages/fresh.azeroth';
import Guarded from './pages/guarded.azeroth';
import Home from './pages/home.azeroth';
import Item from './pages/item.azeroth';
import Missing from './pages/missing.azeroth';
import Read from './pages/read.azeroth';
import Sign from './pages/sign.azeroth';
import { readings, signed } from './state.ts';

export const routes: PageRoute[] = [
    { path: '/', component: Home },
    { path: '/about', component: About, render: 'static' },
    { path: '/guarded', component: Guarded, guard: () => unauthorized() },
    { path: '/forbidden', component: Forbidden, guard: () => forbidden() },
    {
        path: '/missing',
        component: Missing,
        loader: () =>
        {
            throw notFound();
        }
    },
    {
        path: '/item/:id',
        component: Item,
        render: 'static',
        staticParams: () => Promise.resolve([{ id: 'one' }]),
        loader: ({ params }) => Promise.resolve(`ITEM ${ params.id }`)
    },
    {
        path: '/fresh',
        component: Fresh,
        render: 'static',
        revalidate: 60,
        loader: () =>
        {
            readings.fresh += 1;
            return Promise.resolve(`FRESH ${ readings.fresh }`);
        }
    },
    {
        path: '/sign',
        component: Sign,
        loader: () => Promise.resolve([...signed]),
        action: ({ form }) =>
        {
            signed.push(form.get('text') ?? '');
            return Promise.resolve(undefined);
        }
    },
    { path: '/read', component: Read },
    {
        path: '/explodes',
        component: Home,
        guard: () =>
        {
            throw new Error('PAGE HANDLER EXPLODED');
        }
    }
];
