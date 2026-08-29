// @vitest-environment node
//
// The redirect boundary. A guard/loader redirect is an AUTOMATIC navigation whose target
// the app derives, so an off-origin one is the open-redirect shape - and the check must sit
// at the CONSUMPTION boundaries, not in `redirect()`, because a guard may return a bare
// NavigateTarget and never call the sentinel factory at all. That bare-verdict path is the
// arm that would have caught a constructor-time check shipping as a fix that fixes nothing.
import { describe, expect, it } from 'vitest';
import { h, matchAndLoad, unsafeUrl } from 'azerothjs';
import { redirect } from 'azerothjs';
import type { Route } from 'azerothjs';
import { isExternalUrl, refreshTarget } from '../../src/semantics.ts';

const page = (): HTMLElement => h('div', {}, 'page');

function routesWith(guard: NonNullable<Route['guard']>): Route[]
{
    return [{ path: '/p', component: page, guard }];
}

async function outcome(guard: NonNullable<Route['guard']>): Promise<Record<string, unknown>>
{
    return await matchAndLoad(routesWith(guard), '/p') as unknown as Record<string, unknown>;
}

describe('an off-origin redirect target is refused at the boundary', () =>
{
    it('refuses a thrown redirect sentinel', async () =>
    {
        const result = await outcome(() =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a redirect sentinel is a branded value, not an Error: throwing it IS the documented API
            throw redirect('https://evil.example/');
        });
        expect(result.refusedRedirect).toBe(true);
        expect(result.target).toBe('https://evil.example/');
        expect(result.redirect).toBeUndefined();
    });

    it('refuses a BARE NavigateTarget verdict - the producer that never calls redirect()', async () =>
    {
        const result = await outcome(() => 'https://evil.example/');
        expect(result.refusedRedirect).toBe(true);
        expect(result.redirect).toBeUndefined();
    });

    it('refuses the OBJECT form, whose pathname is an unconstrained string', async () =>
    {
        const result = await outcome(() => redirect({ pathname: '//evil.example' }));
        expect(result.refusedRedirect).toBe(true);
        expect(result.target).toBe('//evil.example');
    });

    it('refuses the spellings a browser normalizes into a scheme', async () =>
    {
        for (const target of ['java\tscript:alert(1)', ' https://evil.example/', 'HTTPS://evil.example/'])
        {
            const result = await outcome(() => redirect(target));
            expect(result.refusedRedirect).toBe(true);
        }
    });
});

describe('what the boundary must NOT refuse', () =>
{
    it('passes an ordinary app path, and the object form with query and hash', async () =>
    {
        const plain = await outcome(() => redirect('/login'));
        expect(plain.redirect).toBe('/login');

        const rich = await outcome(() => redirect({ pathname: '/login', query: { next: '/a' }, hash: 'top' }));
        expect(rich.refusedRedirect).toBeUndefined();
        expect((rich.redirect as { pathname: string }).pathname).toBe('/login');
    });

    it('passes an author-vetted target and UNWRAPS it, so no marker object reaches the wire', async () =>
    {
        const result = await outcome(() => redirect(unsafeUrl('https://payments.example/checkout')));
        expect(result.refusedRedirect).toBeUndefined();
        expect(result.redirect).toBe('https://payments.example/checkout');
        expect(typeof result.redirect).toBe('string');
    });

    it('leaves a guard that simply allows or vetoes alone', async () =>
    {
        // An authorized route with no loaders resolves to null - no handoff to embed.
        expect(await matchAndLoad(routesWith(() => true), '/p')).toBeNull();
        expect((await outcome(() => false)).blocked).toBe(true);
    });
});

describe('the refresh-directive parse (HTML shared declarative refresh steps)', () =>
{
    it('finds the target in every legal spelling, including the four with no url= token', () =>
    {
        for (const content of [
            '0;url=https://evil.example/',
            '0;https://evil.example/',
            '0,https://evil.example/',
            '0 https://evil.example/',
            '0;URL=https://evil.example/',
            "0;url='https://evil.example/'"
        ])
        {
            const target = refreshTarget(content);
            expect(target).not.toBeNull();
            expect(isExternalUrl(target!)).toBe(true);
        }
    });

    it('reports no target for a self-refresh or an invalid directive, and keeps an internal path internal', () =>
    {
        expect(refreshTarget('5')).toBeNull();
        expect(refreshTarget('garbage')).toBeNull();
        expect(isExternalUrl(refreshTarget('0;url=/local')!)).toBe(false);
    });
});
