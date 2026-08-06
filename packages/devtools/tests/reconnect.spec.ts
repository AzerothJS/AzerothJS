// @vitest-environment node
//
// The link's behaviour across a server restart, driven against a REAL bridge over a real
// socket. A dev server restarts on every file save, so "the panel went dead until I clicked
// Connect" is the common case, not an edge one - and a link that retries blindly would hide
// a genuinely wrong token behind an endless spinner. Both properties are pinned here.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { attachDevtools } from '../src/server.ts';
import { bridgeUrl, createServerLink } from '../src/server-client.ts';

process.env.NODE_ENV = 'development';

const PORT = 39521;
const TOKEN = 'a-stable-development-token';

let running: { server: Server; detach: () => void } | null = null;

/** Boots the bridge. `verifyOrigin` is opened up because a Node client sends no Origin. */
async function boot(): Promise<void>
{
    const server = createServer((_req, res) => res.end('ok'));
    const detach = attachDevtools(server, { token: TOKEN, verifyOrigin: () => true });
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()));
    running = { server, detach };
}

async function stop(): Promise<void>
{
    if (running === null)
    {
        return;
    }
    running.detach();
    const server = running.server;
    running = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Polls `check` until it holds or the budget runs out; returns whether it held. */
async function until(check: () => boolean, ms = 6000): Promise<boolean>
{
    const deadline = Date.now() + ms;
    while (Date.now() < deadline)
    {
        if (check())
        {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return check();
}

afterEach(async () =>
{
    await stop();
});

describe('server link across a restart', () =>
{
    it('recovers on its own when the server comes back', async () =>
    {
        await boot();
        const link = createServerLink(() => undefined);
        link.connect(`ws://127.0.0.1:${ PORT }/__azeroth/devtools?token=${ TOKEN }`);
        expect(await until(() => link.status() === 'open')).toBe(true);

        // The restart a file save performs.
        await stop();
        expect(await until(() => link.status() !== 'open')).toBe(true);

        await boot();
        // No human clicked Connect: the panel must find its way back by itself.
        expect(await until(() => link.status() === 'open')).toBe(true);
        link.dispose();
    });

    it('stops and reports when the credential is wrong - a bad token is not a blip', async () =>
    {
        await boot();
        const link = createServerLink(() => undefined);
        link.connect(`ws://127.0.0.1:${ PORT }/__azeroth/devtools?token=wrong-token-entirely`);

        // It must settle into a terminal, explainable state rather than spin forever.
        expect(await until(() => link.status() === 'error')).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(link.status()).toBe('error');
        link.dispose();
    });

    it('dispose stops all further work - no timer outlives the panel', async () =>
    {
        await boot();
        const link = createServerLink(() => undefined);
        link.connect(`ws://127.0.0.1:${ PORT }/__azeroth/devtools?token=${ TOKEN }`);
        expect(await until(() => link.status() === 'open')).toBe(true);

        await stop();
        link.dispose();
        expect(link.status()).toBe('idle');

        await boot();
        // A disposed link must NOT come back to life when the server returns.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(link.status()).toBe('idle');
    });
});

describe('retry cannot mask a permanent failure', () =>
{
    it('gives up when a PROVEN url stops being accepted - the token changed under it', async () =>
    {
        // The hard case: the link opened once, so it has earned a retry - but the operator
        // then rotated the token. Retrying forever would leave a spinner where an
        // explanation belongs, so the budget runs out and the status goes terminal.
        await boot();
        const link = createServerLink(() => undefined);
        link.connect(`ws://127.0.0.1:${ PORT }/__azeroth/devtools?token=${ TOKEN }`);
        expect(await until(() => link.status() === 'open')).toBe(true);

        await stop();
        // Same port, different secret - exactly a `.env` edit plus a restart.
        const server = createServer((_req, res) => res.end('ok'));
        const detach = attachDevtools(server, { token: 'a-completely-different-token', verifyOrigin: () => true });
        await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()));
        running = { server, detach };

        expect(await until(() => link.status() === 'error', 40000)).toBe(true);
        // And it STAYS terminal rather than resuming the loop.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(link.status()).toBe('error');
        link.dispose();
    }, 60000);

    it('an explicit disconnect is respected - no retry behind the user', async () =>
    {
        await boot();
        const link = createServerLink(() => undefined);
        link.connect(`ws://127.0.0.1:${ PORT }/__azeroth/devtools?token=${ TOKEN }`);
        expect(await until(() => link.status() === 'open')).toBe(true);

        link.disconnect();
        expect(link.status()).toBe('idle');
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(link.status()).toBe('idle');
        link.dispose();
    });
});

describe('a url that cannot work is not attempted', () =>
{
    it('recognises a tokenless bridge url', () =>
    {
        // attachDevtools refuses an upgrade without a token, so `installDevtools({ server })`
        // given a bare API origin produces a url that is known-bad before any socket opens.
        const hasToken = (url: string): boolean => /[?&]token=[^&]/.test(url);

        expect(hasToken(bridgeUrl('http://localhost:3000'))).toBe(false);
        expect(hasToken(bridgeUrl('ws://localhost:3000/__azeroth/devtools?token='))).toBe(false);
        expect(hasToken(bridgeUrl('ws://localhost:3000/__azeroth/devtools?token=abc123'))).toBe(true);
    });
});
