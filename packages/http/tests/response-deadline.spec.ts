// @vitest-environment node
//
// A response deadline bounds the CLIENT'S WAIT, and nothing else. Everything interesting about
// it is what it must refuse to do:
//
//   - It must not settle the scope. onWorkUnitCleanup runs a registration IMMEDIATELY once a
//     scope is settled (its late path is written for a request that is genuinely over), so a
//     deadline that marked a still-running handler settled would fire the `release()` that
//     handler registers on acquiring a connection - and the handler would then go on using a
//     connection already back in the pool. That is a use-after-release the feature would have
//     INTRODUCED, so it gets an arm of its own.
//   - It must still settle at the handler's true end, and it must CANCEL a late streaming body.
//     A stream returned after the deadline is a response nobody will ever pull, so without an
//     explicit cancel its cleanups would never run at all - a permanent leak, and specific to
//     the streaming case.
//   - It must not bound a streaming body that arrives in time. The clock stops at the Response,
//     or SSE and static file serving would be broken by design.
import { describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';
import { onWorkUnitCleanup } from '../src/request-root.ts';

/** A handler that never settles: a wedged upstream, a lost lock, a bad await. */
const never = (): Promise<Response> => new Promise<Response>(() =>
{
    // Deliberately empty - the point is that nothing ever resolves this.
});
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a blown response deadline answers the client', () =>
{
    it('sends 503 with Retry-After and a message that says what happened', async () =>
    {
        const app = new App({ responseTimeoutMs: 40 });
        app.get('/hang', never);

        const response = await app.handle(new Request('http://local/hang'));
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('1');
        // Not "Internal server error": a 5xx hides its message by default, which would make a
        // deadline indistinguishable from a crash for the one status where the client's next
        // move depends on telling them apart.
        expect(JSON.stringify(await response.json())).toContain('too long');
    });

    it('CONTROL: a handler that answers in time is untouched, and no deadline means no bound', async () =>
    {
        const app = new App({ responseTimeoutMs: 200 });
        app.get('/fast', () => new Response('ok'));
        const fast = await app.handle(new Request('http://local/fast'));
        expect(fast.status).toBe(200);
        expect(await fast.text()).toBe('ok');

        // Same handler shape, no option: the deadline path must not be reachable at all.
        const unbounded = new App();
        unbounded.get('/slow', async () =>
        {
            await tick(60);
            return new Response('late but fine');
        });
        const slow = await unbounded.handle(new Request('http://local/slow'));
        expect(slow.status).toBe(200);
        expect(await slow.text()).toBe('late but fine');
    });
});

describe('the deadline must not touch the still-running handler\'s scope', () =>
{
    it('a cleanup registered AFTER the deadline is queued, not run under the handler\'s feet', async () =>
    {
        // The use-after-release arm. The handler acquires its "connection" after the deadline
        // has already answered, exactly as a handler waiting on a slow pool would.
        const events: string[] = [];
        let releaseHasRun = false;

        const app = new App({ responseTimeoutMs: 40 });
        let finished!: () => void;
        const handlerDone = new Promise<void>((resolve) =>
        {
            finished = resolve;
        });

        app.get('/slow-pool', async () =>
        {
            await tick(90);
            events.push('acquired');
            onWorkUnitCleanup(() =>
            {
                releaseHasRun = true;
                events.push('released');
            });
            // The handler KEEPS USING the connection after registering its release.
            await tick(20);
            events.push(`used; released already? ${ String(releaseHasRun) }`);
            finished();
            return new Response('too late');
        });

        const response = await app.handle(new Request('http://local/slow-pool'));
        expect(response.status).toBe(503);

        await handlerDone;
        await tick(30);

        // The release must NOT have run before the use.
        expect(events).toEqual(['acquired', 'used; released already? false', 'released']);
    });

    it('the scope still settles at the handler\'s true end, so nothing leaks', async () =>
    {
        let cleanupRan = false;
        const app = new App({ responseTimeoutMs: 30 });
        app.get('/eventually', async () =>
        {
            onWorkUnitCleanup(() =>
            {
                cleanupRan = true;
            });
            await tick(80);
            return new Response('done');
        });

        const response = await app.handle(new Request('http://local/eventually'));
        expect(response.status).toBe(503);
        expect(cleanupRan).toBe(false);

        await tick(120);
        expect(cleanupRan).toBe(true);
    });

    it('a STREAMING response arriving after the deadline is cancelled, not left unread', async () =>
    {
        // Without an explicit cancel this is the permanent leak: nothing ever pulls the body,
        // so the producer holds whatever it holds and the cleanups never run.
        let cancelled = false;
        let cleanupRan = false;

        const app = new App({ responseTimeoutMs: 30 });
        app.get('/late-stream', async () =>
        {
            onWorkUnitCleanup(() =>
            {
                cleanupRan = true;
            });
            await tick(70);
            const body = new ReadableStream<Uint8Array>({
                start(controller)
                {
                    controller.enqueue(new TextEncoder().encode('chunk'));
                },
                cancel()
                {
                    cancelled = true;
                }
            });
            return new Response(body);
        });

        const response = await app.handle(new Request('http://local/late-stream'));
        expect(response.status).toBe(503);

        await tick(140);
        expect(cancelled).toBe(true);
        expect(cleanupRan).toBe(true);
    });

    it('CONTROL: a stream that arrives IN TIME is not cancelled and may run long', async () =>
    {
        // The clock stops at the Response. Cancelling here would break SSE and static files.
        let cancelled = false;
        const app = new App({ responseTimeoutMs: 60 });
        app.get('/sse', () =>
        {
            const body = new ReadableStream<Uint8Array>({
                start(controller)
                {
                    controller.enqueue(new TextEncoder().encode('open'));
                },
                cancel()
                {
                    cancelled = true;
                }
            });
            return new Response(body);
        });

        const response = await app.handle(new Request('http://local/sse'));
        expect(response.status).toBe(200);
        // Well past the deadline, with the body still open and unread: it must survive. The
        // stream is deliberately never closed - that is what "may run long" means, and reading
        // it to completion would hang rather than test anything.
        await tick(120);
        expect(cancelled).toBe(false);

        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe('open');
        await reader.cancel();
    });
});
