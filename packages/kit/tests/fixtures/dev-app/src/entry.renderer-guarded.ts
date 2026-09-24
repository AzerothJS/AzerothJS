// The session mounts `routes`, and `renderPage` guards /fresh, which `routes` does not: the table
// mismatch a server-only upgrade leaves. The guard counts the shared renders it meets.
import { unauthorized } from 'azerothjs';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRoute } from '@azerothjs/kit';

import App from './App.azeroth';
import { routes } from './routes.ts';

const probe = globalThis as { __azerothSharedGuardCalls?: number };

const guarded: PageRoute[] = routes.map((route) => (route.path !== '/fresh' ? route : {
    ...route,
    guard: ({ request }) =>
    {
        if (request === null)
        {
            probe.__azerothSharedGuardCalls = (probe.__azerothSharedGuardCalls ?? 0) + 1;
        }
        return request?.headers.get('cookie')?.includes('who=alice') === true ? true : unauthorized();
    }
}));

export { routes };
export const renderPage = createPageRenderer(App, guarded);
