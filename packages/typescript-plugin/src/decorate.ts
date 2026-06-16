// The core of the TypeScript language-service plugin: it teaches an existing
// `ts.LanguageServiceHost` to resolve and load `.azeroth` modules as real
// TypeScript. With this in place, a `.ts` file that does
// `import Breadcrumb, { SEP } from './x.component.azeroth'` (or
// `export type { Crumb } from './x.component.azeroth'`) sees the REAL exported
// types - default, named, and type exports - instead of the `any` a catch-all
// `declare module '*.azeroth'` shim would provide.
//
// How: a `.azeroth` import resolves to a synthetic sibling named
// `<path>.azeroth.ts`. When TypeScript then loads that synthetic file, the host
// serves the COMPILED virtual module (markup rewritten to `h()` calls, all
// surrounding code - including every `export` - copied verbatim) produced by
// `@azerothjs/language-service`. This is the same virtual-code pipeline the
// editor's `.azeroth` language server uses, so the two always agree.
//
// The decoration wraps each host method and defers to the original for anything
// that is not a `.azeroth` virtual file, so it composes with whatever host
// tsserver (or a test) already provides.

import type tsModule from 'typescript';
import path from 'node:path';
// The `.azeroth` <-> virtual-twin naming (`<name>.azeroth.ts`) and the compiler
// are reused from the language service - the single source of truth - so the
// plugin and the editor language server can never disagree on the convention.
import { generateVirtualCode, isVirtualFile, toVirtualFile, toAzerothPath } from '@azerothjs/language-service';

/** Real `.azeroth` source extension. */
const AZEROTH_EXT = '.azeroth';

/** Options for {@link decorateLanguageServiceHost}. */
export interface DecorateOptions
{
    /**
     * Reads a `.azeroth` file's source. Defaults to `ts.sys.readFile`. A host
     * with live unsaved buffers (an editor) can override this to serve the open
     * document instead of the on-disk copy.
     */
    readAzeroth?: (azerothPath: string) => string | undefined;
}

/** True for a relative/absolute import specifier that points at a `.azeroth` file. */
function isAzerothSpecifier(text: string): boolean
{
    return text.endsWith(AZEROTH_EXT) && (text.startsWith('.') || text.startsWith('/'));
}

/**
 * Infers a script kind from a file name, mirroring TypeScript's own
 * extension-based inference. Used as a fallback when the wrapped host does not
 * implement getScriptKind: returning ScriptKind.Unknown for a real file would
 * make the program drop it, so we must classify it the way TypeScript would.
 */
function scriptKindFromName(ts: typeof tsModule, fileName: string): tsModule.ScriptKind
{
    if (fileName.endsWith('.tsx'))
    {
        return ts.ScriptKind.TSX;
    }
    if (fileName.endsWith('.jsx'))
    {
        return ts.ScriptKind.JSX;
    }
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
 * @param options - Optional source override (e.g. live editor buffers).
 */
export function decorateLanguageServiceHost(
    ts: typeof tsModule,
    host: tsModule.LanguageServiceHost,
    options: DecorateOptions = {}
): void
{
    const read = options.readAzeroth ?? ((azerothPath: string): string | undefined => ts.sys.readFile(azerothPath));

    // Cache the compiled virtual module per source, so an unchanged file isn't
    // recompiled on every host query.
    const cache = new Map<string, { source: string; code: string }>();

    const virtualCodeFor = (azerothPath: string): string | undefined =>
    {
        const source = read(azerothPath);
        if (source === undefined)
        {
            return undefined;
        }
        const cached = cache.get(azerothPath);
        if (cached && cached.source === source)
        {
            return cached.code;
        }
        const code = generateVirtualCode(source).code;
        cache.set(azerothPath, { source, code });
        return code;
    };

    const origSnapshot = host.getScriptSnapshot?.bind(host);
    host.getScriptSnapshot = (fileName): tsModule.IScriptSnapshot | undefined =>
    {
        if (isVirtualFile(fileName))
        {
            const code = virtualCodeFor(toAzerothPath(fileName));
            return code === undefined ? undefined : ts.ScriptSnapshot.fromString(code);
        }
        return origSnapshot ? origSnapshot(fileName) : undefined;
    };

    const origKind = host.getScriptKind?.bind(host);
    host.getScriptKind = (fileName): tsModule.ScriptKind =>
    {
        if (isVirtualFile(fileName))
        {
            return ts.ScriptKind.TS;
        }
        // We own the method now, so a real file must still get its true kind: a
        // host without getScriptKind would otherwise force Unknown and the
        // program would drop the file.
        return origKind ? origKind(fileName) : scriptKindFromName(ts, fileName);
    };

    const origVersion = host.getScriptVersion.bind(host);
    host.getScriptVersion = (fileName): string =>
    {
        if (isVirtualFile(fileName))
        {
            const azerothPath = toAzerothPath(fileName);
            const mtime = ts.sys.getModifiedTime?.(azerothPath)?.getTime() ?? 0;
            return `azeroth:${ mtime }`;
        }
        return origVersion(fileName);
    };

    const origExists = host.fileExists?.bind(host);
    host.fileExists = (fileName): boolean =>
    {
        if (isVirtualFile(fileName))
        {
            return read(toAzerothPath(fileName)) !== undefined;
        }
        return origExists ? origExists(fileName) : ts.sys.fileExists(fileName);
    };

    const origReadFile = host.readFile?.bind(host);
    host.readFile = (fileName, encoding): string | undefined =>
    {
        if (isVirtualFile(fileName))
        {
            return virtualCodeFor(toAzerothPath(fileName));
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

        const asAzeroth = (azerothPath: string) => ({
            resolvedModule:
            {
                resolvedFileName: toVirtualFile(azerothPath),
                extension: ts.Extension.Ts,
                isExternalLibraryImport: false
            },
            failedLookupLocations: []
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
            // resolver runs first, so a real `.ts`/`.tsx` of the same name wins.
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
}
