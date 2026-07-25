// THE shared API contract - one declaration, both sides of the wire.
//
// The server mounts it (app.ts: mountApi) and the application imports it for the
// fully inferred client (application/src/api.ts). This file is CLIENT-SAFE by
// construction: it imports only the browser entry of the contract layer and the
// isomorphic schema package, so bundling it into the application drags in zero
// server code. It lives in server/src so the production Docker image (which copies
// server/src verbatim) carries it without extra wiring.
import { defineContract, route } from '@azerothjs/http/api/client';
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

export type EntryInput = Infer<typeof entryInput>;
export type Entry = Infer<typeof entry>;

export const contract = defineContract({
    guestbook: {
        list: route({ method: 'GET', path: '/guestbook', output: array(entry) }),
        sign: route({ method: 'POST', path: '/guestbook', input: entryInput, output: entry })
    }
});
