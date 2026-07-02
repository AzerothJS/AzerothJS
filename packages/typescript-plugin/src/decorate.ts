// The core of the TypeScript language-service plugin: it teaches an existing
// `ts.LanguageServiceHost` to resolve and load `.azeroth` modules as real
// TypeScript. With this in place, a `.ts` file that does
// `import Breadcrumb, { SEP } from './x.component.azeroth'` (or
// `export type { Crumb } from './x.component.azeroth'`) sees the REAL exported
// types - default, named, and type exports - instead of the `any` a catch-all
// `declare module '*.azeroth'` shim would provide.
//
// How: a `.azeroth` import resolves to the REAL `.azeroth` file (with its module
// extension reported as `.ts`), and the host serves the COMPILED virtual module
// (markup rewritten to `h()` calls, all surrounding code - including every
// `export` - copied verbatim, produced by `@azerothjs/language-service`) as that
// file's snapshot. Resolving to the real on-disk path - rather than a synthetic
// `<path>.azeroth.ts` twin - is what lets this work inside tsserver's
// ProjectService: tsserver creates a `ScriptInfo` only for paths it can find on
// disk, and its document registry asserts that a ScriptInfo exists before it
// caches a source file (`ProjectService.setDocument` -> `Debug.checkDefined`). A
// synthetic path has no ScriptInfo, so loading it threw `Debug Failure` and took
// down the whole program - i.e. every `.ts` file lost IntelliSense. The real
// path has one, so the program builds. (The raw `ts.LanguageService` API used by
// `azeroth-tsc` has no ProjectService and tolerated the synthetic twin, which is
// why the batch checker never hit this.)
//
// The decoration wraps each host method and defers to the original for anything
// that is not a `.azeroth` file, so it composes with whatever host tsserver (or
// a test) already provides.

import type tsModule from 'typescript';
import path from 'node:path';
// The compiler is reused from the language service - the single source of truth -
// so the plugin and the editor language server can never disagree on how a
// `.azeroth` file becomes TypeScript.
import { generateVirtualCode, type CodeMapping } from '@azerothjs/language-service';

/**
 * Read access to the compiled view of `.azeroth` files, shared between the host decoration (which
 * serves the virtual code as the file's content) and the language-service decoration (which maps
 * result spans in that virtual code back to `.azeroth` source offsets - see remap.ts).
 */
export interface VirtualAzerothFiles
{
    /** The offset mapping for a `.azeroth` file, or undefined when it cannot be read/compiled. */
    mappingFor(fileName: string): CodeMapping | undefined;
}

/** Real `.azeroth` source extension. */
const AZEROTH_EXT = '.azeroth';

/** True for a relative/absolute import specifier that points at a `.azeroth` file. */
function isAzerothSpecifier(text: string): boolean
{
    return text.endsWith(AZEROTH_EXT) && (text.startsWith('.') || text.startsWith('/'));
}

/** True for a resolved file name that is a real `.azeroth` source file. */
function isAzerothFile(fileName: string): boolean
{
    return fileName.endsWith(AZEROTH_EXT);
}

/**
 * Infers a script kind from a file name for the file types an AzerothJS project
 * uses (`.ts`, `.js`/`.mjs`/`.cjs`, `.json`); `.azeroth` files are presented to
 * TypeScript as `.azeroth.ts` and so classify as `.ts`. Used as a fallback when
 * the wrapped host does not implement getScriptKind: returning
 * ScriptKind.Unknown for a real file would make the program drop it, so we must
 * classify it the way TypeScript would.
 */
