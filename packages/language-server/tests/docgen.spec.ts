// @vitest-environment node
//
// azeroth-docgen driver: parseArgs must map the CLI surface onto DocgenOptions,
// and runDocgen must document a real on-disk component in all three output
// modes - stdout stream, `--out` markdown files, and `--out --html` static
// site - through the injectable write/writeFile sinks, so no test touches disk.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { parseArgs, runDocgen, type DocgenOptions } from '../src/docgen-cli.ts';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'app');

/** Documents the fixture app, capturing stdout and would-be file writes. */
function run(extra: Partial<DocgenOptions>): { stdout: string; files: Map<string, string>; fileCount: number }
{
    const chunks: string[] = [];
    const files = new Map<string, string>();
    const write = (text: string): void =>
    {
        chunks.push(text);
    };
    const writeFile = (filePath: string, content: string): void =>
    {
        files.set(path.basename(filePath), content);
    };
    const { fileCount } = runDocgen({ cwd: appDir, project: path.join(appDir, 'tsconfig.json'), write, writeFile, ...extra });
    return { stdout: chunks.join(''), files, fileCount };
}

describe('parseArgs', () =>
{
    it('parses --out in all three spellings, --html, --project and the positional cwd', () =>
    {
        expect(parseArgs(['--out', 'docs']).out).toBe('docs');
        expect(parseArgs(['-o', 'docs']).out).toBe('docs');
        expect(parseArgs(['--out=docs']).out).toBe('docs');
        expect(parseArgs(['--html']).html).toBe(true);
        expect(parseArgs(['--project=app/tsconfig.json']).project).toBe('app/tsconfig.json');
        expect(parseArgs(['some/dir']).cwd).toBe('some/dir');
    });
});

describe('runDocgen', () =>
{
    it('streams markdown to stdout under a per-file header when --out is absent', () =>
    {
        const { stdout, files, fileCount } = run({});
        expect(fileCount).toBe(1);
        expect(files.size).toBe(0);
        expect(stdout).toContain('<!-- file: Widget.azeroth -->');
        expect(stdout).toContain('# Widget');
        expect(stdout).toContain('## Props');
        expect(stdout).toContain('| label | string | No |');
        expect(stdout).toContain('| amount | number \\| undefined | Yes |');
    });

    it('writes one .md per component through the sink without touching disk', () =>
    {
        const { stdout, files } = run({ out: 'docs' });
        expect([...files.keys()]).toEqual(['Widget.md']);
        expect(files.get('Widget.md')).toContain('# Widget');
        expect(stdout).toContain('Wrote 1 doc(s) to docs.');
        // The writeFile sink must also suppress the output directory itself.
        expect(existsSync(path.join(appDir, 'docs'))).toBe(false);
    });

    it('emits a per-component HTML page plus a linking index with --html', () =>
    {
        const { files } = run({ out: 'site', html: true });
        expect(new Set(files.keys())).toEqual(new Set(['Widget.html', 'index.html']));
        expect(files.get('Widget.html')).toContain('<h1>Widget</h1>');
        expect(files.get('Widget.html')).toContain('<table>');
        expect(files.get('index.html')).toContain('<a href="Widget.html">Widget</a>');
        expect(existsSync(path.join(appDir, 'site'))).toBe(false);
    });
});
