// @vitest-environment node
//
// azeroth-tsc driver: parseArgs must map the CLI surface onto TscOptions, and
// runTsc must check a real on-disk fixture app - the combined `.ts` + `.azeroth`
// program - reporting file/error counts and tsc-shaped diagnostics through the
// injectable write sink. watchTsc's recheck/close handle is exercised directly,
// without waiting on file-system events.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseArgs, runTsc, watchTsc } from '../src/tsc.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const appDir = path.join(fixtures, 'app');
const brokenDir = path.join(fixtures, 'broken');

/** Runs one check over `dir`, capturing everything written to the sink. */
function check(dir: string): { out: string; fileCount: number; errorCount: number }
{
    const chunks: string[] = [];
    const write = (text: string): void =>
    {
        chunks.push(text);
    };
    const result = runTsc({ cwd: dir, project: path.join(dir, 'tsconfig.json'), write });
    return { out: chunks.join(''), ...result };
}

describe('parseArgs', () =>
{
    it('parses --project in all three spellings', () =>
    {
        expect(parseArgs(['--project', 'a/tsconfig.json']).project).toBe('a/tsconfig.json');
        expect(parseArgs(['-p', 'b/tsconfig.json']).project).toBe('b/tsconfig.json');
        expect(parseArgs(['--project=c/tsconfig.json']).project).toBe('c/tsconfig.json');
    });

    it('parses the watch flags and the positional cwd', () =>
    {
        expect(parseArgs(['--watch']).watch).toBe(true);
        expect(parseArgs(['-w']).watch).toBe(true);
        expect(parseArgs(['some/dir']).cwd).toBe('some/dir');
        expect(parseArgs([]).cwd).toBeUndefined();
    });

    it('ignores unknown flags instead of treating them as a cwd', () =>
    {
        const options = parseArgs(['--bogus']);
        expect(options.cwd).toBeUndefined();
        expect(options.project).toBeUndefined();
    });

    it('a trailing -p without a value falls back to the empty string', () =>
    {
        expect(parseArgs(['-p']).project).toBe('');
    });
});

describe('runTsc', () =>
{
    it('checks the fixture app clean: 1 .azeroth + 1 .ts, zero errors', () =>
    {
        const { out, fileCount, errorCount } = check(appDir);
        expect(errorCount).toBe(0);
        expect(fileCount).toBe(2);
        expect(out).toContain('Checked 2 file(s) (1 .azeroth, 1 .ts); no type errors.');
    });

    it('reports a .azeroth type error in tsc format with a relative forward-slash path', () =>
    {
        const { out, fileCount, errorCount } = check(brokenDir);
        expect(fileCount).toBe(2);
        expect(errorCount).toBe(1);
        expect(out).toMatch(/^Broken\.azeroth\(\d+,\d+\): error TS2322: /m);
        expect(out).toContain('Found 1 error(s) across 2 file(s) (1 .azeroth, 1 .ts).');
    });
});

describe('watchTsc', () =>
{
    it('runs an initial pass and rechecks on demand', () =>
    {
        const chunks: string[] = [];
        const write = (text: string): void =>
        {
            chunks.push(text);
        };
        const watcher = watchTsc({ cwd: appDir, project: path.join(appDir, 'tsconfig.json'), write });
        try
        {
            expect(chunks.join('')).toContain('no type errors');
            const result = watcher.recheck();
            expect(result.errorCount).toBe(0);
            expect(result.fileCount).toBe(2);
        }
        finally
        {
            watcher.close();
        }
    });
});
