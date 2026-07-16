// @vitest-environment node
//
// Production hardening on the Node edge: the socket timeouts serve() surfaces, the slowloris
// close they buy, and the signal-driven graceful drain.

import { describe, it, expect, vi } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { App, serve, text, handleShutdownSignals } from '@azerothjs/http';

interface TimedServer { headersTimeout: number; requestTimeout: number; keepAliveTimeout: number; maxRequestsPerSocket: number }

describe('socket timeouts', () =>
{
    it('applies safe defaults when unspecified', async () =>
    {
        const served = await serve(new App());
        try
        {
            const server = served.server as unknown as TimedServer;
            expect(server.headersTimeout).toBe(60_000);
            expect(server.requestTimeout).toBe(300_000);
            expect(server.keepAliveTimeout).toBe(5_000);
            expect(server.maxRequestsPerSocket).toBe(0);
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 200 });
        }
    });

    it('honors every override', async () =>
    {
        const served = await serve(new App(), {
            timeouts: { headersMs: 111, requestMs: 2222, keepAliveMs: 333, maxRequestsPerSocket: 44 }
        });
        try
        {
            const server = served.server as unknown as TimedServer;
            expect(server.headersTimeout).toBe(111);
            expect(server.requestTimeout).toBe(2222);
            expect(server.keepAliveTimeout).toBe(333);
            expect(server.maxRequestsPerSocket).toBe(44);
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 200 });
        }
    });

    it('cuts a slowloris that never finishes its headers', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const served = await serve(app, { timeouts: { headersMs: 150, checkIntervalMs: 50 } });
        try
        {
            const socket = connect(served.port, '127.0.0.1');
            await once(socket, 'connect');
            // The server cuts the connection when the headers never complete: it either sends a
            // 408 or simply closes. Resolve on whichever proves the timeout fired.
            const cut = new Promise<void>((resolve) =>
            {
                socket.on('data', () => resolve());
                socket.on('close', () => resolve());
            });
            socket.write('GET / HTTP/1.1\r\nHost: local\r\n'); // deliberately never sends the terminating blank line
            await Promise.race([
                cut,
                new Promise<void>((_, reject) => setTimeout(() => reject(new Error('headersTimeout did not cut the slow connection')), 4000))
            ]);
            socket.destroy();
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 200 });
        }
    });
});

describe('handleShutdownSignals', () =>
{
    it('drains and exits 0 on the configured signal', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const served = await serve(app);

        let exitCode: number | undefined;
        const dispose = handleShutdownSignals(served, { signals: ['SIGTERM'], gracePeriodMs: 200, exit: (code) =>
        {
            exitCode = code;
        } });
        // Invoke the registered handler directly rather than raising a real signal, so the test
        // runner's own signal handling is never disturbed.
        const listeners = process.listeners('SIGTERM');
        (listeners[listeners.length - 1] as () => void)();

        await vi.waitFor(() => expect(exitCode).toBe(0));
        expect(served.server.listening).toBe(false); // the drain closed the server
        dispose();
    });

    it('the disposer removes the listener it added', async () =>
    {
        const served = await serve(new App());
        try
        {
            const before = process.listenerCount('SIGTERM');
            const dispose = handleShutdownSignals(served, { signals: ['SIGTERM'], exit: () => undefined });
            expect(process.listenerCount('SIGTERM')).toBe(before + 1);
            dispose();
            expect(process.listenerCount('SIGTERM')).toBe(before);
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 200 });
        }
    });
});
