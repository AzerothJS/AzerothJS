// The TypeScript bridge. A `.azeroth` file is a TS module with markup regions;
// once the markup is compiled to `h(...)` calls (virtual-code.ts) the result is
// ordinary TypeScript, so the authoritative engine for type inference,
// completion, hover, definitions, references, rename, signatures, and
// diagnostics is the TypeScript language service itself.
//
// This module runs a single `ts.LanguageService` over a virtual project:
//   - each `.azeroth` file is presented to TS under the synthetic name
//     `<path>.azeroth.ts`, whose contents are the compiled virtual module;
//   - imports of other `.azeroth` files are resolved to their virtual twin, so
//     definitions/types flow across `.azeroth` modules;
//   - every real file (the runtime packages, node_modules, lib.d.ts) is read
//     from disk through ts.sys.
//
// Callers work in original `.azeroth` offsets; the CodeMapping returned by
// `getVirtual` translates to and from the virtual offsets TS understands.

import ts from 'typescript';
import { generateVirtualCode, type VirtualCode } from './virtual-code.ts';

/** Suffix that marks a synthetic virtual file backing a `.azeroth` module. */
const VIRTUAL_SUFFIX = '.azeroth.ts';

/** Basename of the injected ambient declarations (always in the program). */
const INTRINSICS_BASENAME = '__azeroth-intrinsics.d.ts';

/**
 * Ambient types injected into every project. `AzerothHandler<'onClick'>` maps a
 * camelCase event prop to the right DOM event (via lib.dom's
 * GlobalEventHandlersEventMap), so the virtual code can contextually type host
 * event handlers - `<button onClick={(e) => …}>` infers `e: MouseEvent` - without
 * imposing strict attribute checking that the permissive `h()` runtime doesn't.
 */
const INTRINSICS_CONTENT = `
type AzerothHandler<N extends string> =
    N extends \`on\${infer E}\`
        ? (event: Lowercase<E> extends keyof GlobalEventHandlersEventMap
            ? GlobalEventHandlersEventMap[Lowercase<E>]
            : Event) => unknown
        : (event: Event) => unknown;
`;

/** True for a synthetic virtual file name. */
export function isVirtualFile(fileName: string): boolean
{
    return fileName.endsWith(VIRTUAL_SUFFIX);
}

/** Maps a `.azeroth` path to its virtual TS file name. */
export function toVirtualFile(azerothPath: string): string
{
    return `${ azerothPath }.ts`;
}

/** Maps a virtual TS file name back to its `.azeroth` path. */
export function toAzerothPath(virtualFile: string): string
{
    return virtualFile.slice(0, -3);
}

/** An open document's source and monotonic version. */
interface OpenDoc
{
    source: string;
    version: number;
}

/** A cached virtual compilation tied to the source it was built from. */
interface CachedVirtual extends VirtualCode
{
    source: string;
}

/**
 * Hosts a TypeScript language service over the workspace's `.azeroth` (and
 * real) files. One instance per workspace folder.
 *
 * @example
 * ```ts
 * const project = new AzerothProject(process.cwd());
 * project.openDocument('/abs/App.azeroth', 'export default () => <h1>Hi</h1>;');
 * const { mapping } = project.getVirtual('/abs/App.azeroth');
 * project.service.getQuickInfoAtPosition('/abs/App.azeroth.ts', mapping.toGenerated(0)!);
 * ```
 */
export class AzerothProject
{
    /** The underlying TypeScript language service. */
    public readonly service: ts.LanguageService;

    private readonly open = new Map<string, OpenDoc>();

    private readonly virtualCache = new Map<string, CachedVirtual>();

    private readonly options: ts.CompilerOptions;

    /** Virtual names of every `.azeroth` file found in the workspace. */
    private readonly discovered: string[];

    private projectVersion = 0;

    constructor(private readonly currentDirectory: string, configPath?: string)
    {
        this.options = AzerothProject.resolveOptions(currentDirectory, configPath);
        this.intrinsicsFile = `${ currentDirectory.replace(/\\/g, '/').replace(/\/$/, '') }/${ INTRINSICS_BASENAME }`;
        this.discovered = this.discoverWorkspace();
        this.service = ts.createLanguageService(this.createHost(), ts.createDocumentRegistry());
    }

