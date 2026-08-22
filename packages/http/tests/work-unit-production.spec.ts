// @vitest-environment node
//
// The work-unit heap arm in production mode: fifty intercepted ws messages retain ZERO
// caches after settle at the SHIPPED default retain, and a held-open unit pins exactly
// one - the living control proving the counter sees retained units. DEV is decided at
// module load, so the arm runs in a spawned child against the BUILT dist; the staleness
// guards keep it from rotting into dead code after a src change.
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
            + 'the work-unit heap arm; a stale dist makes this spec test dead code.');
    }
}

describe('work-unit retention in production (child process, built dist)', () =>
{
    it('50 intercepted messages retain 0 caches after settle; a held-open unit pins exactly 1', async () =>
    {
        assertFresh('packages/http/src/request-root.ts', 'packages/http/dist/request-root.js');
        assertFresh('packages/azerothjs/src/reactivity/data-cache.ts', 'packages/azerothjs/dist/reactivity/data-cache.js');
        assertFresh('packages/ws/src/socket.ts', 'packages/ws/dist/socket.js');

        const { stdout } = await run(
            process.execPath,
            ['--expose-gc', join(here, 'fixtures', 'work-unit-child.mjs')],
            { env: { ...process.env, NODE_ENV: 'production' }, timeout: 60000 });
        const lines = stdout.trim().split('\n');
        const report = JSON.parse(lines[lines.length - 1] ?? '{}') as {
            error?: string;
            nodeEnv?: string;
            replies?: number;
            afterSettled?: number;
            afterHeld?: number;
        };
        expect(report.error).toBeUndefined();
        expect(report.nodeEnv).toBe('production');
        expect(report.replies).toBe(51);
        expect(report.afterSettled).toBe(0);
        expect(report.afterHeld).toBe(1);
    }, 90000);
});
