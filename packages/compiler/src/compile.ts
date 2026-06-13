// Orchestrates the transform of a `.azeroth` module:
//
//   1. Walk the source, skipping non-code, to find each top-level markup
//      region (scanner.findMarkupStart).
//   2. Parse the region into a markup AST (parser.parseMarkup).
//   3. Generate h() / component-call code (codegen.generate), recompiling any
//      nested markup inside `{ ... }` holes by calling back into the hole
//      transform.
//   4. Splice the generated code in place of the region; everything else
//      (imports, types, functions) is left byte-for-byte.
//
// Finally, if markup was emitted and the module doesn't already import `h`,
// prepend the import.

import { findMarkupStart } from './scanner.ts';
import { parseMarkup } from './parser.ts';
import { generate, generateDomRegion, quoteString, walkComponentTags, type ExpressionCompiler } from './codegen.ts';
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
 * Built-in components that markup can use without importing - the compiler
 * injects their import from the runtime. User components are not
 * auto-imported (the author imports those explicitly).
 */
const BUILTIN_COMPONENTS = new Set([
    'Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic',
    'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'
]);

/** Options for compile(). */
export interface CompileOptions
{
    /**
     * Output shape for markup regions.
     *
     * - `'universal'` (default): h() calls - works in DOM, SSR string mode,
     *   and hydration. What the language tooling models.
     * - `'dom'`: template cloning - host-element regions are hoisted as one
     *   HTML template and instantiated with cloneNode, with only the
     *   dynamic parts bound per instance. Each region also carries the
     *   universal h() branch behind a render-mode guard, so SSR and
     *   hydrate() work from the same artifact; the cost is the duplicated
     *   region code. Regions containing components/fragments fall back to
     *   h() alone.
     */
    target?: 'universal' | 'dom';
}

/** Result of compiling a `.azeroth` source string. */
export interface CompileResult
{
    /** The compiled JS/TS source. */
    code: string;

    /** Source map (original `.azeroth` -> compiled), or `null` when the file
     *  contained no markup (output is identical to input). */
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

/**
 * True when the module already imports `name` via a named import.
 *
 * @example
 * ```ts
 * alreadyImports("import { h, For } from 'x';", 'For'); // true
 * alreadyImports("import { h } from 'x';", 'Show');     // false
 * ```
 */
function alreadyImports(source: string, name: string): boolean
{
    return new RegExp(`import\\s*\\{[^}]*\\b${ name }\\b[^}]*\\}\\s*from`).test(source);
}

/**
 * Compiles a `.azeroth` source string: markup -> h() calls, with the `h`
 * import auto-injected when needed.
 *
 * @param source - The `.azeroth` module source
 *
 * @returns The compiled JS/TS and its source map
 *
 * Without compile: author UI as nested h() calls by hand, wrapping every
 * dynamic hole in a getter yourself:
 *
 *     import { h } from '@azerothjs/core';
 *     export default () =>
 *         h('h1', {  }, 'Hello ', () => (name())); // hand-write h() + getters, easy to get wrong
 *
 * With compile: write the markup in a `.azeroth` file and compile() emits the
 * equivalent h() calls (and the `h` import) for you:
 *
 *     const { code } = compile('export default () => <h1>Hello {name()}</h1>;');
 *     // code -> import { h } from '@azerothjs/core'; ... h('h1', {  }, 'Hello ', () => (name()))
 *     // write JSX-like markup; the getters and the import are generated
 *
 * @example
 * ```ts
 * const { code } = compile(`
 *   export default function Hi() {
 *     return <h1>Hello {name()}</h1>;
 *   }
 * `);
 * // code becomes:
 * //   import { h } from '@azerothjs/core';
 * //   export default function Hi() {
 * //     return h('h1', {  }, 'Hello ', () => (name()));
 * //   }
 * ```
 */
export function compile(source: string, filename = 'module.azeroth', options: CompileOptions = {}): CompileResult
{
    const target = options.target ?? 'universal';

    // Built-in components referenced anywhere in the file's markup
    // (including nested inside `{ ... }` holes, thanks to the recursion).
    const usedBuiltins = new Set<string>();

    // Hoisted template HTML (dom target), interned so identical static
    // regions share one template const.
    const templates = new Map<string, string>();
    let usedH = false;
    let usedBindHole = false;
    let usedBindChild = false;
    let usedBindProps = false;
    let usedModeGuard = false;

    const allocateTemplate = (html: string): string =>
    {
        const existing = templates.get(html);
        if (existing !== undefined)
        {
            return existing;
        }
        const name = `_tmpl$${ templates.size + 1 }`;
        templates.set(html, name);
        return name;
    };

    const collect = (node: Parameters<typeof walkComponentTags>[0]): void =>
        walkComponentTags(node, (tag) =>
        {
            if (BUILTIN_COMPONENTS.has(tag))
            {
                usedBuiltins.add(tag);
            }
        });

    // String-based transform for `{ ... }` holes (nested markup). Holes are
    // embedded inside a region's generated string, so they don't get their own
    // source-map pieces - the whole region maps to its start, which is plenty
    // for debugging.
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
            usedH = true;
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

        // dom target: template-clone emission where the region allows it;
        // anything with components/fragments falls back to h().
        let emitted: string | null = null;
        if (target === 'dom')
        {
            const region = generateDomRegion(node, transformHole, allocateTemplate);
            if (region !== null)
            {
                emitted = region.code;
                usedBindHole = usedBindHole || region.usesBindHole;
                usedBindChild = usedBindChild || region.usesBindChild;
                usedBindProps = usedBindProps || region.usesBindProps;
                // The region carries a universal h() branch behind the
                // render-mode guard, so both sets of names are live.
                usedModeGuard = true;
                usedH = true;
            }
        }
        if (emitted === null)
        {
            emitted = generate(node, transformHole);
            usedH = true;
        }

        push(emitted, start, false);
        i = end;
    }

