// A CHILD-PROCESS fixture, because the defect it guards is a process EXIT and nothing
// in-process can observe that. Driven by sink-isolation.spec.ts.
//
// argv[2]: 'declared-stream' (the api layer's routes.stream -> sse) | 'kernel-stream'
// argv[3]: 'control' | 'sync' | 'async'
//
// Exits 0 if the server survived its reporting sink failing; a non-zero exit IS the defect.
// SOURCE, not the package entry. The entry resolves to dist, and an arm that tests dist is
// green whenever the build is stale - which is exactly how the first version of this test
// passed against a deliberately reverted fix.
import { App } from '../../src/app.ts';
import { serve } from '../support/serve.ts';
import { feature } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';

const seam = process.argv[2];
const mode = process.argv[3];

const sink = () =>
{
    if (mode === 'sync')
    {
        throw new Error('sink exploded');
    }
    if (mode === 'async')
    {
        return Promise.reject(new Error('sink rejected'));
    }
    return undefined;
};

const app = new App({ onStreamError: sink });

if (seam === 'declared-stream')
{
    register(app, {
        live: feature('/live', (routes) => ({
            events: routes.stream('/events', {}, async () =>
            {
                await Promise.resolve();
                throw new Error('producer died');
            })
        }))
    });
}
else
{
    app.get('/api/live/events', () =>
    {
        let sent = false;
        return new Response(new ReadableStream({
            pull(controller)
            {
                if (sent)
                {
                    throw new Error('producer died');
                }
                sent = true;
                controller.enqueue(new TextEncoder().encode('first'));
            }
        }), { headers: { 'content-type': 'text/plain' } });
    });
}

// Two more seams the callback sweep found, both outside any promise chain:
//   before-seam  - serve(app, { before }) is called bare inside the 'request' listener
//   handler-seam - a WebHandler whose handle() throws SYNCHRONOUSLY never makes the promise
//                  that the adapter's .catch() guards
const serveOptions = { port: 0 };
if (seam === 'before-seam')
{
    serveOptions.before = (request, response, next) =>
    {
        if (!String(request.url).startsWith('/boom'))
        {
            next();
            return;
        }
        if (mode === 'sync')
        {
            throw new Error('middleware exploded');
        }
        if (mode === 'async')
        {
            return Promise.reject(new Error('middleware rejected'));
        }
        next();
        return undefined;
    };
}

const target = seam === 'handler-seam'
    ? {
        handle: (request) =>
        {
            if (!new URL(request.url).pathname.startsWith('/boom'))
            {
                return new Response('ok');
            }
            if (mode === 'sync')
            {
                throw new Error('handler exploded');
            }
            if (mode === 'async')
            {
                return Promise.reject(new Error('handler rejected'));
            }
            return new Response('ok');
        }
    }
    : app;

const served = await serve(target, serveOptions);

try
{
    const path = (seam === 'before-seam' || seam === 'handler-seam') ? '/boom' : '/api/live/events';
    const response = await fetch(`http://127.0.0.1:${ served.port }${ path }`);
    await response.text().catch(() => undefined);
}
catch
{
    // The consumer's own failure is expected and is not what this fixture measures.
}

// Long enough for a floating rejection to reach the process.
await new Promise((resolve) => setTimeout(resolve, 400));
console.log('SURVIVED');
await served.shutdown({ gracePeriodMs: 300 });
process.exit(0);
