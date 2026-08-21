// The shipped-default retention arm's child body: NODE_ENV=production (DEV is read at
// module load, so this cannot run in-process under vitest), the BUILT dist (what a
// consumer executes), the DEFAULT retain (never overridden - a retain:5-only suite is the
// rigged-test anti-pattern this arm exists to kill), and a LIVING positive control that
// must run BEFORE App construction: the server mark is construction-onward, so only a
// pre-construction default-scope read can still materialize a cache and prove the counter
// sees a retained one. Its cache stays alive on purpose - releasing it would make the
// refusal arm below unable to fail, because released-null and refusal-null are
// indistinguishable at the count. The refusal arm therefore asserts on FETCHER INVOCATION
// COUNT: post-construction, the same key must fetch AGAIN (the seeded entry is refused);
// with the fail-closed predicate reverted, the cached value is served and the delta is 0.
import { queryObjects } from 'node:v8';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The repo root, derived from THIS file's location - never a machine-local absolute
// path: the fixture must run on any checkout (CI, contributors, public clones).
const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const dist = (rel) => pathToFileURL(join(repo, rel)).href;

if (process.env.NODE_ENV !== 'production')
{
    console.log(JSON.stringify({ error: `NODE_ENV is '${ process.env.NODE_ENV }', not production` }));
    process.exit(1);
}
if (typeof globalThis.gc !== 'function')
{
    console.log(JSON.stringify({ error: 'run with --expose-gc' }));
    process.exit(1);
}

const { App } = await import(dist('packages/http/dist/index.js'));
const { DataCache, cached } = await import(dist('packages/azerothjs/dist/reactivity/data-cache.js'));

let fetchCount = 0;
const family = cached('retention-child', (n) =>
{
    fetchCount++;
    return Promise.resolve(`v:${ n }`);
});

const beforeSeed = queryObjects(DataCache, { format: 'count' });
await family('app-scope');
const seedFetches = fetchCount;
const afterSeed = queryObjects(DataCache, { format: 'count' });

const app = new App();
app.get('/u/:id', async (context) =>
{
    await family(context.params.id);
    return new Response('ok');
});

for (let n = 0; n < 300; n++)
{
    const response = await app.handle(new Request(`http://local/u/${ n }`));
    await response.text();
}
await new Promise((resolve) => setTimeout(resolve, 100));
globalThis.gc();
globalThis.gc();
const afterTeardown = queryObjects(DataCache, { format: 'count' });

const preRefusal = fetchCount;
const refused = await family('app-scope');
const refusalDelta = fetchCount - preRefusal;
globalThis.gc();
const afterRefusal = queryObjects(DataCache, { format: 'count' });

console.log(JSON.stringify({
    nodeEnv: process.env.NODE_ENV,
    beforeSeed,
    seedFetches,
    afterSeed,
    afterTeardown,
    refusalDelta,
    refusedValue: refused,
    afterRefusal
}));
