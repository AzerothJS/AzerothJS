// Browser lane of the action client (happy-dom): the CSRF double-submit mirror. The page's
// own JS can read the token cookie - that readability IS the defense - so the client echoes
// it into the header automatically on every action call, and only there.
import { afterEach, describe, expect, it } from 'vitest';

import { object, string } from '@azerothjs/schema';
import { feature, manifestOf } from '../../src/api/feature.ts';
import { createClient } from '../../src/api/client.ts';

const posts = feature('/posts', (routes) => ({
    create: routes.action('/create', { input: object({ title: string() }) }, (context) => ({ title: context.input.title })),
    list: routes.get('/', {}, () => [])
}));

function clientSeeing(seen: Request[], csrf?: false | { cookie?: string; header?: string }): ReturnType<typeof createClient<{ posts: typeof posts }>>
{
    return createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
        baseUrl: '/api',
        ...(csrf === undefined ? {} : { csrf }),
        fetch: (request) =>
        {
            seen.push(request);
            return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
        }
    });
}

afterEach(() =>
{
    document.cookie = 'azcsrf=; Max-Age=0';
    document.cookie = 'renamed=; Max-Age=0';
});

describe('the action client in a browser', () =>
{
    it('mirrors the token cookie into x-azeroth-csrf on action calls', async () =>
    {
        document.cookie = 'azcsrf=tok-abcdef1234567890';
        const seen: Request[] = [];
        await clientSeeing(seen).posts.create({ title: 'x' });
        expect(seen[0]?.headers.get('x-azeroth-csrf')).toBe('tok-abcdef1234567890');
    });

    it('plain JSON calls carry no CSRF header', async () =>
    {
        document.cookie = 'azcsrf=tok-abcdef1234567890';
        const seen: Request[] = [];
        await clientSeeing(seen).posts.list();
        expect(seen[0]?.headers.get('x-azeroth-csrf')).toBeNull();
    });

    it('csrf: false disables the mirror; renamed cookie/header options are honored', async () =>
    {
        document.cookie = 'azcsrf=tok-abcdef1234567890';
        const disabled: Request[] = [];
        await clientSeeing(disabled, false).posts.create({ title: 'x' });
        expect(disabled[0]?.headers.get('x-azeroth-csrf')).toBeNull();

        document.cookie = 'renamed=tok-fedcba0987654321';
        const renamed: Request[] = [];
        await clientSeeing(renamed, { cookie: 'renamed', header: 'x-my-csrf' }).posts.create({ title: 'x' });
        expect(renamed[0]?.headers.get('x-my-csrf')).toBe('tok-fedcba0987654321');
        expect(renamed[0]?.headers.get('x-azeroth-csrf')).toBeNull();
    });

    it('no readable cookie means no header - the server guard answers loudly instead', async () =>
    {
        // A configured cookie name that was never minted: the jar has nothing to mirror.
        const seen: Request[] = [];
        await clientSeeing(seen, { cookie: 'never-minted' }).posts.create({ title: 'x' });
        expect(seen[0]?.headers.get('x-azeroth-csrf')).toBeNull();
    });
});
