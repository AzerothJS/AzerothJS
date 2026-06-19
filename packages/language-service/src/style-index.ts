// A workspace-wide index of CSS class selectors, so a `class="..."` (or a
// `classList({ ... })` key, or any string in a `class={ ... }` expression) in a
// `.azeroth` file can complete, hover, and go-to-definition against the classes
// the project actually defines. Two sources are indexed:
//
//   - stylesheet files (`.css`, `.scss`, `.less`, `.sass`) anywhere in the
//     workspace, and
//   - `css`` ` templates embedded in `.azeroth` files (the framework's own
//     scoped-style mechanism).
//
// Selectors are extracted with a small, dependency-free scanner rather than a
// full CSS parse: it masks comments and string contents (so dots inside `url()`
// or comments never count), then reads `.class` tokens only out of *selector*
// position - the text that precedes a `{` - which handles SCSS/LESS nesting
// without needing their grammars. Each file's result is memoized against its
// disk mtime, so an edit to `style.css` is reflected on the next query while an
// unchanged file is never re-read.

import ts from 'typescript';
import { LineIndex } from './text.ts';
import type { Range } from './protocol.ts';
import { cssTemplateSpans } from './providers/css-service.ts';

/** A class selector found in a stylesheet or a css`` template. */
export interface ClassDefinition
{
    /** The class name, without the leading dot. */
    name: string;
    /** Absolute, forward-slash path of the file the class is defined in. */
    file: string;
    /** Range of the class name (dot excluded) within `file`. */
    range: Range;
    /** The selector list the class appeared in (e.g. `.btn:hover, .btn:focus`). */
    selector: string;
    /** Selector + rule body, condensed, for hover display. */
    rule: string;
}

/** Directories never worth scanning for stylesheets. */
const EXCLUDES = ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**', '**/out/**'];

/** Stylesheet extensions indexed for class selectors. */
const STYLE_EXTENSIONS = ['.css', '.scss', '.less', '.sass'];

/** Forward-slash a path so cache keys and URIs agree across platforms. */
function toSlashes(p: string): string
{
    return p.replace(/\\/g, '/');
}

/** Whether `//` line comments apply (SCSS/LESS, but not plain CSS). */
function hasLineComments(file: string): boolean
{
    return /\.(scss|less|sass)$/i.test(file);
}

/**
 * Returns a copy of `text` with comment and string *contents* replaced by
 * spaces, preserving length and newlines so every offset still lines up with
 * the original. Masking first means the selector scan never trips over a dot
 * inside `url(http://x)`, a quoted value, or a comment.
 */
function maskCommentsAndStrings(text: string, lineComments: boolean): string
{
    const out = text.split('');
    let i = 0;
    const blank = (from: number, to: number): void =>
    {
        for (let k = from; k < to && k < out.length; k++)
        {
            if (out[k] !== '\n' && out[k] !== '\r')
            {
                out[k] = ' ';
            }
        }
    };
    while (i < text.length)
    {
        const ch = text[i];
        if (ch === '/' && text[i + 1] === '*')
        {
            const end = text.indexOf('*/', i + 2);
            const to = end === -1 ? text.length : end + 2;
            blank(i, to);
            i = to;
            continue;
        }
        if (lineComments && ch === '/' && text[i + 1] === '/')
        {
            let end = text.indexOf('\n', i);
            if (end === -1)
            {
                end = text.length;
            }
            blank(i, end);
            i = end;
            continue;
        }
        if (ch === '"' || ch === '\'')
        {
            let j = i + 1;
            while (j < text.length && text[j] !== ch)
            {
                if (text[j] === '\\')
                {
                    j++;
                }
                j++;
            }
            blank(i + 1, j);
            i = j + 1;
            continue;
        }
        i++;
    }
    return out.join('');
}

/** Matches a class token (`.name`); group 1 is the name, dot excluded. */
const CLASS_TOKEN = /\.(-?[_a-zA-Z][\w-]*)/g;

/**
 * Extracts every class selector from CSS `text` whose content begins at
 * `baseOffset` in its file. `lineComments` enables `//` comment stripping for
 * SCSS/LESS. Reads `.class` tokens only out of selector lists (runs of text
 * terminated by `{`), so declaration values and nested-rule bodies are skipped
 * while nested selectors are still picked up.
 */
function extractClasses(text: string, baseOffset: number, lineComments: boolean, lineIndex: LineIndex, file: string): ClassDefinition[]
{
    const masked = maskCommentsAndStrings(text, lineComments);
    const defs: ClassDefinition[] = [];
    let segmentStart = 0;
    for (let i = 0; i < masked.length; i++)
    {
        const ch = masked[i];
        // A selector list is the text before a `{`; `;` ends a declaration and
        // `}` ends a block - both reset the segment without yielding selectors.
        if (ch === ';' || ch === '}')
        {
            segmentStart = i + 1;
            continue;
        }
        if (ch !== '{')
        {
            continue;
        }
        const selectorText = masked.slice(segmentStart, i);
        const selectorRaw = text.slice(segmentStart, i).trim();
        const rule = condenseRule(text, masked, segmentStart, i);
        CLASS_TOKEN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CLASS_TOKEN.exec(selectorText)) !== null)
        {
            const nameStart = baseOffset + segmentStart + match.index + 1;
            const nameEnd = nameStart + match[1].length;
            defs.push({
                name: match[1],
                file,
                range: lineIndex.rangeAt(nameStart, nameEnd),
                selector: selectorRaw,
                rule
            });
        }
        segmentStart = i + 1;
    }
    return defs;
}

