// CLIENT-SAFE: the application imports this file, so it may import only the schema package.
// One declaration validates the browser form AND the server boundary.
import { date, number, object, string, type Infer } from '@azerothjs/schema';

// Shared fields, so the submitted and the stored shape cannot drift apart.
const entryFields = {
    name: string({ min: 2, max: 40 }),
    message: string({ min: 1, max: 280 })
};

export const entryInput = object(entryFields);
// `date()` is the Date wire codec: the handler stores a real Date, the wire carries its
// ISO string, and the client's types say string (Wire<Entry>) - nobody lies.
export const entry = object({ ...entryFields, id: number({ int: true }), at: date() });
export type Entry = Infer<typeof entry>;
