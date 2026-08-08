// @vitest-environment node
//
// Server actions: a POST-only, param-free route kind whose typed client surface is a
// directly-callable function - `client.posts.create(input)` - with input validated like any
// JSON body, output validated against the contract, guards (CSRF included) composing through
// the ordinary chain, and field errors landing on forms through applyFieldErrors.
import { describe, expect, expectTypeOf, it } from 'vitest';

import { object, string, date } from '@azerothjs/schema';
import { App, csrfProtect, csrfToken, json } from '@azerothjs/http';
import { feature, manifestOf } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import { applyFieldErrors, createClient, ApiError } from '../../src/api/client.ts';

const TOKEN = csrfToken();
const pair = { cookie: `azcsrf=${ TOKEN }`, 'x-azeroth-csrf': TOKEN };

const postInput = object({ title: string({ nonempty: true }), tag: string({ format: 'email' }).optional() });
const postRecord = object({ id: string(), title: string(), at: date() });

const posts = feature('/posts', (routes) => ({
    create: routes.with(csrfProtect({ secure: false })).action('/create', { input: postInput, output: postRecord },
        (context) => ({ id: 'p1', title: context.input.title, at: new Date('2026-08-07T00:00:00Z') })),
    ping: routes.action('/ping', {}, () => ({ ok: true }))
}));

function build(): { app: App; client: ReturnType<typeof makeClient> }
{
    const app = new App();
    register(app, { posts });
    return { app, client: makeClient(app) };
}

function makeClient(app: App): ReturnType<typeof createClient<{ posts: typeof posts }>>
{
    return createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
        baseUrl: '/api',
        headers: pair,
        fetch: (request) => app.handle(request)
    });
}

describe('action declarations', () =>
{
    it('manifest carries kind action with the composed path', () =>
    {
        const manifest = manifestOf({ posts });
        expect(manifest['posts']?.['create']).toEqual({ method: 'POST', path: '/posts/create', kind: 'action' });
    });

    it('a parameterized action path throws at feature build', () =>
    {
        expect(() => feature('/x', (routes) => ({
            bad: routes.action('/item/:id', {}, () => ({}))
        }))).toThrow(/param/);
        expect(() => feature('/x', (routes) => ({
            bad: routes.action('/files/*rest', {}, () => ({}))
        }))).toThrow(/param/);
    });
});

describe('action round trip', () =>
{
    it('the client call is directly callable, validated, and Wire-typed', async () =>
    {
        const { client } = build();
        const created = await client.posts.create({ title: 'hello' });
        expect(created).toEqual({ id: 'p1', title: 'hello', at: '2026-08-07T00:00:00.000Z' });
        expectTypeOf(client.posts.create).parameter(0).toEqualTypeOf<{ title: string; tag?: string | undefined }>();
        expectTypeOf(created).toEqualTypeOf<{ id: string; title: string; at: string }>();
    });

    it('an input-less action takes no argument', async () =>
    {
        const { client } = build();
        const result = await client.posts.ping();
        expect(result).toEqual({ ok: true });
        expectTypeOf(client.posts.ping).parameters.toEqualTypeOf<[]>();
    });

    it('a GET to an action path is a 405', async () =>
    {
        const { app } = build();
        const response = await app.handle(new Request('http://local/api/posts/create'));
        expect(response.status).toBe(405);
    });

    it('validation failure surfaces as an ApiError carrying the field map', async () =>
    {
        const { client } = build();
        const failure = await client.posts.create({ title: '' }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(422);
        expect((failure as ApiError).fields['title']).toBeDefined();
    });

    it('the CSRF guard rejects BEFORE validation runs', async () =>
    {
        const { app } = build();
        const response = await app.handle(new Request('http://local/api/posts/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: '' })
        }));
        expect(response.status).toBe(403);
        const body = await response.json() as { error: { code: string } };
        expect(body.error.code).toBe('csrf');
    });
});

describe('applyFieldErrors', () =>
{
    it('lands each field message on the first dot segment and returns true', () =>
    {
        const seen: Array<[string, string | null]> = [];
        const form = { setError: (name: string, message: string | null): void => void seen.push([name, message]) };
        const error = new ApiError(422, 'validation-failed', 'Validation failed', {
            fields: { 'items.0.email': 'Enter a valid email', title: 'Required' }
        });
        expect(applyFieldErrors(form, error)).toBe(true);
        expect(seen).toContainEqual(['items', 'Enter a valid email']);
        expect(seen).toContainEqual(['title', 'Required']);
    });

    it('the first message per field wins', () =>
    {
        const seen = new Map<string, string | null>();
        const form = { setError: (name: string, message: string | null): void => void (seen.has(name) || seen.set(name, message)) };
        const error = new ApiError(422, 'validation-failed', 'Validation failed', {
            fields: { 'items.0.email': 'First', 'items.1.email': 'Second' }
        });
        applyFieldErrors(form, error);
        expect(seen.get('items')).toBe('First');
    });

    it('a non-ApiError (or one with no fields) returns false and touches nothing', () =>
    {
        const form = {
            setError: (): void =>
            {
                throw new Error('must not be called');
            }
        };
        expect(applyFieldErrors(form, new Error('network down'))).toBe(false);
        expect(applyFieldErrors(form, new ApiError(500, 'internal', 'boom', undefined))).toBe(false);
    });

    it('accepts a form whose setError takes a narrower name union (FormApi assignability)', () =>
    {
        const form = {
            setError(name: 'title' | 'tag', message: string | null): void
            {
                void name;
                void message;
            }
        };
        expect(applyFieldErrors(form, new Error('x'))).toBe(false);
    });
});

describe('actions stay inside the system', () =>
{
    it('non-action kinds keep the loud refusal', async () =>
    {
        const files = feature('/files', (routes) => ({
            upload: routes.form('/upload', {}, () => ({ ok: true }))
        }));
        const app = new App();
        register(app, { files });
        const client = createClient<{ files: typeof files }>(manifestOf({ files }), {
            baseUrl: '/api',
            fetch: (request) => app.handle(request)
        });
        expect(() => (client.files as unknown as { upload: () => unknown }).upload()).toThrow(/typed client only speaks JSON/);
    });

    it('guards observe the action context; an unguarded sibling app route is untouched', async () =>
    {
        const app = new App();
        app.get('/health', () => json({ up: true }));
        register(app, { posts });
        expect((await app.handle(new Request('http://local/health'))).status).toBe(200);
    });
});
