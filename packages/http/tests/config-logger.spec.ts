// @vitest-environment node
//
// The app-model utilities: typed config that fails loudly and ALL AT ONCE at boot, the
// structured logger contract, the request observer seam, and the plugin story (a plugin is
// function application - typed end to end, no registration graph).

import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { createLogger, type LogRecord } from '@azerothjs/logger';
import { loadConfig, str, num, flag, oneOf } from '../src/config.ts';
import { logRequests } from '../src/logger.ts';
import { App } from '../src/app.ts';
import { json, noContent } from '../src/respond.ts';

describe('loadConfig: typed, loud, all-at-once', () =>
{
    it('parses a typed config object from an env record', () =>
    {
        const config = loadConfig({
            port: num('PORT', { default: 3000 }),
            databaseUrl: str('DATABASE_URL'),
            debug: flag('DEBUG', { default: false }),
            mode: oneOf('MODE', ['dev', 'prod'] as const, { default: 'prod' })
        }, { DATABASE_URL: 'postgres://db', PORT: '8080', DEBUG: 'yes', MODE: 'dev' });

        expectTypeOf(config.port).toEqualTypeOf<number>();
        expectTypeOf(config.debug).toEqualTypeOf<boolean>();
        expectTypeOf(config.mode).toEqualTypeOf<'dev' | 'prod'>();
        expect(config).toMatchObject({ port: 8080, databaseUrl: 'postgres://db', debug: true, mode: 'dev' });
    });

    it('defaults apply when a variable is absent or empty', () =>
    {
        const config = loadConfig({ port: num('PORT', { default: 3000 }) }, { PORT: '' });
        expect(config.port).toBe(3000);
    });

    it('reports EVERY problem in one boot error', () =>
    {
        const attempt = (): unknown => loadConfig({
            url: str('DATABASE_URL'),
            port: num('PORT'),
            mode: oneOf('MODE', ['dev', 'prod'] as const)
        }, { PORT: 'not-a-number', MODE: 'staging' });

        expect(attempt).toThrow(/3 problems/);
        expect(attempt).toThrow(/DATABASE_URL is required/);
        expect(attempt).toThrow(/PORT: expected a number/);
        expect(attempt).toThrow(/MODE: expected one of dev \| prod/);
    });

    it('flag rejects ambiguous truthiness loudly', () =>
    {
        expect(() => loadConfig({ x: flag('X') }, { X: 'maybe' })).toThrow(/true\/false/);
        expect(loadConfig({ x: flag('X') }, { X: '0' }).x).toBe(false);
    });

    it('secrets stay usable in code but redact from the object serializations', () =>
    {
        const config = loadConfig({
            apiKey: str('API_KEY', { secret: true }),
            host: str('HOST')
        }, { API_KEY: 'sk-super-secret', HOST: 'example.com' });

        expect(config.apiKey).toBe('sk-super-secret'); // code reads the real value
        const logged = JSON.stringify(config);
        expect(logged).not.toContain('sk-super-secret');
        expect(logged).toContain('[redacted]');
        expect(logged).toContain('example.com');
    });

    it('a secret parse failure names the variable without echoing the raw value', () =>
    {
        const attempt = (): unknown => loadConfig({
            key: num('PAYMENT_API_KEY', { secret: true })
        }, { PAYMENT_API_KEY: 'sk_live_51H8Zq' });

        expect(attempt).toThrow(/PAYMENT_API_KEY is invalid/);
        expect(attempt).not.toThrow(/sk_live_51H8Zq/);
    });

    it('flag and oneOf accept secret and redact like str/num', () =>
    {
        const config = loadConfig({
            beta: flag('BETA', { secret: true }),
            tier: oneOf('TIER', ['gold', 'free'] as const, { secret: true })
        }, { BETA: 'yes', TIER: 'gold' });

        expect(config.beta).toBe(true);
        const logged = JSON.stringify(config);
        expect(logged).not.toContain('gold');
        expect(logged).toContain('[redacted]');
    });

    it('redacts secrets on the console.log / util.inspect path, not only JSON', async () =>
    {
        // console.log(config) and util.inspect(config) IGNORE toJSON and enumerate the object,
        // so a JSON-only redaction leaks the plaintext. The inspect hook must also redact.
        const { inspect } = await import('node:util');
        const config = loadConfig({
            dbUrl: str('DATABASE_URL', { secret: true }),
            host: str('HOST')
        }, { DATABASE_URL: 'postgres://user:SUPERSECRETpw@host/db', HOST: 'example.com' });

        const shown = inspect(config);
        expect(shown).not.toContain('SUPERSECRETpw');
        expect(shown).toContain('[redacted]');
        expect(shown).toContain('example.com'); // non-secret still visible
        expect(config.dbUrl).toBe('postgres://user:SUPERSECRETpw@host/db'); // code still reads real value
    });
});

