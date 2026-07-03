// Document links: make a relative import specifier in a `.azeroth` file
// clickable, so Ctrl/Cmd-clicking the path jumps to the imported file. Only
// relative specifiers (`./`, `../`, `/`) are linked - bare module specifiers
// (`azerothjs`, `node:path`) have no single on-disk target worth a link,
// and are left to go-to-definition. Each candidate is resolved the way the
// project's module resolver resolves a relative import: the path as written,
// then with `.ts` and `.azeroth` appended (an AzerothJS project is `.ts` +
// `.azeroth`). The link's range covers the specifier text BETWEEN the
// quotes; the target is the resolved file's `file://` URI.

import ts from 'typescript';
import type { DocumentLink } from '../protocol.ts';
import { type RequestContext } from '../request.ts';
import { pathToUri } from '../uri.ts';

/** Extensions tried (in order) when a relative specifier has none of its own. */
const PROBE_EXTENSIONS = ['.ts', '.azeroth'];

/** A relative import/export-from/dynamic-import('...') specifier and its span. */
interface Specifier
{
    /** The text between the quotes (the module specifier). */
    text: string;
    /** Original-source offset of the first character after the opening quote. */
    start: number;
}

/**
 * Clickable links over the relative import specifiers in the document. Scans the
 * source for `from '...'` / `import('...')` specifiers, resolves each relative
 * one to a real file, and emits a link whose range is the specifier string.
 * Bare and unresolvable specifiers are skipped. Never throws.
 */
export function getDocumentLinks(ctx: RequestContext): DocumentLink[]
{
    try
    {
        const dir = ctx.azerothPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
        const out: DocumentLink[] = [];
        for (const spec of scanSpecifiers(ctx.source))
        {
            if (!isRelative(spec.text))
            {
                continue;
            }
            const resolved = resolve(dir, spec.text);
            if (resolved === null)
            {
                continue;
            }
            out.push({
                range: ctx.lineIndex.rangeAt(spec.start, spec.start + spec.text.length),
                target: pathToUri(resolved)
            });
        }
        return out;
    }
    catch
    {
        return [];
    }
}

/** True for a relative specifier (the only kind worth linking to a file). */
function isRelative(text: string): boolean
{
    return text.startsWith('./') || text.startsWith('../') || text.startsWith('/');
}

/**
 * Resolves a relative specifier against `dir` to an existing file, trying the
 * path as written first, then with each probe extension appended - mirroring the
 * project's resolver (`.ts`/`.azeroth`). Returns null when nothing exists.
 */
function resolve(dir: string, text: string): string | null
{
    const base = ts.sys.resolvePath(`${ dir }/${ text }`).replace(/\\/g, '/');
    if (ts.sys.fileExists(base))
    {
        return base;
    }
    for (const ext of PROBE_EXTENSIONS)
    {
        const candidate = `${ base }${ ext }`;
        if (ts.sys.fileExists(candidate))
        {
            return candidate;
        }
    }
    return null;
}

/**
 * Finds every static (`from '...'`) and dynamic (`import('...')`) module
 * specifier in the source. The TS scanner tokenizes the whole file (markup
 * regions are inert string/identifier tokens to it), so a string literal that
 * directly follows a `from` keyword or an `import (` opener is a specifier; its
 * span is the literal minus the surrounding quotes.
 */
function scanSpecifiers(source: string): Specifier[]
{
    // skipTrivia: true so `prev` is the previous SIGNIFICANT token (the `from`
    // keyword / `(` opener sit immediately before the specifier, not whitespace).
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
    const out: Specifier[] = [];
    let prev = ts.SyntaxKind.Unknown;
    let prevPrev = ts.SyntaxKind.Unknown;
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken)
    {
        if (token === ts.SyntaxKind.StringLiteral
            && (prev === ts.SyntaxKind.FromKeyword
                || (prev === ts.SyntaxKind.OpenParenToken && prevPrev === ts.SyntaxKind.ImportKeyword)))
        {
            const text = scanner.getTokenValue();
            // tokenStart points at the opening quote; the value sits one in.
            out.push({ text, start: scanner.getTokenStart() + 1 });
        }
        prevPrev = prev;
        prev = token;
        token = scanner.scan();
    }
    return out;
}
