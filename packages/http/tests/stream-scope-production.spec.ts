// @vitest-environment node
//
// The streamed-scope arm in production mode: DEV is decided at module load, so the arm
// runs in a spawned child with NODE_ENV=production against the BUILT dist. The staleness
// guards keep the arm from rotting into dead code after a src change.
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
            + 'the streamed-scope production arm; a stale dist makes this spec test dead code.');
    }
}

describe('streamed request scope in production (child process, built dist)', () =>
{
    it('one paced request fetches once; two sequential requests fetch twice', async () =>
    {
        assertFresh('packages/http/src/request-root.ts', 'packages/http/dist/request-root.js');
        assertFresh('packages/azerothjs/src/reactivity/data-cache.ts', 'packages/azerothjs/dist/reactivity/data-cache.js');

        const { stdout } = await run(
            process.execPath,
            [join(here, 'fixtures', 'stream-scope-child.mjs')],
            { env: { ...process.env, NODE_ENV: 'production' }, timeout: 60000 });
        const lines = stdout.trim().split('\n');
        const report = JSON.parse(lines[lines.length - 1] ?? '{}') as {
            error?: string;
            nodeEnv?: string;
            fetchesOneRequest?: number;
            fetchesTwoRequests?: number;
        };
        expect(report.error).toBeUndefined();
        expect(report.nodeEnv).toBe('production');
        expect(report.fetchesOneRequest).toBe(1);
        expect(report.fetchesTwoRequests).toBe(2);
    }, 90000);
});