    /** Path of the injected ambient declarations file. */
    private readonly intrinsicsFile: string;

    /**
     * Finds every `.azeroth` file in the workspace so they all join the TS
     * program - enabling cross-file go-to-definition and auto-import of
     * components defined in other `.azeroth` files, plus workspace symbols.
     */
    private discoverWorkspace(): string[]
    {
        try
        {
            const files = ts.sys.readDirectory(
                this.currentDirectory,
                ['.azeroth'],
                ['**/node_modules/**', '**/dist/**', '**/.git/**'],
                ['**/*.azeroth']
            );
            return files.map(toVirtualFile);
        }
        catch
        {
            return [];
        }
    }

    /** Registers/updates an open `.azeroth` document. */
    public openDocument(azerothPath: string, source: string): void
    {
        const prev = this.open.get(azerothPath);
        this.open.set(azerothPath, { source, version: (prev?.version ?? 0) + 1 });
        this.virtualCache.delete(azerothPath);
        this.projectVersion++;
    }

    /** Drops an open document (e.g. the editor closed it). */
    public closeDocument(azerothPath: string): void
    {
        this.open.delete(azerothPath);
        this.virtualCache.delete(azerothPath);
        this.projectVersion++;
    }

    /** All currently-open `.azeroth` paths. */
    public openPaths(): string[]
    {
        return [...this.open.keys()];
    }

    /** The current source of a `.azeroth` document (open buffer or disk). */
    public getSource(azerothPath: string): string | undefined
    {
        return this.readAzeroth(azerothPath);
    }

    /**
     * Returns the virtual compilation for a `.azeroth` path, building it from
     * the open document or from disk. Cached against the exact source so the
     * mapping always matches the snapshot TypeScript analyzed.
     */
    public getVirtual(azerothPath: string): VirtualCode
    {
        const source = this.readAzeroth(azerothPath) ?? '';
        const cached = this.virtualCache.get(azerothPath);
        if (cached && cached.source === source)
        {
            return cached;
        }
        const built = generateVirtualCode(source);
        const entry: CachedVirtual = { ...built, source };
        this.virtualCache.set(azerothPath, entry);
        return entry;
    }

    /** Reads a `.azeroth` source from the open set or disk. */
    private readAzeroth(azerothPath: string): string | undefined
    {
        const doc = this.open.get(azerothPath);
        if (doc)
        {
            return doc.source;
        }
        return ts.sys.readFile(azerothPath);
    }

    /** Builds the language service host backing the virtual project. */
    private createHost(): ts.LanguageServiceHost
    {
        // Every member below is an arrow function, so `this` is lexically the
        // project instance; no alias is needed.
        const host: ts.LanguageServiceHost =
        {
            getScriptFileNames: () => [this.intrinsicsFile, ...new Set([...this.openPaths().map(toVirtualFile), ...this.discovered])],
            getProjectVersion: () => String(this.projectVersion),

            getScriptVersion: (fileName) =>
            {
                if (fileName === this.intrinsicsFile)
                {
                    return '1';
                }

                if (isVirtualFile(fileName))
                {
                    const azerothPath = toAzerothPath(fileName);
                    const doc = this.open.get(azerothPath);
                    if (doc)
                    {
                        return `o${ doc.version }`;
                    }
                    return `d${ ts.sys.getModifiedTime?.(azerothPath)?.getTime() ?? 0 }`;
                }

                return `${ ts.sys.getModifiedTime?.(fileName)?.getTime() ?? 0 }`;
            },

            getScriptSnapshot: (fileName) =>
            {
                if (fileName === this.intrinsicsFile)
                {
                    return ts.ScriptSnapshot.fromString(INTRINSICS_CONTENT);
                }

                if (isVirtualFile(fileName))
                {
                    const azerothPath = toAzerothPath(fileName);
                    if (this.readAzeroth(azerothPath) === undefined)
                    {
                        return undefined;
                    }
                    return ts.ScriptSnapshot.fromString(this.getVirtual(azerothPath).code);
                }

                const contents = ts.sys.readFile(fileName);
                return contents === undefined ? undefined : ts.ScriptSnapshot.fromString(contents);
            },

            getCurrentDirectory: () => this.currentDirectory,
            getCompilationSettings: () => this.options,
            getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
            fileExists: (fileName) => this.hostFileExists(fileName),
            readFile: (fileName) => this.hostReadFile(fileName),
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
            useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
            resolveModuleNameLiterals: (literals, containingFile, _redirect, options) =>
                this.resolveModules(literals, containingFile, options)
        };

        return host;
    }

