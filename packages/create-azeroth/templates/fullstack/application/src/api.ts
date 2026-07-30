// The one file that crosses into the server half. Pages import the client AND the shared shapes
// from here, so no page carries its own path across; '/api' matches the dev proxy and the
// production mount.
import { createClient } from '@azerothjs/http/api/shared';
import { contract } from '../../server/src/contract.ts';

export { entryInput, type Entry } from '../../server/src/contract.ts';

export const client = createClient(contract, { baseUrl: '/api' });
