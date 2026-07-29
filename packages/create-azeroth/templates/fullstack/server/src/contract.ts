// THE shared API contract - one declaration, both sides of the wire.
//
// The server mounts it (app.ts: mountApi) and the application imports it for the
// fully inferred client (application/src/api.ts). This file is CLIENT-SAFE by
// construction: it imports only the browser entry of the contract layer and the
// isomorphic schema package, so bundling it into the application drags in zero
// server code. It lives in server/src so the production Docker image (which copies
// server/src verbatim) carries it without extra wiring.
import { defineContract, get, post } from '@azerothjs/http/api/client';
import { array, number, object, string, type Infer } from '@azerothjs/schema';

/**
 * The guestbook entry a visitor SUBMITS. The same schema validates three times
 * from one declaration: in the browser form (before the wire), in the typed
 * client (pre-flight), and at the server boundary (a forged request gets a 422
 * whose field map the form displays directly).
 */
export const entryInput = object({
    name: string({ min: 2, max: 40 }),
    message: string({ min: 1, max: 280 })
});

/** The stored entry the API returns. */
export const entry = object({
    id: number({ int: true }),
    name: string(),
    message: string(),
    at: string()
});

export type Entry = Infer<typeof entry>;

/**
 * The routes, grouped. `get`/`post`/`put`/`patch`/`del`/`query` name the method in the call,
 * so a route reads as one line - and a GET cannot declare an `input`, because the helper's
 * definition has no such field. (`route({ method, path, ... })` is the general form
 * underneath; reach for it only for a method these six do not cover.)
 *
 * The key path is the client's call path: `guestbook.sign` here is
 * `client.guestbook.sign({ input })` in the browser.
 */
export const contract = defineContract({
    guestbook: {
        list: get('/guestbook', { output: array(entry) }),
        sign: post('/guestbook', { input: entryInput, output: entry })
    }
});
