// The one file that crosses into the server half - and it crosses with TYPES only. The value
// import below is client-safe schemas; `typeof api` is erased at build, so no handler, store,
// or server dependency can reach the browser bundle. The client's runtime half is the served
// manifest: method + path per route, projected from the SAME declaration the server registered,
// fetched once at boot. '/api' matches the dev proxy and the production mount.
import { createClient, type Manifest } from '@azerothjs/http/api/shared';
import type { api } from '../../server/src/app.ts';

export { entryInput, type Entry } from '../../server/src/schemas.ts';

// During SSR the module loads with an empty manifest: pages fetch data in `mount { }`, which
// runs only in the browser, so no call ever happens server-side. The browser fetches the real
// manifest before the first paint's interactions need it.
const manifest: Manifest = typeof document === 'undefined'
    ? {}
    : await fetch('/api/_manifest').then((response) => response.json() as Promise<Manifest>);

export const client = createClient<typeof api>(manifest, { baseUrl: '/api' });