/**
 * Builds a condensed `selector { ... }` string for hover, from the selector at
 * `[segmentStart, brace)` and the block body that follows. The matching close
 * brace is found over the masked text so braces in strings/comments don't fool
 * the depth count; the displayed text comes from the original.
 */
function condenseRule(text: string, masked: string, segmentStart: number, brace: number): string
{
    let depth = 0;
    let close = masked.length;
    for (let k = brace; k < masked.length; k++)
    {
        if (masked[k] === '{')
        {
            depth++;
        }
        else if (masked[k] === '}')
        {
            depth--;
            if (depth === 0)
            {
                close = k + 1;
                break;
            }
        }
    }
    const raw = text.slice(segmentStart, close).trim();
    const condensed = raw.replace(/\s+/g, ' ');
    return condensed.length > 600 ? `${ condensed.slice(0, 600) } …` : condensed;
}

/** Per-file memoization: the parsed classes and the mtime they were read at. */
interface FileEntry
{
    mtime: string;
    defs: ClassDefinition[];
}

/**
 * A workspace's CSS class index. One per {@link AzerothProject}. Discovery (the
 * directory walk) runs once and on {@link refresh}; individual files are re-read
 * only when their mtime changes, so repeated completion queries are cheap.
 */
export class StyleIndex
{
    private files: string[] | null = null;

    private readonly cache = new Map<string, FileEntry>();

    constructor(private readonly workspaceDirectory: string)
    {
    }

    /** Re-discovers the stylesheet/`.azeroth` file set (call on create/delete). */
    public refresh(): void
    {
        this.files = null;
    }

    /** Forgets a single file's cached classes (call on its change/delete). */
    public invalidate(filePath: string): void
    {
        this.cache.delete(toSlashes(filePath));
    }

    /** Every class definition currently known across the workspace. */
    public all(): ClassDefinition[]
    {
        const files = this.discover();
        // Prune cache entries for files that have since disappeared so the map
        // can't grow without bound across a long-lived session.
        const live = new Set(files);
        for (const key of this.cache.keys())
        {
            if (!live.has(key))
            {
                this.cache.delete(key);
            }
        }
        const out: ClassDefinition[] = [];
        for (const file of files)
        {
            out.push(...this.entry(file));
        }
        return out;
    }

    /** All definitions of a given class name (may span several files/rules). */
    public byName(name: string): ClassDefinition[]
    {
        return this.all().filter(def => def.name === name);
    }

    /** Unique class names, each paired with one representative definition. */
    public unique(): ClassDefinition[]
    {
        const seen = new Map<string, ClassDefinition>();
        for (const def of this.all())
        {
            if (!seen.has(def.name))
            {
                seen.set(def.name, def);
            }
        }
        return [...seen.values()];
    }

    /** The discovered file list, scanned lazily and cached until `refresh`. */
    private discover(): string[]
    {
        if (this.files !== null)
        {
            return this.files;
        }
        try
        {
            const styles = ts.sys.readDirectory(this.workspaceDirectory, STYLE_EXTENSIONS, EXCLUDES, ['**/*']);
            const azeroth = ts.sys.readDirectory(this.workspaceDirectory, ['.azeroth'], EXCLUDES, ['**/*.azeroth']);
            this.files = [...styles, ...azeroth].map(toSlashes);
        }
        catch
        {
            this.files = [];
        }
        return this.files;
    }

    /** Class definitions for one file, re-read only when its mtime changed. */
    private entry(file: string): ClassDefinition[]
    {
        const mtime = String(ts.sys.getModifiedTime?.(file)?.getTime() ?? 0);
        const cached = this.cache.get(file);
        if (cached && cached.mtime === mtime)
        {
            return cached.defs;
        }
        const defs = this.read(file);
        this.cache.set(file, { mtime, defs });
        return defs;
    }

    /** Reads and parses one file into class definitions. */
    private read(file: string): ClassDefinition[]
    {
        const text = ts.sys.readFile(file);
        if (text === undefined)
        {
            return [];
        }
        const lineIndex = new LineIndex(text);
        if (file.endsWith('.azeroth'))
        {
            // Index only the css`` templates inside; the markup's own class="..."
            // is a *use*, not a definition.
            const defs: ClassDefinition[] = [];
            for (const span of cssTemplateSpans(text))
            {
                defs.push(...extractClasses(text.slice(span.start, span.end), span.start, true, lineIndex, file));
            }
            return defs;
        }
        return extractClasses(text, 0, hasLineComments(file), lineIndex, file);
    }
}