    const hasMarkup = pieces.some(p => !p.verbatim);
    if (!hasMarkup)
    {
        return { code: out, map: null };
    }

    // Auto-inject the runtime names the emission used plus any built-in
    // components, skipping names the source already imports. The universal
    // target keeps its historical "always import h" behavior; the dom
    // target imports only what it emitted.
    const runtimeNames: string[] = [];
    if (target === 'universal' || usedH)
    {
        runtimeNames.push('h');
    }
    if (templates.size > 0)
    {
        runtimeNames.push('tmpl');
    }
    if (usedBindHole)
    {
        runtimeNames.push('bindHole');
    }
    if (usedBindChild)
    {
        runtimeNames.push('bindChild');
    }
    if (usedBindProps)
    {
        runtimeNames.push('bindProps');
    }
    if (usedModeGuard)
    {
        runtimeNames.push('isStringMode', 'isHydrating');
    }
    const names = [...runtimeNames, ...usedBuiltins].filter(name => !alreadyImports(source, name));

    const importLine = names.length > 0
        ? `import { ${ names.join(', ') } } from '${ RUNTIME_MODULE }';\n`
        : '';
    const hoisted = templates.size > 0
        ? [...templates].map(([html, name]) => `const ${ name } = tmpl(${ quoteString(html) });`).join('\n') + '\n'
        : '';
    const prefix = importLine + hoisted;
    const code = prefix + out;

    return { code, map: buildSourceMap(code, prefix.length, pieces, source, filename) };
}

/**
 * Finds the piece whose span contains a given OUTPUT (post-`out`) offset.
 *
 * @example
 * ```ts
 * const pieces = [
 *     { outStart: 0, sourceStart: 0, verbatim: true },
 *     { outStart: 10, sourceStart: 10, verbatim: false }
 * ];
 * findPiece(pieces, 12); // the piece at outStart 10
 * ```
 */
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
 *
 * @example
 * ```ts
 * const map = buildSourceMap(code, prefix.length, pieces, source, 'm.azeroth');
 * map.version;          // 3
 * map.sources;          // ['m.azeroth']
 * map.mappings;         // 'AAAA;AACA;...' (one segment per generated line)
 * ```
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
            // The injected import line(s) map to the top of source.
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
