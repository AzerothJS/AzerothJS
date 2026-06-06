// azeroth-tsc (the vue-tsc equivalent) batch-checks `.azeroth` files and maps
// type errors back to original positions, so it can gate CI alongside `tsc`.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runTsc, parseArgs } from '../../packages/language-server/src/tsc.ts';

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

    it('parses --project and a positional cwd', () =>
    {
        expect(parseArgs(['--project', 'a/tsconfig.json', 'src'])).toEqual({ project: 'a/tsconfig.json', cwd: 'src' });
        expect(parseArgs(['-p', 'b.json'])).toEqual({ project: 'b.json' });
        expect(parseArgs(['--project=c.json'])).toEqual({ project: 'c.json' });
    });
});
