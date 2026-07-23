// @vitest-environment node
//
// The one error path: every thrown value maps to a Response with the stable wire shape, 4xx
// messages cross the wire while 5xx internals stay home, and the mapper itself can never
// throw. These semantics are what the whole stack leans on, so they are pinned exhaustively.

import { describe, it, expect, vi } from 'vitest';
import {
    HttpError, BadRequestError, NotFoundError, MethodNotAllowedError, ValidationError,
    PayloadTooLargeError, TooManyRequestsError, errorResponse, type ErrorSerializerContext
} from '../src/errors.ts';

async function wire(response: Response): Promise<{ status: number; body: { error: { code: string; message: string; details?: unknown; stack?: string | undefined } }; headers: Headers }>
{
    return { status: response.status, body: (await response.json()) as { error: { code: string; message: string; details?: unknown; stack?: string | undefined } }, headers: response.headers };
}

describe('the wire shape', () =>
{
    it('serializes an HttpError as { error: { code, message } } with its status', async () =>
    {
        const { status, body, headers } = await wire(errorResponse(new NotFoundError('No such user.')));
        expect(status).toBe(404);
        expect(body).toEqual({ error: { code: 'not-found', message: 'No such user.' } });
        expect(headers.get('content-type')).toContain('application/json');
    });

    it('carries structured details (the validation field map)', async () =>
    {
        const { status, body } = await wire(errorResponse(new ValidationError({ email: 'Enter a valid email' })));
        expect(status).toBe(422);
        expect(body.error.code).toBe('validation-failed');
        expect(body.error.details).toEqual({ fields: { email: 'Enter a valid email' } });
    });

    it('emits mandated headers (Allow on 405, Retry-After on 429)', async () =>
    {
        const allow = await wire(errorResponse(new MethodNotAllowedError(['GET', 'PUT'])));
        expect(allow.headers.get('allow')).toBe('GET, PUT');

        const retry = await wire(errorResponse(new TooManyRequestsError(30)));
        expect(retry.headers.get('retry-after')).toBe('30');
    });
});

describe('exposure: 4xx speaks, 5xx stays home', () =>
{
    it('a 4xx message crosses the wire', async () =>
    {
        const { body } = await wire(errorResponse(new BadRequestError('That is not JSON.')));
        expect(body.error.message).toBe('That is not JSON.');
    });

    it('a thrown non-HttpError becomes a 500 with a generic body', async () =>
    {
        const { status, body } = await wire(errorResponse(new Error('SELECT * FROM secrets failed')));
        expect(status).toBe(500);
        expect(body.error.message).toBe('Internal server error');
        expect(JSON.stringify(body)).not.toContain('secrets');
    });

    it('a thrown non-Error value maps safely too', async () =>
    {
        const { status } = await wire(errorResponse('just a string'));
        expect(status).toBe(500);
    });

    it('dev mode exposes the message and the stack of a 500 - debugging beats secrecy locally', async () =>
    {
        const { body } = await wire(errorResponse(new Error('boom at line 3'), { dev: true }));
        expect(body.error.message).toBe('boom at line 3');
        expect(body.error.stack).toContain('boom');
    });

    it('an explicit expose override wins', async () =>
    {
        const err = new HttpError(500, 'Upstream is down for maintenance', { expose: true });
        const { body } = await wire(errorResponse(err));
        expect(body.error.message).toBe('Upstream is down for maintenance');
    });
});

describe('the observer seam', () =>
{
    it('sees the original error and the mapped HttpError', () =>
    {
        const observe = vi.fn();
        const original = new Error('db down');
        errorResponse(original, { observe });
        expect(observe).toHaveBeenCalledTimes(1);
        const [seenOriginal, seenMapped] = (observe.mock.calls[0] ?? []) as [unknown, unknown];
        expect(seenOriginal).toBe(original);
        expect(seenMapped).toBeInstanceOf(HttpError);
        expect((seenMapped as HttpError).status).toBe(500);
    });

    it('an observer that throws cannot break the error path', async () =>
    {
        const response = errorResponse(new NotFoundError(), { observe: () =>
        {
            throw new Error('logger exploded');
        } });
        expect((await wire(response)).status).toBe(404);
    });
});

describe('error metadata', () =>
{
    it('preserves the cause chain for logging', () =>
    {
        const cause = new SyntaxError('Unexpected token');
        const err = new BadRequestError('The body is not valid JSON.', { cause });
        expect(err.cause).toBe(cause);
    });

    it('PayloadTooLarge carries its code for client switching', () =>
    {
        expect(new PayloadTooLargeError().code).toBe('payload-too-large');
    });
});

describe('the serializeError hook', () =>
{
    const req = (): Request => new Request('http://local/thing?q=1');

    it('replaces the body shape while keeping status and mandated headers', async () =>
    {
        const serialize = ({ error, request }: ErrorSerializerContext): unknown => ({
            success: false,
            code: error.code,
            message: error.message,
            path: new URL(request.url).pathname
        });
        const response = errorResponse(new NotFoundError('No user.'), { serialize, request: req() });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ success: false, code: 'not-found', message: 'No user.', path: '/thing' });
        expect(response.headers.get('content-type')).toContain('application/json');

        // A custom body must not drop the error's mandated headers (405 Allow).
        const mna = errorResponse(new MethodNotAllowedError(['GET']), { serialize: () => ({ ok: false }), request: req() });
        expect(mna.headers.get('allow')).toBe('GET');
    });

    it('takes full control when it returns a Response', async () =>
    {
        const serialize = (): Response => new Response('nope', { status: 418, headers: { 'x-custom': '1' } });
        const response = errorResponse(new NotFoundError(), { serialize, request: req() });
        expect(response.status).toBe(418);
        expect(response.headers.get('x-custom')).toBe('1');
        expect(await response.text()).toBe('nope');
    });

    it('falls back to the default shape when it returns undefined', async () =>
    {
        const response = errorResponse(new NotFoundError('gone'), { serialize: () => undefined, request: req() });
        expect(await response.json()).toEqual({ error: { code: 'not-found', message: 'gone' } });
    });

    it('never breaks the error path: a throwing serializer falls back to the default', async () =>
    {
        const response = errorResponse(new BadRequestError('bad'), {
            serialize: () =>
            {
                throw new Error('serializer blew up');
            },
            request: req()
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { code: 'bad-request', message: 'bad' } });
    });

    it('reports expose=false for a 5xx so the serializer knows not to leak the message', () =>
    {
        let sawExpose = true;
        errorResponse(new Error('internal detail'), {
            request: req(),
            serialize: ({ expose }): unknown =>
            {
                sawExpose = expose; return { code: 'x' };
            }
        });
        expect(sawExpose).toBe(false);
    });
});
