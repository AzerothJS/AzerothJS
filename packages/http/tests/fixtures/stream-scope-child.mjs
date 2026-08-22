// The streamed-scope arm's production body: NODE_ENV=production against the BUILT dist,
// through the real kernel path. A synchronous producer's pulls are dispatched by the
// consumer's pace, so without explicit re-entry pulls 2+ resolve the default scope -
// refused on a marked server, one fresh fetch per pull. With re-entry every pull reuses
// the request's entry: one fetch per request, two for two sequential requests.
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

const { App } = await import(dist('packages/http/dist/index.js'));
const { cached } = await import(dist('packages/azerothjs/dist/reactivity/data-cache.js'));

const encoder = new TextEncoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countingFamily(name)
{
    let count = 0;
    const family = cached(name, (key) =>
    {
        count++;
        return Promise.resolve(`${ name }:${ key }`);
    });
    return { family, fetches: () => count };
}

function syncProducerHandler(family, pulls)
{
    return async () =>
    {
        await family('k');
        let n = 0;
        const stream = new ReadableStream({
            async pull(controller)
            {
                if (n >= pulls)
                {
                    controller.close();
                    return;
                }
                n++;
                await family('k');
                controller.enqueue(encoder.encode(`c${ n }`));
            }
        });
        return new Response(stream);
    };
}

async function consume(response, gapMs)
{
    const reader = response.body.getReader();
    for (;;)
    {
        const { done } = await reader.read();
        if (done)
        {
            break;
        }
        await sleep(gapMs);
    }
}

const app = new App();
const one = countingFamily('one-request');
app.get('/one', syncProducerHandler(one.family, 3));
await consume(await app.handle(new Request('http://local/one')), 15);

const two = countingFamily('two-requests');
app.get('/two', syncProducerHandler(two.family, 3));
await consume(await app.handle(new Request('http://local/two')), 15);
await consume(await app.handle(new Request('http://local/two')), 15);

console.log(JSON.stringify({
    nodeEnv: process.env.NODE_ENV,
    fetchesOneRequest: one.fetches(),
    fetchesTwoRequests: two.fetches()
}));
process.exit(0);
