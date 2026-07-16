#!/usr/bin/env node
// azeroth-docgen: renders a markdown API reference for every `.azeroth`
// component under a directory. It builds the same combined program azeroth-tsc
// uses (so prop types resolve against the project's REAL tsconfig types), opens
// each file in the language service, and asks the docgen module for that file's
// markdown. With no `--out` the docs print to stdout under a per-file header; an
// `--out` directory writes one `.md` per component instead. The heavy lifting
// lives in the testable `runDocgen`; the bin shim is a thin argv parse.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

import ts from 'typescript';

import { AzerothLanguageService, generateComponentDocs, pathToUri } from '@azerothjs/language-service';

/** Options controlling a single docgen run. */
export interface DocgenOptions
{
    /** Directory to search for `.azeroth` files (default: cwd). */
    cwd?: string;

    /** Explicit tsconfig path; otherwise the nearest one is used. */
    project?: string;

    /** Directory to write one `.md` per component into; omitted -> stdout. */
    out?: string;

    /** With `--out`, emit a browsable static HTML site instead of `.md` files. */
    html?: boolean;

    /** Sink for stdout output (default: process.stdout). */
    write?: (text: string) => void;

    /**
     * Sink for files the run would write, keyed by absolute path. When given, the
     * run captures content here instead of touching disk (so tests need no temp
     * dir); omitted -> real {@link writeFileSync}.
     */
    writeFile?: (filePath: string, content: string) => void;
}

/** Outcome of a docgen run. */
export interface DocgenResult
{
    /** Number of `.azeroth` files documented. */
    fileCount: number;
}

/** Parses the argv subset this CLI understands into {@link DocgenOptions}. */
export function parseArgs(argv: string[]): DocgenOptions
{
    const options: DocgenOptions = {};
    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        if (arg === undefined)
        {
            continue;
        }
        if (arg === '--project' || arg === '-p')
        {
            options.project = argv[++i] ?? '';
        }
        else if (arg.startsWith('--project='))
        {
            options.project = arg.slice('--project='.length);
        }
        else if (arg === '--out' || arg === '-o')
        {
            options.out = argv[++i] ?? '';
        }
        else if (arg.startsWith('--out='))
        {
            options.out = arg.slice('--out='.length);
        }
        else if (arg === '--html')
        {
            options.html = true;
        }
        else if (!arg.startsWith('-'))
        {
            options.cwd = arg;
        }
    }
    return options;
}

/**
 * Documents every `.azeroth` file under `cwd`. With no `--out` the markdown is
 * printed to stdout, each file under a `<!-- file: rel/path -->` header; with
 * `--out` one `.md` per component is written there instead. Returns the file
 * count; the caller decides the process exit code.
 *
 * @example
 * ```ts
 * const { fileCount } = runDocgen({ cwd: 'app', out: 'docs' });
 * ```
 */
export function runDocgen(options: DocgenOptions = {}): DocgenResult
{
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const write = options.write ?? ((text: string): void =>
    {
        process.stdout.write(text);
    });
    const writeFile = options.writeFile ?? ((filePath: string, content: string): void =>
    {
        writeFileSync(filePath, content);
    });

    // rootProjectFiles: pull the project's real `.ts` files into the same
    // program as the `.azeroth` virtual modules, so prop types that reference
    // `.ts`-declared types resolve to real types rather than `any`.
    const service = new AzerothLanguageService(cwd, options.project, { rootProjectFiles: true });

    const files = ts.sys.readDirectory(
        cwd,
        ['.azeroth'],
        ['**/node_modules/**', '**/dist/**', '**/.git/**'],
        ['**/*.azeroth']
    );

    const outDir = options.out ? path.resolve(cwd, options.out) : undefined;
    // Only create the directory for real disk writes; a `writeFile` sink (tests)
    // captures content in memory and must not leave an empty dir behind.
    if (outDir && !options.writeFile)
    {
        mkdirSync(outDir, { recursive: true });
    }

    // pages: collected only for the HTML index, so it links every component page.
    const pages: { name: string; file: string }[] = [];

    let fileCount = 0;
    for (const file of files)
    {
        const source = ts.sys.readFile(file);
        if (source === undefined)
        {
            continue;
        }
        const uri = pathToUri(file);
        service.didOpen(uri, source);

        const markdown = generateComponentDocs(service, uri);
        fileCount++;

        if (outDir && options.html)
        {
            const base = path.basename(file).replace(/\.azeroth$/, '');
            writeFile(path.join(outDir, `${ base }.html`), renderHtmlPage(markdown));
            pages.push({ name: componentName(markdown) ?? base, file: `${ base }.html` });
        }
        else if (outDir)
        {
            const base = path.basename(file).replace(/\.azeroth$/, '');
            writeFile(path.join(outDir, `${ base }.md`), markdown);
        }
        else
        {
            const rel = path.relative(cwd, file).replace(/\\/g, '/');
            write(`<!-- file: ${ rel } -->\n${ markdown }\n`);
        }
    }

    if (outDir && options.html)
    {
        writeFile(path.join(outDir, 'index.html'), renderHtmlIndex(pages));
    }

    if (outDir)
    {
        const rel = path.relative(cwd, outDir).replace(/\\/g, '/') || '.';
        write(`Wrote ${ fileCount } doc(s) to ${ rel }.\n`);
    }

    return { fileCount };
}