describe('logRequests: the request observer over THE logger', () =>
{
    // ONE logger concept in the framework: @azerothjs/logger's createLogger. Its record
    // contract has its own suite in that package; here it composes with the observer.
    function capture(): { records: LogRecord[]; sink: (record: LogRecord) => void }
    {
        const records: LogRecord[] = [];
        return { records, sink: (record) => void records.push(record) };
    }

    it('logRequests observes completions with method/path/status/duration', async () =>
    {
        const { records, sink } = capture();
        const app = new App({ observe: logRequests(createLogger({ sink })) });
        app.get('/ok', () => noContent());
        app.get('/boom', () =>
        {
            throw new Error('x');
        });

        await app.handle(new Request('http://local/ok'));
        await app.handle(new Request('http://local/boom'));

        expect(records).toHaveLength(2);
        expect(records[0]?.level).toBe('info');
        expect(records[0]?.fields).toMatchObject({ method: 'GET', path: '/ok', status: 204 });
        expect(typeof records[0]?.fields.durationMs).toBe('number');
        expect(records[1]?.level).toBe('error'); // the 500 logs at error level
        expect(records[1]?.fields).toMatchObject({ path: '/boom', status: 500 });
    });

    it('a throwing observer cannot break the response', async () =>
    {
        const app = new App({ observe: { onComplete: () =>
        {
            throw new Error('observer exploded');
        } } });
        app.get('/x', () => noContent());
        expect((await app.handle(new Request('http://local/x'))).status).toBe(204);
    });

    it('logRequests still emits a record when the request URL cannot be parsed', () =>
    {
        const { records, sink } = capture();
        const observer = logRequests(createLogger({ sink }));
        // The adapter composes the URL from the client's Host header; 'a b' makes new URL
        // throw, and App.handle swallows observer throws - a request served with no audit
        // line would be silent log evasion.
        const request = { method: 'GET', url: 'http://a b/secret-admin-probe' } as unknown as Request;
        observer.onComplete(request, new Response(null, { status: 200 }), 1);

        expect(records).toHaveLength(1);
        expect(records[0]?.fields).toMatchObject({ path: '/secret-admin-probe', status: 200 });
    });

    it('a record carrying control characters cannot forge a second log line', () =>
    {
        // The guarantee is in the RECORD, not in any one sink: a raw CR or LF in a field or the
        // message would end the line and let an attacker append a forged entry.
        const lines: string[] = [];
        const logger = createLogger({ sink: (record) => lines.push(JSON.stringify(record)) });

        logger.info('login rejected', { email: 'a@b\nINFO admin login granted user=root' });
        logger.info('multi\nline message');

        expect(lines).toHaveLength(2);
        for (const line of lines)
        {
            expect(line.split('\n')).toHaveLength(1);
        }
    });
});

describe('the plugin story: function application over the typed builder', () =>
{
    it('a plugin bundles middleware and routes, and its context additions flow onward', async () =>
    {
        // A plugin is a plain exported function - what it does is what its body says.
        const withUser = <Ctx extends object>(app: App<Ctx>): App<Ctx & { user: string }> =>
            app.use(() => ({ user: 'jaina' }));

        const withHealth = <Ctx extends object>(app: App<Ctx>): App<Ctx> =>
        {
            app.get('/health', () => noContent());
            return app;
        };

        const app = new App().register(withUser).register(withHealth);
        app.get('/me', (context) =>
        {
            expectTypeOf(context.user).toEqualTypeOf<string>();
            return json({ user: context.user });
        });

        expect((await app.handle(new Request('http://local/health'))).status).toBe(204);
        expect(await (await app.handle(new Request('http://local/me'))).json()).toEqual({ user: 'jaina' });
    });

    it('plugin composition is ordinary code - conditionals included', async () =>
    {
        const metrics = vi.fn();
        const withMetrics = (enabled: boolean) =>
            <Ctx extends object>(app: App<Ctx>): App<Ctx> =>
                (enabled ? app.use(() => void metrics()) : app);

        const app = new App().register(withMetrics(true));
        app.get('/x', () => noContent());
        await app.handle(new Request('http://local/x'));
        expect(metrics).toHaveBeenCalledTimes(1);
    });
});
