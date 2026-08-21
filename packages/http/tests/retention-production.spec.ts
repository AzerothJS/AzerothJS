// @vitest-environment node
//
// The shipped-default retention arm: a production server that never latches must retain
// ZERO caches after teardown at the DEFAULT retain. DEV is decided at module load, so the
// arm runs in a spawned child with NODE_ENV=production against the BUILT dist - and two
// vacuity guards make the arm able to fail: a staleness check fails loudly when dist is
// older than the src it was built from (a dist-importing child otherwise rots silently
// after the first build), and the child carries a LIVING positive control (one app-scope
// read must raise the count to exactly 1, proving the counter sees retained caches - and
// wiring the retain-legitimate-app-scope-caches acceptance criterion in as a living arm).
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
    it('300 requests retain 0 caches after teardown; the living control raises the count to exactly 1', async () =>
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
            before?: number;
            afterTeardown?: number;
            afterAppScopeRead?: number;
        };
        expect(report.error).toBeUndefined();
        expect(report.nodeEnv).toBe('production');
        expect(report.before).toBe(0);
        expect(report.afterTeardown).toBe(0);
        expect(report.afterAppScopeRead).toBe(1);
    }, 90000);
});
