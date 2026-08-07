// The one file that crosses into the server half - with TYPES only: `typeof api` is erased
// at build, so no handler or server dependency can reach the browser bundle. The runtime
// half is the manifest: embedded in a server-rendered page (readManifest, synchronous),
// one fetch on a plain vite dev page.
import { createClient, readManifest, type Manifest } from '@azerothjs/http/api/shared';
import type { api } from '../../server/src/app.ts';

export { entryInput, type Entry } from '../../server/src/schemas.ts';

// SSR loads with an empty manifest (pages fetch in browser-only `mount { }`), and an
// unreachable one degrades to {} so each call fails at its own site, not module load.
const manifest: Manifest = typeof document === 'undefined'
    ? {}
    : readManifest() ?? await fetch('/api/_manifest')
        .then((response) => response.json() as Promise<Manifest>)
        .catch(() => ({}));

export const client = createClient<typeof api>(manifest, { baseUrl: '/api' });
