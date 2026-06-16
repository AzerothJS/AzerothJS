// azeroth-docgen batch-renders a markdown API reference for every `.azeroth`
// component under a directory, reading prop types from the project's real
// tsconfig types (the same combined program azeroth-tsc builds). With no
// `--out` it prints to stdout under a per-file header.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runDocgen, parseArgs } from '../../packages/language-server/src/docgen-cli.ts';

const FIXTURES = path.join(process.cwd(), 'test', 'language-server', 'fixtures');

function generate(fixture: string): { output: string; fileCount: number }
{
    const out: string[] = [];
    const result = runDocgen({ cwd: path.join(FIXTURES, fixture), write: (t) => out.push(t) });
    return { output: out.join(''), ...result };
}

describe('azeroth-docgen', () =>
{
    it('emits markdown with the component name and its props', () =>
    {
        const { output, fileCount } = generate('combined');
        // Two `.azeroth` files under the fixture (the Modal component + a consumer).
        expect(fileCount).toBe(2);
        expect(output).toContain('# Modal');
        // The props table is read from Modal's real props type.
        expect(output).toContain('| title |');
        // Each file prints under a relative-path header in stdout mode.
        expect(output).toContain('<!-- file: modal.component.azeroth -->');
    });

    it('parses --project, --out, --html, and a positional cwd', () =>
    {
        expect(parseArgs(['--project', 'a/tsconfig.json', 'src'])).toEqual({ project: 'a/tsconfig.json', cwd: 'src' });
        expect(parseArgs(['--out', 'docs'])).toEqual({ out: 'docs' });
        expect(parseArgs(['-o', 'docs'])).toEqual({ out: 'docs' });
        expect(parseArgs(['--out=docs'])).toEqual({ out: 'docs' });
        expect(parseArgs(['--out', 'site', '--html'])).toEqual({ out: 'site', html: true });
        expect(parseArgs(['app'])).toEqual({ cwd: 'app' });
    });

    it('--html writes a static site: an index linking each component and per-component pages', () =>
    {
        const written = new Map<string, string>();
        const result = runDocgen({
            cwd: path.join(FIXTURES, 'combined'),
            out: 'site',
            html: true,
            writeFile: (filePath, content) => written.set(path.basename(filePath), content)
        });
        expect(result.fileCount).toBe(2);

        const index = written.get('index.html');
        expect(index).toBeDefined();
        // The landing page links the Modal component's page.
        expect(index).toContain('<a href="modal.component.html">Modal</a>');

        const modal = written.get('modal.component.html');
        expect(modal).toBeDefined();
        // The component page carries an <h1> with the name and an HTML props table.
        expect(modal).toContain('<h1>Modal</h1>');
        expect(modal).toContain('<table>');
        expect(modal).toContain('<td>title</td>');
    });
});
