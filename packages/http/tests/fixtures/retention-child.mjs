// The shipped-default retention arm's child body: NODE_ENV=production (DEV is read at
// module load, so this cannot run in-process under vitest), the BUILT dist (what a
// consumer executes), the DEFAULT retain (never overridden - a retain:5-only suite is the
// rigged-test anti-pattern this arm exists to kill), and a LIVING positive control: after
// asserting zero retained caches, one app-scope read must raise the count to exactly one,
// proving the counter can see a retained cache at all.
import { queryObjects } from 'node:v8';

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

const { App } = await import('file:///C:/Users/IntelligentQuantum/Documents/Projects/AzerothJS/packages/http/dist/index.js');
const { DataCache, cached } = await import(
    'file:///C:/Users/IntelligentQuantum/Documents/Projects/AzerothJS/packages/azerothjs/dist/reactivity/data-cache.js');

const family = cached('retention-child', (n) => Promise.resolve(`v:${ n }`));

const app = new App();
app.get('/u/:id', async (context) =>
{
    await family(context.params.id);
    return new Response('ok');
});

const before = queryObjects(DataCache, { format: 'count' });
for (let n = 0; n < 300; n++)
{
    const response = await app.handle(new Request(`http://local/u/${ n }`));
    await response.text();
}
await new Promise((resolve) => setTimeout(resolve, 100));
globalThis.gc();
globalThis.gc();
const afterTeardown = queryObjects(DataCache, { format: 'count' });

// The living control: an app-scope (default scope, no request root) read on this same
// unlatched process materializes a cache that IS retained - by the scope singleton and
// its default-retain timer - so the counter demonstrably can report nonzero.
await family('app-scope');
globalThis.gc();
const afterAppScopeRead = queryObjects(DataCache, { format: 'count' });

console.log(JSON.stringify({
    nodeEnv: process.env.NODE_ENV,
    before,
    afterTeardown,
    afterAppScopeRead
}));
