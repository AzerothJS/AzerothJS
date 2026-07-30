// The application's one seam to the shared contract. The server's declaration is imported by
// relative path, not fetched, so changing a route's shape in server/src/contract.ts stops this
// half typechecking immediately. Calls are typed end to end and validated against the same
// schema BEFORE the wire; the '/api' base matches the dev proxy and the production mount.
import { createClient } from '@azerothjs/http/api/client';
import { contract } from '../../server/src/contract.ts';

// Re-exported so a page reaches the shared shapes through this seam rather than climbing
// out of src/pages/ with its own relative path.
export { entryInput, type Entry } from '../../server/src/contract.ts';

export const client = createClient(contract, { baseUrl: '/api' });