/** The h1 text (`# Name`) of a docgen markdown block, or null when absent. */
function componentName(markdown: string): string | null
{
    const match = markdown.match(/^# (.+)$/m);
    return match?.[1]?.trim() ?? null;
}

/**
 * Converts ONE docgen markdown block to an HTML body fragment. This is not a
 * general markdown parser: docgen's output is a known, narrow shape (`# h1`, an
 * optional paragraph, a `## Props` h2, then either a sentence or a GFM pipe
 * table), so a line walk over those exact forms is enough - and keeps the CLI
 * dependency-free.
 */
function markdownToHtml(markdown: string): string
{
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const html: string[] = [];

    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        if (line === undefined || line === '')
        {
            continue;
        }
        if (line.startsWith('# '))
        {
            html.push(`<h1>${ inline(line.slice(2)) }</h1>`);
        }
        else if (line.startsWith('## '))
        {
            html.push(`<h2>${ inline(line.slice(3)) }</h2>`);
        }
        else if (isTableRow(line) && isSeparatorRow(lines[i + 1] ?? ''))
        {
            // A GFM table: this header row, the separator we just matched, then
            // every following pipe row until the block ends.
            const header = tableCells(line);
            const rows: string[][] = [];
            i += 2;
            for (; i < lines.length && isTableRow(lines[i] ?? ''); i++)
            {
                rows.push(tableCells(lines[i] ?? ''));
            }
            i--;
            html.push(renderTable(header, rows));
        }
        else
        {
            html.push(`<p>${ inline(line) }</p>`);
        }
    }

    return html.join('\n');
}

/** True for a line that is a pipe-delimited table row. */
function isTableRow(line: string): boolean
{
    return /^\s*\|.*\|\s*$/.test(line);
}

/** True for a GFM header separator row (`| --- | --- |`). */
function isSeparatorRow(line: string): boolean
{
    return isTableRow(line) && /^[\s|:-]+$/.test(line);
}

/** Splits a `| a | b |` row into its trimmed inner cells. */
function tableCells(line: string): string[]
{
    return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

/** Renders a header row + body rows as an HTML `<table>`. */
function renderTable(header: string[], rows: string[][]): string
{
    const head = header.map(cell => `<th>${ inline(cell) }</th>`).join('');
    const body = rows
        .map(row => `<tr>${ row.map(cell => `<td>${ inline(cell) }</td>`).join('') }</tr>`)
        .join('\n');
    return `<table>\n<thead><tr>${ head }</tr></thead>\n<tbody>\n${ body }\n</tbody>\n</table>`;
}

/**
 * Renders docgen's inline markdown - `code` and `**bold**` - to HTML, escaping
 * everything else. Backticks bind first so a `**` inside code stays literal.
 */
function inline(text: string): string
{
    const parts = text.split(/(`[^`]*`)/);
    return parts
        .map(part =>
        {
            if (part.startsWith('`') && part.endsWith('`') && part.length >= 2)
            {
                return `<code>${ escapeHtml(part.slice(1, -1)) }</code>`;
            }
            return escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        })
        .join('');
}

/** Escapes the five characters that are unsafe in HTML text/attributes. */
function escapeHtml(text: string): string
{
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** The shared inline stylesheet for every generated page. */
const PAGE_STYLE =
    'body{font:16px/1.6 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#1b1b1f}'
    + 'h1{border-bottom:1px solid #ddd;padding-bottom:.3rem}'
    + 'table{border-collapse:collapse;width:100%}'
    + 'th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}'
    + 'th{background:#f6f6f7}'
    + 'code{background:#f0f0f2;padding:.1rem .3rem;border-radius:3px;font-size:.9em}'
    + 'a{color:#3056d3}';

/** Wraps an HTML body fragment in a minimal styled standalone page. */
function htmlDocument(title: string, body: string): string
{
    return '<!DOCTYPE html>\n'
        + '<html lang="en">\n'
        + '<head>\n'
        + '<meta charset="utf-8">\n'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        + `<title>${ escapeHtml(title) }</title>\n`
        + `<style>${ PAGE_STYLE }</style>\n`
        + '</head>\n'
        + `<body>\n${ body }\n</body>\n`
        + '</html>\n';
}

/** Renders one component's docgen markdown as a full HTML page. */
function renderHtmlPage(markdown: string): string
{
    return htmlDocument(componentName(markdown) ?? 'Component', markdownToHtml(markdown));
}

/** Renders the site landing page linking every component page. */
function renderHtmlIndex(pages: { name: string; file: string }[]): string
{
    const items = pages
        .map(page => `<li><a href="${ escapeHtml(page.file) }">${ escapeHtml(page.name) }</a></li>`)
        .join('\n');
    const body = `<h1>API Reference</h1>\n<ul>\n${ items }\n</ul>`;
    return htmlDocument('API Reference', body);
}

// Bin entry: only when this module is the process's launched script (not when
// it is imported for `runDocgen`). All behaviour lives in the testable
// `runDocgen` above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
{
    runDocgen(parseArgs(process.argv.slice(2)));
}
