// @vitest-environment node
//
// The `.azeroth` examples printed in the shipped documentation, run through the SAME
// compile + type-check the examples/ directory gets. A guide's example is the first code a
// reader writes, and one that does not compile costs them a debugging session before they
// have written anything of their own - which is how the nested-layout example in the router
// guide came to be reported: `props: { children?: unknown }` yields TS2322 at `<Outlet>`.
//
// Only COMPLETE modules are checked, marked by the convention the docs already follow: a
// leading `// name.azeroth` comment plus a `component` declaration. Fragments (`children:
// [ ... ]`) are prose, not code, and cannot compile. The count is asserted, so a change to
// that convention fails here instead of silently checking nothing.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateModule } from '../src/codegen.ts';
import { typeCheckModuleTS } from '../src/typecheck-ts.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function markdownIn(dir: string, out: string[] = []): string[]
{
    for (const entry of readdirSync(dir))
    {
        if (entry === 'node_modules' || entry === 'dist')
        {
            continue;
        }
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory())
        {
            markdownIn(full, out);
        }
        else if (entry.endsWith('.md'))
        {
            out.push(full);
        }
    }
    return out;
}

interface DocExample
{
    /** Where it lives, as the failure message a reader can act on. */
    where: string;

    /**
     * A path in the DOCUMENT'S OWN directory. Load-bearing: with a virtual path nothing
     * above it resolves, `azerothjs` types are absent, and every cross-module error the
     * check exists for silently disappears.
     */
    fileName: string;
    source: string;
}

function docExamples(): DocExample[]
{
    const found: DocExample[] = [];
    for (const file of markdownIn(repoRoot))
    {
        const text = readFileSync(file, 'utf8');
        for (const block of text.matchAll(/```azeroth\r?\n([\s\S]*?)```/g))
        {
            const source = block[1] ?? '';
            const named = /^\/\/\s*(\S+\.azeroth)/m.exec(source);
            if (named === null || !/\bcomponent\s+\w+/.test(source))
            {
                continue;
            }
            found.push({
                where: `${ path.relative(repoRoot, file) } -> ${ named[1] }`,
                fileName: path.join(path.dirname(file), named[1] as string),
                source
            });
        }
    }
    return found;
}

const examples = docExamples();

describe('documented .azeroth examples compile and type-check', () =>
{
    it('finds the complete examples the docs ship', () =>
    {
        expect(examples.length).toBeGreaterThanOrEqual(3);
    });

    for (const example of examples)
    {
        it(`checks ${ example.where }`, () =>
        {
            expect(() => generateModule(example.source)).not.toThrow();
            expect(typeCheckModuleTS(example.source, { fileName: example.fileName })).toEqual([]);
        });
    }
});