    /** fileExists that also reports the synthetic virtual twins as present. */
    private hostFileExists(fileName: string): boolean
    {
        if (fileName === this.intrinsicsFile)
        {
            return true;
        }

        if (isVirtualFile(fileName))
        {
            const azerothPath = toAzerothPath(fileName);
            return this.open.has(azerothPath) || ts.sys.fileExists(azerothPath);
        }

        return ts.sys.fileExists(fileName);
    }

    /** readFile that materializes the virtual TS for a `.azeroth` twin. */
    private hostReadFile(fileName: string): string | undefined
    {
        if (fileName === this.intrinsicsFile)
        {
            return INTRINSICS_CONTENT;
        }

        if (isVirtualFile(fileName))
        {
            const azerothPath = toAzerothPath(fileName);
            return this.readAzeroth(azerothPath) === undefined
                ? undefined
                : this.getVirtual(azerothPath).code;
        }

        return ts.sys.readFile(fileName);
    }

    /**
     * Resolves each import. `*.azeroth` specifiers point at the importer's
     * sibling `.azeroth` file and resolve to its virtual twin; everything else
     * goes through standard TypeScript resolution (which honours tsconfig
     * `paths` for the `@azerothjs/*` packages and node_modules).
     */
    private resolveModules(
        literals: readonly ts.StringLiteralLike[],
        containingFile: string,
        options: ts.CompilerOptions
    ): ts.ResolvedModuleWithFailedLookupLocations[]
    {
        return literals.map((literal) =>
        {
            const text = literal.text;
            if (text.endsWith('.azeroth') && (text.startsWith('.') || text.startsWith('/')))
            {
                const dir = ts.sys.resolvePath(containingFile).replace(/[\\/][^\\/]*$/, '');
                const candidate = ts.sys.resolvePath(`${ dir }/${ text }`);
                if (this.hostFileExists(toVirtualFile(candidate)))
                {
                    return {
                        resolvedModule:
                        {
                            resolvedFileName: toVirtualFile(candidate),
                            extension: ts.Extension.Ts,
                            isExternalLibraryImport: false
                        },
                        failedLookupLocations: []
                    };
                }
            }
            return ts.resolveModuleName(text, containingFile, options, ts.sys);
        });
    }

    /**
     * Discovers the nearest tsconfig and forces the options the virtual modules
     * need (TS source, bundler resolution), keeping the project's `paths`.
     */
    private static resolveOptions(currentDirectory: string, configPath?: string): ts.CompilerOptions
    {
        let options: ts.CompilerOptions = {};
        const found = configPath ?? ts.findConfigFile(currentDirectory, ts.sys.fileExists, 'tsconfig.json');
        if (found)
        {
            const read = ts.readConfigFile(found, ts.sys.readFile);
            const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, found.replace(/[\\/][^\\/]*$/, ''));
            options = parsed.options;
        }

        return {
            ...options,
            allowJs: true,
            checkJs: false,
            noEmit: true,
            jsx: ts.JsxEmit.Preserve,
            module: options.module ?? ts.ModuleKind.ESNext,
            target: options.target ?? ts.ScriptTarget.ESNext,
            moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
            allowImportingTsExtensions: true,
            skipLibCheck: true,
            lib: options.lib ?? ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts']
        };
    }
}
