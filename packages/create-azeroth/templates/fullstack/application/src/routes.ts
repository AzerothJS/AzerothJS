// The one route table. The client router mounts it, the SSR entry renders through
// it, and the kit's server half reads the per-route `render` mode from it - there
// is no second manifest. Adding a page is one row plus its component; choosing HOW
// it ships is the one field.
import type { PageRoute } from '@azerothjs/kit';

import Home from './pages/home.azeroth';
import GuestBook from './pages/guest-book.azeroth';

export const routes: PageRoute[] = [
    // Rendered ONCE at build (azeroth-kit-prerender) and served as a file.
    { path: '/', component: Home, render: 'static' },
    // SSR'd per request - a direct load arrives as real markup and hydrates.
    { path: '/guestbook', component: GuestBook, render: 'server' }
];
