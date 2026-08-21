// @vitest-environment node
//
// The http-less control for the fail-closed rule: a child that never imports
// @azerothjs/http (raw node:http server + attachWebSockets) still fails OPEN at the
// default scope - a known, deliberate limitation held as a living arm rather than
// silently claimed. Runs against the BUILT dist in production mode; the staleness guards
// keep the arm from rotting into dead code after a src change.
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
            + 'the fail-open residual arm; a stale dist makes this spec test dead code.');
    }
}

describe('the http-less residual (child process, built dist)', () =>
{
    it('two ws clients on a bare node server share ONE fetch: the default scope fails open without http', async () =>
    {
        assertFresh('packages/azerothjs/src/reactivity/data-cache.ts', 'packages/azerothjs/dist/reactivity/data-cache.js');
        assertFresh('packages/ws/src/attach.ts', 'packages/ws/dist/attach.js');
        assertFresh('packages/ws/src/socket.ts', 'packages/ws/dist/socket.js');

        const { stdout } = await run(
            process.execPath,
            [join(here, 'fixtures', 'failopen-ws-child.mjs')],
            { env: { ...process.env, NODE_ENV: 'production' }, timeout: 60000 });
        const lines = stdout.trim().split('\n');
        const report = JSON.parse(lines[lines.length - 1] ?? '{}') as {
            error?: string;
            first?: string;
            second?: string;
            fetchCount?: number;
        };
        expect(report.error).toBeUndefined();
        expect(report.first).toBe('v:shared|1');
        expect(report.second).toBe('v:shared|1');
        expect(report.fetchCount).toBe(1);
    }, 90000);
});
