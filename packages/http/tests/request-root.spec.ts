// @vitest-environment node
//
// The request root: store isolation that SURVIVES await (the thing reactivity's synchronous
// runInStoreScope cannot give an async handler), and a cleanup registry that always runs.
// The isolation tests interleave two real requests on purpose - the failure mode being
// guarded is one request reading the other's store after an await.

import { describe, it, expect, vi } from 'vitest';
import { createSignal, getStoreScope, runInStoreScope, createStore } from 'azerothjs';
import { App } from '../src/app.ts';
import { BadRequestError } from '../src/errors.ts';
import { json } from '../src/respond.ts';
import { onWorkUnitCleanup } from '../src/request-root.ts';

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
            expect(() => onWorkUnitCleanup(() => undefined)).toThrow(/outside a work unit/);
            return json({ ok: true });
        });
        expect((await app.handle(new Request('http://local/bare'))).status).toBe(200);
    });
});

describe('onWorkUnitCleanup: teardown always runs', () =>
{
    it('runs after a successful response, LIFO', async () =>
    {
        const order: string[] = [];
        const app = new App();
        app.get('/ok', () =>
        {
            onWorkUnitCleanup(() => void order.push('first-registered'));
            onWorkUnitCleanup(() => void order.push('second-registered'));
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
            onWorkUnitCleanup(cleaned);
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
            onWorkUnitCleanup(async () =>
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
            onWorkUnitCleanup(survivor); // registered first, runs last (LIFO)
            onWorkUnitCleanup(() =>
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
        expect(() => onWorkUnitCleanup(() => undefined)).toThrow(/outside a work unit/);
    });
});

describe('teardown and error serialization run inside the request scope', () =>
{
    it('cleanups resolve the request\'s OWN store, two concurrent requests apart', async () =>
    {
        const useBag = createStore(() => ({ bag: true }));
        const seen: Array<{ during: object; cleanup: object | null }> = [];
        const app = new App();
        app.get('/scoped/:label', async () =>
        {
            const record: { during: object; cleanup: object | null } = { during: useBag(), cleanup: null };
            seen.push(record);
            onWorkUnitCleanup(() =>
            {
                record.cleanup = useBag();
            });
            await pause(20); // the other request runs here, in ITS scope
            return json({ ok: true });
        });

        await Promise.all([
            app.handle(new Request('http://local/scoped/a')),
            (async (): Promise<Response> =>
            {
                await pause(10);
                return app.handle(new Request('http://local/scoped/b'));
            })()
        ]);

        // A cleanup running outside the request's async context would resolve the
        // process-wide default scope: one shared instance for every request's teardown.
        expect(seen).toHaveLength(2);
        expect(seen[0]?.cleanup).toBe(seen[0]?.during);
        expect(seen[1]?.cleanup).toBe(seen[1]?.during);
        expect(seen[0]?.during).not.toBe(seen[1]?.during);
    });

    it('a serializer shaping a thrown error\'s body sees the request\'s own store', async () =>
    {
        const useBag = createStore(() => ({ bag: true }));
        let during: object | null = null;
        let inSerializer: object | null = null;
        const app = new App({
            serializeError: () =>
            {
                inSerializer = useBag();
                return undefined;
            }
        });
        app.get('/boom', () =>
        {
            during = useBag();
            throw new BadRequestError('bad');
        });

        const response = await app.handle(new Request('http://local/boom'));
        expect(response.status).toBe(400);
        expect(inSerializer).not.toBeNull();
        expect(inSerializer).toBe(during);
    });
});

describe('onWorkUnitCleanup: streaming responses defer teardown to stream-end', () =>
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
            onWorkUnitCleanup(() => void (released = true));
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
            onWorkUnitCleanup(() => void (released = true));
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

    it('teardown registered AFTER the producer\'s first await still runs at stream end', async () =>
    {
        let released = false;
        const app = new App();
        app.get('/live', () =>
        {
            const encoder = new TextEncoder();
            // The producer awaits real I/O BEFORE acquiring its resource: the registration
            // lands after the handler returned and the root's settle continuation already ran.
            const body = new ReadableStream<Uint8Array>({
                async start(controller)
                {
                    await pause(15);
                    onWorkUnitCleanup(() => void (released = true));
                    controller.enqueue(encoder.encode('chunk'));
                    controller.close();
                }
            });
            return new Response(body, { headers: { 'content-type': 'text/plain' } });
        });

        const response = await app.handle(new Request('http://local/live'));
        expect(await response.text()).toBe('chunk');
        expect(released).toBe(true);
    });

    it('buffered responses still run cleanup before handle() resolves', async () =>
    {
        // The buffered fast path is unchanged: a PayloadResponse is excluded from
        // isStreamingResponse, so its cleanups run synchronously in the settle path, not deferred.
        let released = false;
        const app = new App();
        app.get('/buffered', () =>
        {
            onWorkUnitCleanup(() => void (released = true));
            return json({ ok: true });
        });
        await app.handle(new Request('http://local/buffered'));
        expect(released).toBe(true);
    });
});

describe('teardown registered from inside a cleanup', () =>
{
    it('runs the nested teardown rather than dropping it on a list nothing reads', async () =>
    {
        const order: string[] = [];
        const app = new App({});
        app.get('/', () =>
        {
            onWorkUnitCleanup(() =>
            {
                order.push('outer');
                // A release that queues its own follow-up (returning a pooled connection
                // after closing the transaction that borrowed it).
                onWorkUnitCleanup(() =>
                {
                    order.push('nested');
                });
            });
            return json({ ok: true });
        });

        await app.handle(new Request('http://x/'));
        expect(order).toEqual(['outer', 'nested']);
    });

    it('reports and stops when a cleanup re-registers itself forever', async () =>
    {
        const seen: unknown[] = [];
        const app = new App({ onError: (error) => seen.push(error) });
        let runs = 0;
        app.get('/', () =>
        {
            const loop = (): void =>
            {
                runs += 1;
                onWorkUnitCleanup(loop);
            };
            onWorkUnitCleanup(loop);
            return json({ ok: true });
        });

        const response = await app.handle(new Request('http://x/'));
        expect(response.status).toBe(200);
        // Bounded, not spinning, and the abandonment is reported rather than silent.
        expect(runs).toBeLessThan(20);
        expect(seen.some((e) => /kept registering new teardown/.test((e as Error).message))).toBe(true);
    });

    it('a cleanup and its error sink both throwing still settles the request', async () =>
    {
        const app = new App({
            onError: () =>
            {
                throw new Error('observer exploded');
            }
        });
        app.get('/', () =>
        {
            onWorkUnitCleanup(() =>
            {
                throw new Error('release failed');
            });
            return json({ ok: true });
        });

        const response = await app.handle(new Request('http://x/'));
        // The computed response survives teardown's collapse.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });
});

describe('a streaming body the kernel cannot monitor', () =>
{
    it('settles the request instead of leaking it when the handler holds its own reader', async () =>
    {
        const order: string[] = [];
        const app = new App({});
        app.get('/', () =>
        {
            const stream = new ReadableStream<Uint8Array>({
                start(controller)
                {
                    controller.enqueue(new TextEncoder().encode('x'));
                    controller.close();
                }
            });
            onWorkUnitCleanup(() =>
            {
                order.push('cleanup');
            });
            const response = new Response(stream);
            // The handler took the reader itself: the body is locked, so the kernel's
            // monitor cannot wrap it.
            response.body?.getReader();
            return response;
        });

        const response = await app.handle(new Request('http://x/'));
        expect(response.status).toBe(200);
        expect(order).toEqual(['cleanup']);
    });
});

describe('teardown registered after the request already settled', () =>
{
    it('runs when the client aborted before the producer got its connection', async () =>
    {
        let released = false;
        const app = new App({});
        app.get('/live', () =>
        {
            const body = new ReadableStream<Uint8Array>({
                async start(controller)
                {
                    // The producer borrows a pooled connection AFTER the handler returned.
                    await pause(15);
                    onWorkUnitCleanup(() =>
                    {
                        released = true;
                    });
                    controller.enqueue(new TextEncoder().encode('chunk'));
                    controller.close();
                }
            });
            return new Response(body, { headers: { 'content-type': 'text/plain' } });
        });

        const abort = new AbortController();
        const pending = app.handle(new Request('http://x/live', { signal: abort.signal }));
        abort.abort();
        const response = await pending;
        await response.text();
        await pause(60);

        expect(released).toBe(true);
    });

    it('runs when the body could not be monitored', async () =>
    {
        let released = false;
        const app = new App({});
        app.get('/locked', () =>
        {
            const stream = new ReadableStream<Uint8Array>({
                async start(controller)
                {
                    await pause(10);
                    onWorkUnitCleanup(() =>
                    {
                        released = true;
                    });
                    controller.enqueue(new TextEncoder().encode('x'));
                    controller.close();
                }
            });
            const response = new Response(stream);
            response.body?.getReader();
            return response;
        });

        await app.handle(new Request('http://x/locked'));
        await pause(60);

        expect(released).toBe(true);
    });
});
