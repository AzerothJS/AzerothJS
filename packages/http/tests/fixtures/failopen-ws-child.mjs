// A process using ws with NO @azerothjs/http import anywhere carries no azeroth scoping
// surface, so the default scope still fails OPEN - two clients share one cached read.
// This is a known, deliberate limitation held as a LIVING record; the documented
// work-unit wiring is the remedy, and if this arm ever starts failing the limitation has
// closed and its spec must change deliberately. It doubles as proof the fail-closed mark
// rests on positive http evidence, never on environment sniffing.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The repo root, derived from THIS file's location - never a machine-local absolute
// path: the fixture must run on any checkout (CI, contributors, public clones).
const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const dist = (rel) => pathToFileURL(join(repo, rel)).href;

const { cached } = await import(dist('packages/azerothjs/dist/reactivity/data-cache.js'));
const { attachWebSockets } = await import(dist('packages/ws/dist/index.js'));

let fetchCount = 0;
const family = cached('failopen-child', (key) =>
{
    fetchCount++;
    return Promise.resolve(`v:${ key }`);
});

const server = createServer((request, response) =>
{
    response.statusCode = 404;
    response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const detach = attachWebSockets(server, {
    path: '/ws',
    onConnection: (socket) =>
    {
        socket.onMessage = () =>
        {
            void family('shared').then((value) => socket.send(`${ value }|${ fetchCount }`));
        };
    }
});

const readOnce = () => new Promise((resolve, reject) =>
{
    const client = new WebSocket(`ws://127.0.0.1:${ port }/ws`);
    client.addEventListener('open', () => client.send('go'));
    client.addEventListener('message', (event) =>
    {
        client.close();
        resolve(String(event.data));
    });
    client.addEventListener('error', () => reject(new Error('ws client error')));
});

const first = await readOnce();
const second = await readOnce();
detach();
server.close();
console.log(JSON.stringify({ first, second, fetchCount }));
process.exit(0);
