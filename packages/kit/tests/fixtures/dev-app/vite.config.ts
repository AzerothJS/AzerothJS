import { fileURLToPath } from 'node:url';

import { azeroth } from '@azerothjs/compiler';
import { defineConfig } from 'vite';

// The kit is exercised from SOURCE on both sides of the session: the spec imports these same
// files through vitest, so one edit is one behaviour. `azerothjs` deliberately stays the
// installed (built) package on both sides - see the ssr pin below.
const kitSrc = fileURLToPath(new URL('../../../src/', import.meta.url));

// The spec has no other way in: the session keeps its vite server private, and the change-set
// arms must drive the recorder hook and watch the ssr module graph directly. `post` so this
// hook fires AFTER the session's own recorder, which is the window the drain owns.
const probe = ((globalThis as Record<string, unknown>).__azerothDevProbe ??= {}) as {
    server?: unknown;
    onWatchChange?: (id: string, change: unknown) => void;
    onConfigureServer?: (server: unknown) => Promise<void>;
};

export default defineConfig({
    plugins: [
        azeroth(),
        {
            name: 'dev-app:probe',
            enforce: 'post',
            async configureServer(server)
            {
                probe.server = server;
                await probe.onConfigureServer?.(server);
            },
            watchChange(id, change)
            {
                probe.onWatchChange?.(id, change);
            }
        }
    ],
    resolve:
    {
        alias: [
            { find: '@azerothjs/kit/ssr', replacement: `${ kitSrc }ssr.ts` },
            { find: '@azerothjs/kit', replacement: `${ kitSrc }index.ts` }
        ]
    },
    // The template's own shape, and load-bearing for the same reason: `noExternal: true` would
    // inline `azerothjs` too, and one process must hold ONE instance of the runtime.
    ssr:
    {
        noExternal: true,
        external: ['azerothjs']
    }
});
