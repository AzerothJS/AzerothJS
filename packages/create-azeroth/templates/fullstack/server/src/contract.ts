// CLIENT-SAFE: the application imports this file, so it may import only the shared api entry
// and the schema package. Reaching for the store or a service here would drag the server half
// into the browser bundle.
import { defineContract, get, post } from '@azerothjs/http/api/shared';
import { array, number, object, string, type Infer } from '@azerothjs/schema';

// Shared fields, so the submitted and the stored shape cannot drift apart. Spread extends a
// shape and destructuring omits from it: composing schemas is composing objects.
const entryFields = {
    name: string({ min: 2, max: 40 }),
    message: string({ min: 1, max: 280 })
};

export const entryInput = object(entryFields);
export const entry = object({ ...entryFields, id: number({ int: true }), at: string() });
export type Entry = Infer<typeof entry>;

// The key path IS the client's call path: `guestbook.sign` here is
// `client.guestbook.sign({ input })` in the browser.
export const contract = defineContract({
    guestbook: {
        list: get('/guestbook', { output: array(entry) }),
        sign: post('/guestbook', { input: entryInput, output: entry })
    }
});
