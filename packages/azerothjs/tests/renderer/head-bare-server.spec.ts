// @vitest-environment node
//
// useHead on a bare server (no DOM globals) must be a diagnosed no-op that the process
// SURVIVES. Pre-fix it armed queueMicrotask(sweepUnclaimedMarked) before validating that a
// document exists, so beyond a catchable sync throw the microtask's ReferenceError carried
// no user frame and exited the process (measured exit code 1). DEV is fixed at module
// load, so the arm runs in a spawned child against the BUILT dist, with the staleness
// guard that keeps a dist-importing child from silently testing dead code.
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
    if (statSync(join(repo, src)).mtimeMs > statSync(join(repo, dist)).mtimeMs)
    {
        throw new Error(`${ dist } is STALE (older than ${ src }) - rebuild before running `
            + 'the bare-server arm; a stale dist makes this spec test dead code.');
    }
}

describe('useHead on a bare server (child process, built dist)', () =>
{
    it('is a diagnosed no-op: no sync throw, no microtask kill, exit 0', async () =>
    {
        assertFresh('packages/azerothjs/src/renderer/head.ts', 'packages/azerothjs/dist/renderer/head.js');

        const { stdout, stderr } = await run(
            process.execPath,
            [join(here, 'fixtures', 'head-bare-server.mjs')],
            { env: { ...process.env, NODE_ENV: 'development' }, timeout: 30000 });
        const lines = stdout.trim().split('\n');
        const report = JSON.parse(lines[lines.length - 1] ?? '{}') as {
            error?: string;
            survived?: boolean;
            syncThrew?: boolean;
        };
        expect(report.error).toBeUndefined();
        expect(report.survived).toBe(true);
        expect(report.syncThrew).toBe(false);
        expect(stderr).toContain('no document');
    });
});
