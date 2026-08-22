// The work-unit heap arm's production body: NODE_ENV=production against the BUILT dist,
// through real sockets and the real interceptor at the SHIPPED default retain. Fifty
// intercepted messages each materialize a per-unit cache and settle; afterward ZERO
// DataCache instances may remain - release at settle is what makes per-message scoping
// affordable. The LIVING control is a fifty-first unit that never settles: its scope must
// pin exactly one cache, proving the counter can see a retained unit at all.
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

const { App, createWorkUnitInterceptor } = await import(dist('packages/http/dist/index.js'));
const { serve } = await import(dist('packages/http/dist/node.js'));
const { attachWebSockets } = await import(dist('packages/ws/dist/index.js'));
const { DataCache, cached } = await import(dist('packages/azerothjs/dist/reactivity/data-cache.js'));

const family = cached('work-unit-child', (key) => Promise.resolve(`v:${ key }`));

const app = new App();
const served = await serve(app, { banner: false });
const detach = attachWebSockets(served.server, {
    path: '/ws',
    intercept: createWorkUnitInterceptor(),
    onConnection: (socket) =>
    {
        socket.onMessage = async (data) =>
        {
            const value = await family(String(data));
            socket.send(String(value));
            if (String(data) === 'hold')
            {
                await new Promise(() => undefined);
            }
        };
    }
});

const client = new WebSocket(`ws://127.0.0.1:${ served.port }/ws`);
await new Promise((resolve) => client.addEventListener('open', resolve));
let replies = 0;
let sawAll50;
let sawHold;
const got50 = new Promise((resolve) =>
{
    sawAll50 = resolve;
});
const got51 = new Promise((resolve) =>
{
    sawHold = resolve;
});
client.addEventListener('message', () =>
{
    replies++;
    if (replies === 50)
    {
        sawAll50(undefined);
    }
    if (replies === 51)
    {
        sawHold(undefined);
    }
});
for (let n = 0; n < 50; n++)
{
    client.send(`m${ n }`);
}
// Reply-gated, not time-gated: the count must not race in-flight units on a slow machine.
await got50;
await new Promise((resolve) => setTimeout(resolve, 100));
globalThis.gc();
globalThis.gc();
const afterSettled = queryObjects(DataCache, { format: 'count' });

client.send('hold');
await got51;
await new Promise((resolve) => setTimeout(resolve, 100));
globalThis.gc();
const afterHeld = queryObjects(DataCache, { format: 'count' });

console.log(JSON.stringify({
    nodeEnv: process.env.NODE_ENV,
    replies,
    afterSettled,
    afterHeld
}));
client.close();
detach();
await served.shutdown({ gracePeriodMs: 200 });
process.exit(0);
