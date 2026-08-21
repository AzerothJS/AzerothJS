// @vitest-environment node
//
// The streamed-keep property under NODE_ENV=production, where the old loss was SILENT:
// a frame-owning host that yields past the measured loss window keeps its own title and
// styles. DEV is fixed at module load, so the arm spawns a child against the BUILT dist,
// staleness-guarded so it can never test dead code.
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
        throw new Error(`${ dist } is STALE (older than ${ src }) - rebuild first; a stale dist makes `
            + 'this spec test dead code.');
    }
}

describe('streamed frame ownership under production (child process, built dist)', () =>
{
    it('a yielding frame-owning host keeps its own head and styles', async () =>
    {
        assertFresh('packages/azerothjs/src/renderer/frame.ts', 'packages/azerothjs/dist/renderer/frame.js');
        assertFresh('packages/azerothjs/src/ssr/render-to-stream.ts', 'packages/azerothjs/dist/ssr/render-to-stream.js');
        assertFresh('packages/azerothjs/src/renderer/css.ts', 'packages/azerothjs/dist/renderer/css.js');
        assertFresh('packages/azerothjs/src/renderer/head.ts', 'packages/azerothjs/dist/renderer/head.js');

        const { stdout } = await run(
            process.execPath,
            [join(here, 'fixtures', 'frame-stream-production.mjs')],
            { env: { ...process.env, NODE_ENV: 'production' }, timeout: 30000 });
        const lines = stdout.trim().split('\n');
        const report = JSON.parse(lines[lines.length - 1] ?? '{}') as {
            error?: string;
            title?: string | null;
            cssPresent?: boolean;
        };
        expect(report.error).toBeUndefined();
        expect(report.title).toBe('PROD-STREAM-TITLE');
        expect(report.cssPresent).toBe(true);
    });
});