function scriptKindFromName(ts: typeof tsModule, fileName: string): tsModule.ScriptKind
{
    if (fileName.endsWith('.json'))
    {
        return ts.ScriptKind.JSON;
    }
    if (/\.(?:m|c)?js$/.test(fileName))
    {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}

/**
 * Resolves a relative `.azeroth` specifier against its importer's directory to
 * an absolute path with forward slashes (the form TypeScript uses internally).
 * Delegates the `..`/`.`/drive/UNC handling to node:path rather than hand-rolling
 * it, then normalizes separators.
 */
function resolveSibling(containingFile: string, specifier: string): string
{
    return path.resolve(path.dirname(containingFile), specifier).replace(/\\/g, '/');
}

/**
 * Decorates `host` in place so `.azeroth` modules resolve and type-check as real
 * TypeScript. Safe to call once per language service; every wrapped method
 * defers to the original for non-`.azeroth` files.
 *
 * @param ts - The TypeScript module tsserver handed the plugin.
 * @param host - The language-service host to decorate.
 * @returns Access to the compiled `.azeroth` views, for the result-span remapping in remap.ts.
 */
export function decorateLanguageServiceHost(
    ts: typeof tsModule,
    host: tsModule.LanguageServiceHost
): VirtualAzerothFiles
{
    const read = (azerothPath: string): string | undefined => ts.sys.readFile(azerothPath);

    // Cache the compiled virtual module per source, so an unchanged file isn't
    // recompiled on every host query.
    const cache = new Map<string, { source: string; code: string; mapping: CodeMapping }>();

    const virtualFor = (azerothPath: string): { code: string; mapping: CodeMapping } | undefined =>
    {
        const source = read(azerothPath);
        if (source === undefined)
        {
            return undefined;
        }
        const cached = cache.get(azerothPath);
        if (cached && cached.source === source)
        {
            return cached;
        }
        const { code, mapping } = generateVirtualCode(source);
        const entry = { source, code, mapping };
        cache.set(azerothPath, entry);
        return entry;
    };

    const virtualCodeFor = (azerothPath: string): string | undefined => virtualFor(azerothPath)?.code;

    // A `.azeroth` file IS the resolved module now, so the program reads its
    // source through these overrides keyed on the real path. We deliberately do
    // NOT override getScriptVersion: the original (in tsserver, the Project's)
    // both creates+attaches the ScriptInfo and reports a version that tracks the
    // file on disk - exactly what the document registry needs.
    const origSnapshot = host.getScriptSnapshot?.bind(host);
    host.getScriptSnapshot = (fileName): tsModule.IScriptSnapshot | undefined =>
    {
        if (isAzerothFile(fileName))
        {
            const code = virtualCodeFor(fileName);
            return code === undefined ? undefined : ts.ScriptSnapshot.fromString(code);
        }
        return origSnapshot ? origSnapshot(fileName) : undefined;
    };

    const origKind = host.getScriptKind?.bind(host);
    host.getScriptKind = (fileName): tsModule.ScriptKind =>
    {
        if (isAzerothFile(fileName))
        {
            return ts.ScriptKind.TS;
        }
        // We own the method now, so a real file must still get its true kind: a
        // host without getScriptKind would otherwise force Unknown and the
        // program would drop the file.
        return origKind ? origKind(fileName) : scriptKindFromName(ts, fileName);
    };

    const origReadFile = host.readFile?.bind(host);
    host.readFile = (fileName, encoding): string | undefined =>
    {
        // Present `.azeroth` as its compiled TypeScript to anything reading
        // through the host, keeping the snapshot and readFile views consistent.
        if (isAzerothFile(fileName))
        {
            return virtualCodeFor(fileName);
        }
        return origReadFile ? origReadFile(fileName, encoding) : ts.sys.readFile(fileName, encoding);
    };

    const origResolve = host.resolveModuleNameLiterals?.bind(host);
    host.resolveModuleNameLiterals = (
        literals,
        containingFile,
        redirectedReference,
        compilerOptions,
        containingSourceFile,
        reusedNames
    ): readonly tsModule.ResolvedModuleWithFailedLookupLocations[] =>
    {
        const base = origResolve
            ? origResolve(literals, containingFile, redirectedReference, compilerOptions, containingSourceFile, reusedNames)
            : literals.map((literal) => ts.resolveModuleName(literal.text, containingFile, compilerOptions, host));

        const asAzeroth = (azerothPath: string): tsModule.ResolvedModuleWithFailedLookupLocations => ({
            resolvedModule:
            {
                // The REAL `.azeroth` path, reported with a `.ts` module
                // extension so TypeScript treats it as a TypeScript module. Its
                // snapshot (above) is the compiled virtual code.
                resolvedFileName: azerothPath,
                extension: ts.Extension.Ts,
                isExternalLibraryImport: false
            }
        });

        return literals.map((literal, index) =>
        {
            const text = literal.text;

            // Explicit `./x.azeroth`.
            if (isAzerothSpecifier(text))
            {
                const azerothPath = resolveSibling(containingFile, text);
                if (read(azerothPath) !== undefined)
                {
                    return asAzeroth(azerothPath);
                }
            }

            // Extensionless relative import nothing else resolved (`./x.component`
            // for `x.component.azeroth`) - try the `.azeroth` sibling. The base
            // resolver runs first, so a real `.ts` of the same name wins.
            const relative = text.startsWith('.') || text.startsWith('/');
            if (!base[index].resolvedModule && relative && !text.endsWith(AZEROTH_EXT))
            {
                const azerothPath = resolveSibling(containingFile, text + AZEROTH_EXT);
                if (read(azerothPath) !== undefined)
                {
                    return asAzeroth(azerothPath);
                }
            }

            return base[index];
        });
    };

    return {
        mappingFor: (fileName) => (isAzerothFile(fileName) ? virtualFor(fileName)?.mapping : undefined)
    };
}
