// The one file that crosses into the server half - and it crosses with TYPES only. The value
// import below is client-safe schemas; `typeof api` is erased at build, so no handler, store,
// or server dependency can reach the browser bundle. The client's runtime half is the manifest:
// method + path per route, projected from the SAME declaration the server registered. A
// server-rendered page carries it embedded (readManifest - synchronous, no round trip); a
// plain vite dev page falls back to one fetch. '/api' matches the dev proxy and the
// production mount.
import { createClient, readManifest, type Manifest } from '@azerothjs/http/api/shared';
import type { api } from '../../server/src/app.ts';

export { entryInput, type Entry } from '../../server/src/schemas.ts';

// During SSR the module loads with an empty manifest: pages fetch data in `mount { }`, which
// runs only in the browser, so no call ever happens server-side. An UNREACHABLE manifest
// (component tests, the api half down in dev) degrades to {} instead of taking the whole
// module graph down - each call then fails at its own site with an error naming the cause.
const manifest: Manifest = typeof document === 'undefined'
    ? {}
    : readManifest() ?? await fetch('/api/_manifest')
        .then((response) => response.json() as Promise<Manifest>)
        .catch(() => ({}));

export const client = createClient<typeof api>(manifest, { baseUrl: '/api' });
