// The fully inferred API client, built from the SAME contract the server mounts
// (server/src/contract.ts - one declaration, both sides). Calls are typed end to
// end: `client.guestbook.sign({ input })` checks the input against the shared
// schema BEFORE the wire, and the response type is the contract's output type.
// The '/api' base matches the dev proxy (vite.config.ts) and the production mount.
import { createClient } from '@azerothjs/http/api/client';
import { contract } from '../../server/src/contract.ts';

export const client = createClient(contract, { baseUrl: '/api' });
