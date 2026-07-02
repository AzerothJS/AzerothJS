/**
 * MODULE: compiler/declarations - emits a `.d.ts` for an `.azeroth` module.
 *
 * TypeScript has no resolver for `.azeroth` files: a `.ts` file that imports `./X.component` cannot see
 * the component's type, so `tsc` and editors report "Cannot find module './X.component'". This emitter
 * produces a sibling `X.component.d.ts` declaring the module's public surface - every exported component
 * as a typed function, plus the exported types - so plain TypeScript resolves and type-checks `.azeroth`
 * imports from ordinary `.ts` files.
 *
 * It does NOT re-implement any lowering: it runs the SINGLE {@link generateVirtualCode} projection (the
 * same one the type checker and language service use) and hands the resulting TypeScript to TypeScript's
 * own DECLARATION EMIT. The projection lowers each component to `export [default] function Name(props: P)
 * { ...; return (markup); }`, so declaration emit infers the real `HTMLElement` return type and the exact
 * prop types, and drops the bodies (and the non-exported helpers/ambient runtime declarations) for free.
 */

import * as ts from 'typescript';

import { generateVirtualCode } from './project.ts';
import { buildLineStarts, decodeMappings, encodeMappings, locationFor, type RawSegment } from './sourcemap.ts';

const DECL_OPTIONS: ts.CompilerOptions =
{
    target: ts.ScriptTarget.ESNext,
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
    declaration: true,
    declarationMap: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    noLib: false,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext
};

// The lib `.d.ts` files are large and immutable; reusing one parsed SourceFile across every emit removes
// the dominant per-file cost (mirrors what the type-check backend does).
const LIB_DIR = ts.getDefaultLibFilePath(DECL_OPTIONS).replace(/[\\/][^\\/]*$/, '');
const libSourceCache = new Map<string, ts.SourceFile>();

function normalizeSlashes(p: string): string
{
    return p.replace(/\\/g, '/');
}

/** A declaration file plus its source map, remapped so positions point into the `.azeroth` SOURCE. */
export interface DeclarationOutput
{
    /** The `.d.ts` text (no sourceMappingURL comment; the writer appends one if it writes the map). */
    dts: string;

    /**
     * The version-3 declaration map as an object, or null when TypeScript emitted none. Its
     * `sources` is the absolute `.azeroth` path - relativize it against the map's final location
     * before writing. Positions point into the `.azeroth` SOURCE (already translated from the
     * projection through its {@link generateVirtualCode} CodeMapping), so an editor following the
     * map lands on the real component declaration, not the generated projection.
     */
    map: { version: 3; file: string; sources: string[]; names: never[]; mappings: string } | null;
}

/**
 * emitDeclarations
 *
 * Produces the `.d.ts` text declaring an `.azeroth` module's public surface. Relative and package imports
 * resolve against `fileName`'s directory, so the emitted declarations reference the same types the source
 * does.
 *
 * @param source - The `.azeroth` module source.
 * @param fileName - The module's real path (its directory anchors import resolution).
 * @returns The declaration-file text, ready to write beside the source as `<name>.d.ts`.
 */
export function emitDeclarations(source: string, fileName: string): string
{
    return emitDeclarationsWithMap(source, fileName).dts;
}

/**
 * emitDeclarationsWithMap
 *
 * Like {@link emitDeclarations}, but also returns TypeScript's declaration map REMAPPED to the
 * `.azeroth` source: TS maps each declaration to the PROJECTED virtual module, so every mapped
 * position is translated projected->source through the projection's own CodeMapping (segments that
 * land in generated-only scaffolding are dropped). With the map written beside the `.d.ts`, an
 * editor's go-to-definition follows it onto the real `.azeroth` declaration instead of stopping in
 * the generated declaration file.
 *
 * @param source - The `.azeroth` module source.
 * @param fileName - The module's real path (its directory anchors import resolution).
 * @returns The declaration text and its remapped map (see {@link DeclarationOutput}).
 */
export function emitDeclarationsWithMap(source: string, fileName: string): DeclarationOutput
{
    // The projection lowers markup to `h(...)` calls, so the virtual module is plain TypeScript (no JSX).
    // Components project with a defaulted `props` parameter, which declaration emit renders as `props?: P`,
    // so the emitted `.d.ts` lets a prop-less component be called with zero arguments (`App()`).
    const { code: projected, mapping } = generateVirtualCode(source);
    const tsPath = normalizeSlashes(fileName) + '.ts';
    const sys = ts.sys;

    let dts = '';
    let rawMap = '';
    const host: ts.CompilerHost =
    {
        getSourceFile: (f, languageVersion) =>
        {
            if (f === tsPath)
            {
                return ts.createSourceFile(f, projected, languageVersion, true);
            }
            const cached = libSourceCache.get(f);
            if (cached !== undefined)
            {
                return cached;
            }
            const text = sys.readFile(f);
            if (text === undefined)
            {
                return undefined;
            }
            const sourceFile = ts.createSourceFile(f, text, languageVersion, true);
            if (normalizeSlashes(f).startsWith(normalizeSlashes(LIB_DIR)))
            {
                libSourceCache.set(f, sourceFile);
            }
            return sourceFile;
        },
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        getDefaultLibLocation: () => LIB_DIR,
        writeFile: (f, text) =>
        {
            if (f.endsWith('.d.ts.map'))
            {
                rawMap = text;
            }
            else if (f.endsWith('.d.ts'))
            {
                dts = text;
            }
        },
        getCurrentDirectory: () => sys.getCurrentDirectory(),
        getCanonicalFileName: (f) => f,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (f) => f === tsPath || sys.fileExists(f),
        readFile: (f) => (f === tsPath ? projected : sys.readFile(f)),
        directoryExists: (d) => sys.directoryExists(d),
        getDirectories: (d) => sys.getDirectories(d)
    };

    const program = ts.createProgram([tsPath], DECL_OPTIONS, host);
    const sourceFile = program.getSourceFile(tsPath);
    if (sourceFile === undefined)
    {
        return { dts: '', map: null };
    }
    program.emit(sourceFile);

    // TS strips the sourceMappingURL comment location choice from us: it appends one pointing at
    // `<tsPath>.d.ts.map`. Drop it - the caller decides the final file name and appends its own.
    const cleanDts = dts.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');

    if (rawMap === '')
    {
        return { dts: cleanDts, map: null };
    }

    // Remap: TS's declaration map points into the PROJECTED module; translate every segment through
    // the projection's CodeMapping so positions land in the real `.azeroth` source. Segments inside
    // generated-only scaffolding have no source equivalent and are dropped.
    const parsed = JSON.parse(rawMap) as { mappings: string };
    const projectedLineStarts = buildLineStarts(projected);
    const sourceLineStarts = buildLineStarts(source);
    const remapped: RawSegment[][] = decodeMappings(parsed.mappings).map(line => line
        .map((segment): RawSegment | null =>
        {
            const projectedOffset = projectedLineStarts[segment.sourceLine] + segment.sourceColumn;
            const original = mapping.toOriginal(projectedOffset);
            if (original === null)
            {
                return null;
            }
            const location = locationFor(original, sourceLineStarts);
            return { genColumn: segment.genColumn, sourceLine: location.line, sourceColumn: location.column };
        })
        .filter((segment): segment is RawSegment => segment !== null));

    return {
        dts: cleanDts,
        map: {
            version: 3,
            file: '',
            sources: [normalizeSlashes(fileName)],
            names: [],
            mappings: encodeMappings(remapped)
        }
    };
}
