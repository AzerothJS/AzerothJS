// @vitest-environment node
//
// Smoke coverage for the shipped `examples/*.azeroth`: each must compile (generateModule) and type-check
// (typeCheckModuleTS) cleanly, so an example in the README/docs is never stale or broken. This is also
// the regression guard for the Showcase, which exercises real component parameters end-to-end.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateModule } from '../src/codegen.ts';
import { typeCheckModuleTS } from '../src/typecheck-ts.ts';

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const examples = readdirSync(examplesDir).filter(f => f.endsWith('.azeroth'));

describe('examples/*.azeroth compile and type-check', () =>
{
    it('finds the shipped examples', () =>
    {
        expect(examples.length).toBeGreaterThan(0);
    });

    for (const file of examples)
    {
        it(`compiles ${ file }`, () =>
        {
            const fileName = path.join(examplesDir, file);
            const src = readFileSync(fileName, 'utf8');
            expect(() => generateModule(src)).not.toThrow();
            // The real path, not the default virtual one: module resolution walks UP from it, so
            // `azerothjs` resolves and the imported types exist. Checked virtually, every
            // cross-module error this guard is for resolves to `any` and the check passes empty.
            expect(typeCheckModuleTS(src, { fileName })).toEqual([]);
        });
    }
});
