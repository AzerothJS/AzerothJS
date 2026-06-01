// ============================================================================
// AZEROTHJS COMPILER — compile()
// ============================================================================
//
// Orchestrates the transform of a `.azeroth` module:
//
//   1. Walk the source, skipping non-code, to find each top-level
//      markup region (scanner.findMarkupStart).
//   2. Parse the region into a markup AST (parser.parseMarkup).
//   3. Generate `h()` / component-call code (codegen.generate),
//      recompiling any nested markup inside `{ … }` holes by calling
//      back into `transform`.
//   4. Splice the generated code in place of the region; everything
//      else (imports, types, functions) is left byte-for-byte.
//
// Finally, if markup was emitted and the module doesn't already
// import `h`, prepend the import.
//
// ============================================================================

import { findMarkupStart } from './scanner.ts';
import { parseMarkup } from './parser.ts';
import { generate, walkComponentTags, type ExpressionCompiler } from './codegen.ts';
import {
    buildLineStarts,
    locationFor,
    encodeMappings,
    type SourceMapV3,
    type RawSegment
} from './sourcemap.ts';

/** Default module the auto-injected imports point at. */
const RUNTIME_MODULE = '@azerothjs/core';

/**
 * Built-in components that markup can use without importing — the
 * compiler injects their import from the runtime. User components
 * are NOT auto-imported (the author imports those explicitly).
 */
const BUILTIN_COMPONENTS = new Set([
    'Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic',
    'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'
]);

/** Result of compiling a `.azeroth` source string. */
export interface CompileResult
{
    /** The compiled JS/TS source. */
    code: string;

    /** Source map (original `.azeroth` → compiled), or `null` when
     *  the file contained no markup (output is identical to input). */
    map: SourceMapV3 | null;
}

/**
 * A contiguous slice of output and where it came from. `verbatim`
 * pieces are 1:1 with the source; generated pieces (compiled markup)
 * all map to the region's start.
 *
 * @internal
 */
interface Piece
{
    outStart: number;
    sourceStart: number;
    verbatim: boolean;
}

/** True when the module already imports `name` via a named import. */
function alreadyImports(source: string, name: string): boolean
{
    return new RegExp(`import\\s*\\{[^}]*\\b${ name }\\b[^}]*\\}\\s*from`).test(source);
}

/**
 * Compiles a `.azeroth` source string: markup → `h()` calls, with
 * the `h` import auto-injected when needed.
 *
 * @param source - The `.azeroth` module source
 *
 * @returns `{ code }` — the compiled JS/TS
 *
 * @example
 * ```ts
 * const { code } = compile(`
 *   export default function Hi() {
 *     return <h1>Hello {name()}</h1>;
 *   }
 * `);
 * // code →
 * //   import { h } from '@azerothjs/core';
 * //   export default function Hi() {
 * //     return h('h1', {  }, 'Hello ', () => (name()));
 * //   }
 * ```
 */
export function compile(source: string, filename = 'module.azeroth'): CompileResult
{
    // Built-in components referenced anywhere in the file's markup
    // (including nested inside `{ … }` holes, thanks to the recursion).
    const usedBuiltins = new Set<string>();

    const collect = (node: Parameters<typeof walkComponentTags>[0]): void =>
        walkComponentTags(node, (tag) =>
        {
            if (BUILTIN_COMPONENTS.has(tag))
            {
                usedBuiltins.add(tag);
            }
        });

    // String-based transform for `{ … }` holes (nested markup). Holes
    // are embedded inside a region's generated string, so they don't
    // get their own source-map pieces — the whole region maps to its
    // start, which is plenty for debugging.
    const transformHole: ExpressionCompiler = (input: string): string =>
    {
        let result = '';
        let j = 0;
        for (;;)
        {
            const start = findMarkupStart(input, j);
            if (start === -1)
            {
                result += input.slice(j);
                break;
            }
            result += input.slice(j, start);
            const { node, end } = parseMarkup(input, start);
            collect(node);
            result += generate(node, transformHole);
            j = end;
        }
        return result;
    };

    // Top-level assembly, tracking pieces for the source map.
    const pieces: Piece[] = [];
    let out = '';
    const push = (text: string, sourceStart: number, verbatim: boolean): void =>
    {
        pieces.push({ outStart: out.length, sourceStart, verbatim });
        out += text;
    };

    let i = 0;
    for (;;)
    {
        const start = findMarkupStart(source, i);
        if (start === -1)
        {
            push(source.slice(i), i, true);
            break;
        }
        if (start > i)
        {
            push(source.slice(i, start), i, true);
        }
        const { node, end } = parseMarkup(source, start);
        collect(node);
        push(generate(node, transformHole), start, false);
        i = end;
    }

    const hasMarkup = pieces.some(p => !p.verbatim);
    if (!hasMarkup)
    {
        return { code: out, map: null };
    }

    // Auto-inject `h` plus any built-in components the markup used,
    // skipping names the source already imports.
    const names = ['h', ...usedBuiltins].filter(name => !alreadyImports(source, name));
    const prefix = names.length > 0
        ? `import { ${ names.join(', ') } } from '${ RUNTIME_MODULE }';\n`
        : '';
    const code = prefix + out;

    return { code, map: buildSourceMap(code, prefix.length, pieces, source, filename) };
}

/** Finds the piece whose span contains a given OUTPUT (post-`out`) offset. */
function findPiece(pieces: Piece[], outOffset: number): Piece
{
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi)
    {
        const mid = (lo + hi + 1) >> 1;
        if (pieces[mid].outStart <= outOffset)
        {
            lo = mid;
        }
        else
        {
            hi = mid - 1;
        }
    }
    return pieces[lo];
}

/**
 * Builds a line-level source map: one segment per generated line.
 * `prefixLen` accounts for the prepended import line(s), which map
 * to the top of the source.
 *
 * @internal
 */
function buildSourceMap(
    code: string,
    prefixLen: number,
    pieces: Piece[],
    source: string,
    filename: string
): SourceMapV3
{
    const sourceLineStarts = buildLineStarts(source);
    const codeLineStarts = buildLineStarts(code);
    const lines: RawSegment[][] = [];

    for (const codeOffset of codeLineStarts)
    {
        if (codeOffset < prefixLen)
        {
            // The injected import line(s) → map to the top of source.
            lines.push([{ genColumn: 0, sourceLine: 0, sourceColumn: 0 }]);
            continue;
        }
        const outOffset = codeOffset - prefixLen;
        const piece = findPiece(pieces, outOffset);
        const sourceOffset = piece.verbatim
            ? piece.sourceStart + (outOffset - piece.outStart)
            : piece.sourceStart;
        const loc = locationFor(sourceOffset, sourceLineStarts);
        lines.push([{ genColumn: 0, sourceLine: loc.line, sourceColumn: loc.column }]);
    }

    return {
        version: 3,
        sources: [filename],
        sourcesContent: [source],
        names: [],
        mappings: encodeMappings(lines)
    };
}
