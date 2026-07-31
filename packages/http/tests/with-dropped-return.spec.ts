// @vitest-environment node
//
// `with` RETURNS the app carrying the middleware; it does not mutate the receiver. Dropping that
// return is therefore a silent no-op, and the failure it produces is an unguarded route rather
// than an error - which is why `use` was NOT collapsed into `with` during the API consolidation.
// This test exists so the trade stays visible: if someone later makes `with` mutate, it breaks.
import { describe, expect, it } from 'vitest';
import { App, json } from '@azerothjs/http';

describe('with returns a fork - the trade that keeps `use` alive', () =>
{
    it('applies the middleware to routes registered THROUGH the returned app', async () =>
    {
        let ran = false;
        const app = new App();
        const guarded = app.with(() =>
        {
            ran = true;
            return { user: 'ada' };
        });
        guarded.get('/x', (context) => json({ user: context.user }));

        const response = await app.handle(new Request('http://local/x'));
        expect(ran).toBe(true);
        expect(await response.json()).toEqual({ user: 'ada' });
    });

    it('does NOT apply when the returned app is discarded', async () =>
    {
        let ran = false;
        const app = new App();
        // The footgun, pinned: this line compiles, runs, and does nothing.
        app.with(() =>
        {
            ran = true;
            return { user: 'ada' };
        });
        app.get('/x', () => json({ ok: true }));

        const response = await app.handle(new Request('http://local/x'));
        expect(response.status).toBe(200);
        expect(ran).toBe(false);
    });

    it('`use` cannot fail that way - it mutates the receiver', async () =>
    {
        let ran = false;
        const app = new App();
        app.use(() =>
        {
            ran = true;
            return { user: 'ada' };
        });
        app.get('/x', () => json({ ok: true }));

        await app.handle(new Request('http://local/x'));
        expect(ran).toBe(true);
    });
});
