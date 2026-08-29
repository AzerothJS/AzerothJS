// The DEV family-registry retention arm: NODE_ENV=development (DEV is read at module
// load) against the BUILT dist. A DYNAMIC family name whose fetcher was dropped must be
// COLLECTIBLE - the registry holds records weakly, so the per-tenant `cached()` shape
// cannot pin one closure per distinct name forever. The module-held control proves the
// probe can fail in both directions: a family whose fetcher is still referenced stays
// alive (HMR swap depends on it), and a collected name re-registers cleanly.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The repo root, derived from THIS file's location - never a machine-local absolute
// path: the fixture must run on any checkout (CI, contributors, public clones).
const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
const dist = (rel) => pathToFileURL(join(repo, rel)).href;

if (process.env.NODE_ENV !== 'development')
{
    console.log(JSON.stringify({ error: `NODE_ENV is '${ process.env.NODE_ENV }', not development` }));
    process.exit(1);
}
if (typeof globalThis.gc !== 'function')
{
    console.log(JSON.stringify({ error: 'run with --expose-gc' }));
    process.exit(1);
}

const { cached, CACHED_FAMILY } = await import(dist('packages/azerothjs/dist/reactivity/data-cache.js'));

// Inside a function activation, not a top-level block: module-level block scopes can
// stay reachable through top-level-await resumption frames, which would fake retention.
function makeDynamic()
{
    const family = cached('dyn:tenant', (key) => Promise.resolve(String(key)));
    return new WeakRef(family[CACHED_FAMILY]);
}
const dynRef = makeDynamic();
const held = cached('held', (key) => Promise.resolve(String(key)));
const heldRef = new WeakRef(held[CACHED_FAMILY]);

await new Promise((resolve) => setTimeout(resolve, 10));
globalThis.gc();
globalThis.gc();
await new Promise((resolve) => setTimeout(resolve, 10));
globalThis.gc();

const dynCollected = dynRef.deref() === undefined;
const heldAlive = heldRef.deref() !== undefined;

const again = cached('dyn:tenant', (key) => Promise.resolve(`fresh:${ key }`));
const reRegistered = (await again('x')) === 'fresh:x';

console.log(JSON.stringify({
    nodeEnv: process.env.NODE_ENV,
    dynCollected,
    heldAlive,
    reRegistered
}));
process.exit(0);
