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
            const src = readFileSync(path.join(examplesDir, file), 'utf8');
            expect(() => generateModule(src)).not.toThrow();
            expect(typeCheckModuleTS(src)).toEqual([]);
        });
    }
});
