// @vitest-environment node
//
// Type-aware `@typescript-eslint` rules on `.azeroth`. These need a TypeScript Program / typeChecker.
// The custom parser borrows the language service's existing program (no second program is built), and
// the processor maps the resulting diagnostics back to the original `.azeroth` location. Verified
// end-to-end through the real pipeline: register + project (preprocess) -> lint the virtual block with
// the parser + the real `@typescript-eslint` rule -> map back (postprocess).
//
// The fixture lives under the repo (a relative path) so ESLint's flat-config matcher accepts the lint
// filename; the parser resolves it to an absolute path to find the (pooled) project for the fixture's
// own tsconfig.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Linter } from 'eslint';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { azerothProcessor } from '../src/azeroth-processor.ts';
import { azerothParser } from '../src/azeroth-parser.ts';

const fixtureAbs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ta');
// A path RELATIVE to the repo cwd (so ESLint's `files: ['**/*.ts']` matcher accepts it).
const azPath = `${ path.relative(process.cwd(), fixtureAbs).split(path.sep).join('/') }/src/C.azeroth`;
const linter = new Linter();

beforeAll(() => mkdirSync(path.join(fixtureAbs, 'src'), { recursive: true }));
afterAll(() => rmSync(path.join(fixtureAbs, 'src'), { recursive: true, force: true }));

/** Full pipeline: register + project (preprocess) -> lint the virtual block with the parser -> map back. */
function lint(source: string, rules: Linter.RulesRecord): Linter.LintMessage[]
{
    writeFileSync(path.join(fixtureAbs, 'src', 'C.azeroth'), source);
    const blocks = azerothProcessor.preprocess!(source, azPath);
    const raw = linter.verify(
        typeof blocks[0] === 'string' ? blocks[0] : blocks[0].text,
        [{
            files: ['**/*.ts'],
            languageOptions: { parser: azerothParser },
            plugins: { '@typescript-eslint': tsPlugin },
            rules
        }],
        `${ azPath }/0.ts`
    );
    return azerothProcessor.postprocess!([raw], azPath);
}

describe('type-aware rules on .azeroth (reused language-service program)', () =>
{
    it('no-floating-promises fires, mapped to the original `.azeroth` line', () =>
    {
        // `Promise.resolve(1);` is a floating promise on line 3 of the SOURCE (line 2 of the virtual).
        const src = 'export default component C\n{\n    Promise.resolve(1);\n    <p>x</p>\n}\n';
        const messages = lint(src, { '@typescript-eslint/no-floating-promises': 'error' });
        const fp = messages.find(m => m.ruleId === '@typescript-eslint/no-floating-promises');
        expect(fp, 'a type-aware rule must fire on .azeroth').toBeDefined();
        expect(fp!.line).toBe(3); // ORIGINAL line, not the virtual line 2 - the mapping ran
    });

    it('strict-boolean-expressions fires on a nullable condition (needs the type checker)', () =>
    {
        const src = 'export default component C\n{\n    const value: string | null = null;\n    derived label = value ? value : \'none\';\n    <p>{ label }</p>\n}\n';
        const messages = lint(src, { '@typescript-eslint/strict-boolean-expressions': 'error' });
        expect(messages.some(m => m.ruleId === '@typescript-eslint/strict-boolean-expressions')).toBe(true);
    });

    it('does NOT fire when the code is type-correct (no false positive)', () =>
    {
        const src = 'export default component C\n{\n    async function load(): Promise<void> { await Promise.resolve(); }\n    effect { void load(); }\n    <p>x</p>\n}\n';
        const messages = lint(src, { '@typescript-eslint/no-floating-promises': 'error' });
        expect(messages.some(m => m.ruleId === '@typescript-eslint/no-floating-promises')).toBe(false);
    });
});
