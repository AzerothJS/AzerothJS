// The one route table: the client router, the SSR entry, and the kit's server half all read
// it, so there is no second manifest. A page is one row; `render` is how it ships.
import type { PageRoute } from '@azerothjs/kit';

import Home from './pages/home.azeroth';
import GuestBook from './pages/guest-book.azeroth';

export const routes: PageRoute[] = [
    // Rendered at build, then ISR: the build output seeds a page cache, and past the
    // 5-minute window a stale copy answers instantly while ONE background render replaces it.
    { path: '/', component: Home, render: 'static', revalidate: 300 },
    // SSR'd per request - a direct load arrives as real markup and hydrates.
    { path: '/guestbook', component: GuestBook, render: 'server' }
];
