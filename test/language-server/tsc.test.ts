// azeroth-tsc (the vue-tsc equivalent) batch-checks `.azeroth` files and maps
// type errors back to original positions, so it can gate CI alongside `tsc`.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { runTsc, watchTsc, parseArgs } from '../../packages/language-server/src/tsc.ts';

const FIXTURES = path.join(process.cwd(), 'test', 'language-server', 'fixtures');

function check(fixture: string): { output: string; fileCount: number; errorCount: number }
{
    const out: string[] = [];
    const result = runTsc({ cwd: path.join(FIXTURES, fixture), write: (t) => out.push(t) });
    return { output: out.join(''), ...result };
}

describe('azeroth-tsc', () =>
{
    it('reports no errors for a well-typed .azeroth project', () =>
    {
        const { errorCount, fileCount } = check('clean');
        expect(fileCount).toBe(1);
        expect(errorCount).toBe(0);
    });

    it('reports a type error mapped back to the original .azeroth position', () =>
    {
        const { output, errorCount } = check('errors');
        expect(errorCount).toBe(1);
        // tsc-style line: file(line,col): error TSxxxx: message, at the ORIGINAL
        // .azeroth offset (the `total` declaration on line 1), not a virtual one.
        expect(output).toMatch(/bad\.azeroth\(1,7\): error TS2322:/);
        expect(output).toContain('not assignable to type \'number\'');
    });

    it('parses --project, a positional cwd, and --watch', () =>
    {
        expect(parseArgs(['--project', 'a/tsconfig.json', 'src'])).toEqual({ project: 'a/tsconfig.json', cwd: 'src' });
        expect(parseArgs(['-p', 'b.json'])).toEqual({ project: 'b.json' });
        expect(parseArgs(['--project=c.json'])).toEqual({ project: 'c.json' });
        expect(parseArgs(['--watch'])).toEqual({ watch: true });
        expect(parseArgs(['-w', 'app'])).toEqual({ watch: true, cwd: 'app' });
    });
});

describe('azeroth-tsc --watch', () =>
{
    it('checks once on start and re-checks on demand, reflecting disk changes', () =>
    {
        // A markup-free `.azeroth` is a plain TS module, so this needs no
        // `@azerothjs/*` resolution and runs from a throwaway temp dir.
        const dir = mkdtempSync(path.join(os.tmpdir(), 'azeroth-tsc-watch-'));
        try
        {
            writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
                compilerOptions: { strict: true, noEmit: true, target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', lib: ['ESNext'] }
            }));
            const file = path.join(dir, 'a.azeroth');
            writeFileSync(file, 'const greeting: string = \'hi\';\nexport const value = greeting;\n');

            const out: string[] = [];
            const watcher = watchTsc({ cwd: dir, write: (t) => out.push(t) });
            try
            {
                // Initial pass is clean.
                expect(out.join('')).toContain('no type errors');

                // Introduce an error on disk, then force a re-check.
                writeFileSync(file, 'const total: number = \'nope\';\nexport const value = total;\n');
                const result = watcher.recheck();
                expect(result.errorCount).toBe(1);
                expect(out.join('')).toContain('not assignable');
            }
            finally
            {
                watcher.close();
            }
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
