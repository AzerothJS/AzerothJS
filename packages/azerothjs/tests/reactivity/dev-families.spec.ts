// @vitest-environment node
//
// The DEV family registry must not retain what nothing else holds: a dynamic family
// name (per-tenant, per-request) whose fetcher died is collectible, while a module-held
// family survives for the HMR swap - the control that proves the arm can fail both
// ways. DEV is decided at module load, so the arm runs in a spawned child with
// NODE_ENV=development against the BUILT dist; the staleness guard keeps it from
// rotting into dead code after a src change.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..', '..', '..', '..');

function assertFresh(src: string, dist: string): void
{
    const srcTime = statSync(join(repo, src)).mtimeMs;
    const distTime = statSync(join(repo, dist)).mtimeMs;
    if (srcTime > distTime)
    {
        throw new Error(`${ dist } is STALE (older than ${ src }) - rebuild before running `
            + 'the dev-families retention arm; a stale dist makes this spec test dead code.');
    }
}

describe('dev family registry retention (child process, built dist)', () =>
{
    it('a dropped dynamic family is collected; a module-held one survives; the name re-registers cleanly', async () =>
    {
        assertFresh('packages/azerothjs/src/reactivity/data-cache.ts', 'packages/azerothjs/dist/reactivity/data-cache.js');

        const { stdout } = await run(
            process.execPath,
            ['--expose-gc', join(here, 'fixtures', 'dev-families-child.mjs')],
            { env: { ...process.env, NODE_ENV: 'development' }, timeout: 60000 });
        const lines = stdout.trim().split('\n');
        const report = JSON.parse(lines[lines.length - 1] ?? '{}') as {
            error?: string;
            nodeEnv?: string;
            dynCollected?: boolean;
            heldAlive?: boolean;
            reRegistered?: boolean;
        };
        expect(report.error).toBeUndefined();
        expect(report.nodeEnv).toBe('development');
        expect(report.dynCollected).toBe(true);
        expect(report.heldAlive).toBe(true);
        expect(report.reRegistered).toBe(true);
    }, 90000);
});
