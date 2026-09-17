// The one file that crosses into the server half - with TYPES only: `typeof api` is erased
// at build, so no handler or server dependency can reach the browser bundle. The runtime
// half is the manifest: embedded in a server-rendered page (readManifest, synchronous),
// one fetch on a plain vite dev page.
import { applyFieldErrors, createClient, readManifest, type Manifest, type Wire } from '@azerothjs/http/api/shared';
import type { api } from '../../server/src/app.ts';
import type { Entry as ServerEntry } from '../../server/src/schemas.ts';

export { entryInput } from '../../server/src/schemas.ts';
export { applyFieldErrors };

// The wire projection: the server stores `at` as a Date; the browser receives its ISO string.
export type Entry = Wire<ServerEntry>;

// The server half needs no manifest of its own: the page request carries the registered one
// together with an in-process transport that keeps the visitor's identity, so a loader calls
// the same `client.*` the browser does. In the browser an unreachable manifest degrades to {}
// so each call fails at its own site, not at module load.
const manifest: Manifest = typeof document === 'undefined'
    ? {}
    : readManifest() ?? await fetch('/api/_manifest')
        .then((response) => response.json() as Promise<Manifest>)
        .catch(() => ({}));

export const client = createClient<typeof api>(manifest, { baseUrl: '/api' });
