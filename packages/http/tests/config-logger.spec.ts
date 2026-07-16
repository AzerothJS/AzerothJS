// @vitest-environment node
//
// The app-model utilities: typed config that fails loudly and ALL AT ONCE at boot, the
// structured logger contract, the request observer seam, and the plugin story (a plugin is
// function application - typed end to end, no registration graph).

import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { loadConfig, str, num, flag, oneOf } from '../src/config.ts';
import { createLogger, logRequests, type LogRecord } from '../src/logger.ts';
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
});

describe('createLogger: the record contract', () =>
{
    function capture(): { records: LogRecord[]; sink: (record: LogRecord) => void }
    {
        const records: LogRecord[] = [];
        return { records, sink: (record) => void records.push(record) };
    }

    it('emits structured records with merged child fields', () =>
    {
        const { records, sink } = capture();
        const logger = createLogger({ sink, level: 'debug', fields: { service: 'api' } });
        logger.child({ requestId: 'r1' }).info('handled', { status: 200 });

        expect(records).toHaveLength(1);
        expect(records[0]?.level).toBe('info');
        expect(records[0]?.message).toBe('handled');
        expect(records[0]?.fields).toEqual({ service: 'api', requestId: 'r1', status: 200 });
    });

    it('drops records below the threshold before any work', () =>
    {
        const { records, sink } = capture();
        const logger = createLogger({ sink, level: 'warn' });
        logger.debug('noise');
        logger.info('noise');
        logger.error('signal');
        expect(records.map((record) => record.level)).toEqual(['error']);
    });

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

        const app = new App().plugin(withUser).plugin(withHealth);
        app.get('/me', (_request, ctx) =>
        {
            expectTypeOf(ctx.user).toEqualTypeOf<string>();
            return json({ user: ctx.user });
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

        const app = new App().plugin(withMetrics(true));
        app.get('/x', () => noContent());
        await app.handle(new Request('http://local/x'));
        expect(metrics).toHaveBeenCalledTimes(1);
    });
});
