// The one route table: the client router, the SSR entry, and the kit's server half all read
// it, so there is no second manifest. A page is one row; `render` is how it ships.
import type { PageRoute } from '@azerothjs/kit';

import { client } from './api.ts';
import Home from './pages/home.azeroth';
import GuestBook from './pages/guest-book.azeroth';

export const routes: PageRoute[] = [
    // Rendered at build, then ISR: the build output seeds a page cache, and past the
    // 5-minute window a stale copy answers instantly while ONE background render replaces it.
    { path: '/', component: Home, render: 'static', revalidate: 300 },
    // SSR'd per request - a direct load arrives as real markup and hydrates. The loader runs
    // on the server, where the same typed client reaches the api in process, so the first
    // bytes already carry the list and the browser never refetches it to draw the page.
    { path: '/guestbook', component: GuestBook, render: 'server', loader: () => client.guestbook.list() }
];
