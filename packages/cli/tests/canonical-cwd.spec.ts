// @vitest-environment node
//
// Every command plans from the canonical spelling of the working directory, the one the dev
// session realpaths the application root to, so one install is never loaded under two paths.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalCwd } from '../src/detect.ts';
import { cleanup, makeRoot, packageJson, write } from './fixtures.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const roots: string[] = [];
afterEach(() =>
{
    while (roots.length > 0)
    {
        cleanup(roots.pop() ?? '');
    }
});

describe('the working directory', () =>
{
    // cmd.exe keeps a drive letter as typed, and node reports it that way.
    it.skipIf(process.platform !== 'win32')('a lower-case drive letter plans on the canonical path', () =>
    {
        const dir = makeRoot();
        roots.push(dir);
        write(dir, 'package.json', packageJson({ azerothjs: '^0.9.0' }));
        write(dir, 'vite.config.ts', 'export default {}');
        write(dir, 'node_modules/vite/bin/vite.js', '');
        const typed = dir.charAt(0).toLowerCase() + dir.slice(1);

        const result = spawnSync(process.execPath, [CLI, 'build', '--print'], { cwd: typed, encoding: 'utf8', shell: false });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`[web] cd ${ realpathSync.native(dir) } && `);
    });
});

describe('canonicalCwd', () =>
{
    it('takes the canonical spelling of a local directory', () =>
    {
        expect(canonicalCwd('c:\\work\\app', () => 'C:\\Work\\app')).toBe('C:\\Work\\app');
    });

    it('keeps a mapped drive letter instead of its network share', () =>
    {
        expect(canonicalCwd('r:\\work\\app', () => '\\\\host\\share\\work\\app')).toBe('R:\\work\\app');
    });

    it('keeps a network path that was given as one', () =>
    {
        expect(canonicalCwd('\\\\host\\share\\app', () => '\\\\host\\share\\app')).toBe('\\\\host\\share\\app');
    });

    it('keeps the directory as given when it cannot be resolved', () =>
    {
        const unresolvable = (): string =>
        {
            throw new Error('EISDIR');
        };
        expect(canonicalCwd('C:\\work\\app', unresolvable)).toBe('C:\\work\\app');
    });
});
