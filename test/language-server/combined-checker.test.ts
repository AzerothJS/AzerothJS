// azeroth-tsc is a combined `.ts` + `.azeroth` checker (the vue-tsc equivalent):
// ONE program with both the project's real `.ts` files and the `.azeroth` virtual
// modules. This is what lets a consumer delete its `declare module '*.azeroth'`
// shim - a `.ts` barrel importing a `.azeroth` component resolves the real
// default / named / type exports, and a cross-file type error still reports.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { runTsc } from '../../packages/language-server/src/tsc.ts';

const FIX = path.join(process.cwd(), 'test', 'language-server', 'fixtures', 'combined');

function check(): { output: string; errorCount: number; fileCount: number }
{
    const out: string[] = [];
    const result = runTsc({ cwd: FIX, write: (t) => out.push(t) });
    return { output: out.join(''), ...result };
}

describe('azeroth-tsc combined .ts + .azeroth checker', () =>
{
    it('checks both the .ts and the .azeroth side in one program', () =>
    {
        const { output, fileCount } = check();
        // modal.component.azeroth + uses.azeroth (.azeroth) and index.ts (.ts).
        expect(fileCount).toBeGreaterThanOrEqual(3);
        expect(output).toMatch(/\.azeroth/);
        expect(output).toMatch(/\.ts\b/);
    });

    it('resolves a .ts barrel\'s default, named, and type imports from .azeroth (no shim present)', () =>
    {
        // index.ts re-exports default/named/type from the .azeroth component and
        // uses them (ModalProps, MODAL_KIND, default Modal). With real resolution
        // and no `declare module '*.azeroth'` shim, this is clean.
        expect(check().errorCount).toBe(0);
    });

    it('reports a genuine cross-file type error at the original .ts position', () =>
    {
        const indexPath = path.join(FIX, 'index.ts');
        const original = readFileSync(indexPath, 'utf8');
        try
        {
            // Assign a number to a field typed `string` by the .azeroth component.
            writeFileSync(indexPath, original.replace("title: 'Hi'", 'title: 123'));
            const { output, errorCount } = check();
            expect(errorCount).toBeGreaterThan(0);
            expect(output).toMatch(/index\.ts\(\d+,\d+\): error TS2322:/);
            expect(output).toContain('not assignable to type \'string\'');
        }
        finally
        {
            writeFileSync(indexPath, original);
        }
    });

    // Item 3: a component tag is type-checked against the component's REAL props
    // (the tag lowers to `Modal({...})` checked against ModalProps). Each case
    // edits the tag in uses.azeroth and asserts the error surfaces on the markup.
    function tagError(replacement: string): { output: string; errorCount: number }
    {
        const usesPath = path.join(FIX, 'uses.azeroth');
        const original = readFileSync(usesPath, 'utf8');
        try
        {
            writeFileSync(usesPath, original.replace('<Modal title="hi" open={() => true} />', replacement));
            return check();
        }
        finally
        {
            writeFileSync(usesPath, original);
        }
    }

    it('errors on an unknown prop on a component tag', () =>
    {
        const { output, errorCount } = tagError('<Modal title="hi" open={() => true} bogusProp={1} />');
        expect(errorCount).toBeGreaterThan(0);
        expect(output).toMatch(/uses\.azeroth/);
        expect(output).toContain('bogusProp');
    });

    it('errors on a missing REQUIRED prop on a component tag (anchored to the tag)', () =>
    {
        const { output, errorCount } = tagError('<Modal title="hi" />');
        expect(errorCount).toBeGreaterThan(0);
        expect(output).toMatch(/uses\.azeroth/);
        expect(output).toContain('open');
    });

    it('errors on a wrong-typed prop value on a component tag', () =>
    {
        const { output, errorCount } = tagError('<Modal title={() => 5} open={() => true} />');
        expect(errorCount).toBeGreaterThan(0);
        expect(output).toMatch(/uses\.azeroth/);
        expect(output).toContain('not assignable');
    });
});
