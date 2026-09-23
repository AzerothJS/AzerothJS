// The api the boot arm registers on the session's App; it answers with the stores it runs under.
import { feature } from '@azerothjs/http/api';
import { object, string } from '@azerothjs/schema';

import { storesSeen } from './stores.ts';

export const bootApi = {
    boot: feature('/boot', (routes) => ({
        read: routes.get('/', { output: object({ n: string() }) }, () => ({ n: storesSeen() }))
    }))
};
