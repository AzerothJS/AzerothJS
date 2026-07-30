// @vitest-environment node
//
// The router's own comment said "a malformed escape returns a miss (the app layer's 400 lives
// above this pure structure)". The app layer's 400 was never written: every miss became a 404,
// so `/x/%ZZ` answered "no such resource" for a target that is not a valid URI at all.
//
// RFC 3986 2.1 makes a `%` not followed by two hex digits invalid, and RFC 9110 15.5.1 makes 400
// the answer for a malformed request. Express and Fastify both return 400 here. Nothing was
// exploitable either way - both statuses deny - but the code did not do what it said, and a 404
// tells a client to stop retrying a URL whose only problem is that it was spelled wrong.
import { describe, expect, it } from 'vitest';

import { App, json } from '../src/index.ts';
import { RadixRouter } from '../src/router.ts';

describe('a malformed percent-escape is a 400, not a 404', () =>
{
    it.each(['/x/%ZZ', '/x/%', '/x/%2', '/x/%GG', '/%zz/y'])('reports %s as a decode error', (path) =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/x/:v', 'X');

        expect(router.match('GET', path).kind).toBe('decode-error');
    });

    it('still reports an unknown but WELL-FORMED path as a miss', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/x/:v', 'X');

        expect(router.match('GET', '/nowhere').kind).toBe('miss');
        expect(router.match('GET', '/x/%20').kind).toBe('match');
    });

    it('answers 400 over the app, and still 404 for an unknown path', async () =>
    {
        const app = new App({ dev: false });
        app.get('/x/:v', (context) => json({ v: context.params.v }));

        expect((await app.handle(new Request('http://local/x/%ZZ'))).status).toBe(400);
        expect((await app.handle(new Request('http://local/nowhere'))).status).toBe(404);
        expect((await app.handle(new Request('http://local/x/%20'))).status).toBe(200);
    });

    it('names the failure in the error envelope', async () =>
    {
        const app = new App({ dev: false });
        app.get('/x/:v', () => json({ ok: 1 }));

        const response = await app.handle(new Request('http://local/x/%ZZ'));
        const body = await response.json() as { error: { code: string } };

        expect(body.error.code).toBe('malformed-path');
    });
});
