// @vitest-environment node
//
// The shipped-default retention arm: a production server must retain ONLY the
// pre-construction seed cache after teardown at the DEFAULT retain - request caches all
// release, and the marked process refuses new default-scope caches. DEV is decided at
// module load, so the arm runs in a spawned child with NODE_ENV=production against the
// BUILT dist. Vacuity guards: a staleness check fails loudly when dist is older than the
// src it was built from; the LIVING positive control is a default-scope read BEFORE App
// construction (the mark is construction-onward), whose cache stays alive so the counter
// provably sees a retained cache; and the fail-closed refusal asserts on the FETCHER
// INVOCATION delta, the one channel a released control could not fake.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..', '..', '..');

function assertFresh(src: string, dist: string): void
{
    const srcTime = statSync(join(repo, src)).mtimeMs;
    const distTime = statSync(join(repo, dist)).mtimeMs;
    if (srcTime > distTime)
    {
        throw new Error(`${ dist } is STALE (older than ${ src }) - rebuild before running `
            + 'the production retention arm; a stale dist makes this spec test dead code.');
    }
}

describe('production retention at the shipped default (child process, built dist)', () =>
{
    it('300 requests retain only the pre-construction seed; the marked refusal re-fetches the seeded key', async () =>
    {
        assertFresh('packages/azerothjs/src/reactivity/data-cache.ts', 'packages/azerothjs/dist/reactivity/data-cache.js');
        assertFresh('packages/azerothjs/src/reactivity/store-scope.ts', 'packages/azerothjs/dist/reactivity/store-scope.js');
        assertFresh('packages/azerothjs/src/ssr/render-to-string.ts', 'packages/azerothjs/dist/ssr/render-to-string.js');
        assertFresh('packages/azerothjs/src/ssr/render-to-stream.ts', 'packages/azerothjs/dist/ssr/render-to-stream.js');
        assertFresh('packages/azerothjs/src/internal.ts', 'packages/azerothjs/dist/internal.js');
        assertFresh('packages/http/src/request-root.ts', 'packages/http/dist/request-root.js');

        const { stdout } = await run(
            process.execPath,
            ['--expose-gc', join(here, 'fixtures', 'retention-child.mjs')],
            { env: { ...process.env, NODE_ENV: 'production' }, timeout: 60000 });
        const lines = stdout.trim().split('\n');
        const report = JSON.parse(lines[lines.length - 1] ?? '{}') as {
            error?: string;
            nodeEnv?: string;
            beforeSeed?: number;
            seedFetches?: number;
            afterSeed?: number;
            afterTeardown?: number;
            refusalDelta?: number;
            refusedValue?: string;
            afterRefusal?: number;
        };
        expect(report.error).toBeUndefined();
        expect(report.nodeEnv).toBe('production');
        expect(report.beforeSeed).toBe(0);
        expect(report.seedFetches).toBe(1);
        expect(report.afterSeed).toBe(1);
        expect(report.afterTeardown).toBe(1);
        expect(report.refusalDelta).toBe(1);
        expect(report.refusedValue).toBe('v:app-scope');
        expect(report.afterRefusal).toBe(1);
    }, 90000);
});
