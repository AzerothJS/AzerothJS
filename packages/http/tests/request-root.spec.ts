// @vitest-environment node
//
// The request root: store isolation that SURVIVES await (the thing reactivity's synchronous
// runInStoreScope cannot give an async handler), and a cleanup registry that always runs.
// The isolation tests interleave two real requests on purpose - the failure mode being
// guarded is one request reading the other's store after an await.

import { describe, it, expect, vi } from 'vitest';
import { createSignal, getStoreScope, runInStoreScope, createStore } from 'azerothjs';
import { App } from '../src/app.ts';
import { json } from '../src/respond.ts';
import { onRequestCleanup } from '../src/request-root.ts';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('store isolation across awaits', () =>
{
    it('two interleaved requests each see their OWN store instance', async () =>
    {
        const useCounter = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            return { count, increment: (): void => setCount((value) => value + 1) };
        });

        const app = new App();
        app.get('/slow/:label', async (context) =>
        {
            const counter = useCounter();
            counter.increment();
            await pause(20); // the other request runs here, in ITS scope
            counter.increment();
            await pause(20);
            return json({ label: context.params.label, count: counter.count() });
        });

        const [first, second] = await Promise.all([
            app.handle(new Request('http://local/slow/a')),
            (async (): Promise<Response> =>
            {
                await pause(10); // start mid-flight through the first request
                return app.handle(new Request('http://local/slow/b'));
            })()
        ]);

        // Without per-request isolation the interleaved increments would sum in one shared
        // instance and at least one request would report count > 2.
        expect(await first.json()).toEqual({ label: 'a', count: 2 });
        expect(await second.json()).toEqual({ label: 'b', count: 2 });
    });

    it('the scope is STABLE across awaits within one request', async () =>
    {
        const app = new App();
        app.get('/scoped', async () =>
        {
            const before = getStoreScope();
            await pause(5);
            const after = getStoreScope();
            return json({ stable: before === after });
        });
        expect(await (await app.handle(new Request('http://local/scoped'))).json()).toEqual({ stable: true });
    });

    it('a synchronous SSR-style scope nested inside a request takes precedence', async () =>
    {
        const app = new App();
        app.get('/nested', () =>
        {
            const requestScope = getStoreScope();
            const nested = runInStoreScope(() => getStoreScope());
            return json({ distinct: nested !== requestScope });
        });
        expect(await (await app.handle(new Request('http://local/nested'))).json()).toEqual({ distinct: true });
    });

    it('with requestRoot: false the async scope machinery is absent', async () =>
    {
        const app = new App({ requestRoot: false });
        app.get('/bare', () =>
        {
            expect(() => onRequestCleanup(() => undefined)).toThrow(/outside a request/);
            return json({ ok: true });
        });
        expect((await app.handle(new Request('http://local/bare'))).status).toBe(200);
    });
});

describe('onRequestCleanup: teardown always runs', () =>
{
    it('runs after a successful response, LIFO', async () =>
    {
        const order: string[] = [];
        const app = new App();
        app.get('/ok', () =>
        {
            onRequestCleanup(() => void order.push('first-registered'));
            onRequestCleanup(() => void order.push('second-registered'));
            return json({ ok: true });
        });
        await app.handle(new Request('http://local/ok'));
        expect(order).toEqual(['second-registered', 'first-registered']);
    });

    it('runs when the handler THROWS (the error response still goes out)', async () =>
    {
        const cleaned = vi.fn();
        const app = new App();
        app.get('/boom', () =>
        {
            onRequestCleanup(cleaned);
            throw new Error('handler failed');
        });
        const response = await app.handle(new Request('http://local/boom'));
        expect(response.status).toBe(500);
        expect(cleaned).toHaveBeenCalledTimes(1);
    });

    it('awaits async cleanups', async () =>
    {
        let released = false;
        const app = new App();
        app.get('/tx', () =>
        {
            onRequestCleanup(async () =>
            {
                await pause(10);
                released = true;
            });
            return json({ ok: true });
        });
        await app.handle(new Request('http://local/tx'));
        expect(released).toBe(true);
    });

    it('a throwing cleanup is reported and the REST still run', async () =>
    {
        const onError = vi.fn();
        const survivor = vi.fn();
        const app = new App({ onError });
        app.get('/messy', () =>
        {
            onRequestCleanup(survivor); // registered first, runs last (LIFO)
            onRequestCleanup(() =>
            {
                throw new Error('cleanup exploded');
            });
            return json({ ok: true });
        });
        const response = await app.handle(new Request('http://local/messy'));
        expect(response.status).toBe(200); // teardown failure never clobbers the response
        expect(survivor).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('throws loudly outside a request', () =>
    {
        expect(() => onRequestCleanup(() => undefined)).toThrow(/outside a request/);
    });
});

describe('onRequestCleanup: streaming responses defer teardown to stream-end', () =>
{
    it('does NOT run cleanup until a streaming body is fully consumed', async () =>
    {
        let released = false;
        const app = new App();
        app.get('/stream', () =>
        {
            // A live producer that emits after an await - the resource (a pooled connection,
            // a transaction) is still in use while this pulls. Releasing it at handler-return
            // would be a use-after-release; the fix ties release to the stream's end.
            const body = new ReadableStream<Uint8Array>({
                async pull(controller)
                {
                    await pause(15);
                    if (released)
                    {
                        // If the cleanup already ran, the resource is gone - surface it in-band.
                        controller.enqueue(new TextEncoder().encode('USE-AFTER-RELEASE'));
                        controller.close();
                        return;
                    }
                    controller.enqueue(new TextEncoder().encode('chunk'));
                    controller.close();
                }
            });
            onRequestCleanup(() => void (released = true));
            return new Response(body, { headers: { 'content-type': 'text/plain' } });
        });

        const response = await app.handle(new Request('http://local/stream'));
        // The handler returned, but the stream has not been read: cleanup MUST still be pending.
        expect(released).toBe(false);

        const text = await response.text(); // drain the body to completion
        expect(text).toBe('chunk');           // never 'USE-AFTER-RELEASE'
        expect(released).toBe(true);          // now, and only now, the cleanup has run
    });

    it('runs cleanup when the consumer CANCELS a stream mid-flight (client disconnect)', async () =>
    {
        let released = false;
        const app = new App();
        app.get('/sse', () =>
        {
            const body = new ReadableStream<Uint8Array>({
                async pull(controller)
                {
                    await pause(10);
                    controller.enqueue(new TextEncoder().encode('tick\n'));
                }
            });
            onRequestCleanup(() => void (released = true));
            return new Response(body);
        });

        const response = await app.handle(new Request('http://local/sse'));
        expect(released).toBe(false);

        const reader = response.body!.getReader();
        await reader.read();        // pull one chunk
        expect(released).toBe(false); // still streaming
        await reader.cancel();      // client goes away
        expect(released).toBe(true);  // teardown fires on cancel
    });

    it('buffered responses still run cleanup before handle() resolves', async () =>
    {
        // The buffered fast path is unchanged: PayloadResponse is not instanceof Response,
        // so its cleanups run synchronously in the settle path, not deferred.
        let released = false;
        const app = new App();
        app.get('/buffered', () =>
        {
            onRequestCleanup(() => void (released = true));
            return json({ ok: true });
        });
        await app.handle(new Request('http://local/buffered'));
        expect(released).toBe(true);
    });
});
