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
import { StyleIndex } from './style-index.ts';
import { createNativeLsBackend, type NativeLsBackend, type RawTsDiagnostic } from './native-project.ts';

export type { RawTsDiagnostic } from './native-project.ts';

/** Suffix that marks a synthetic virtual file backing a `.azeroth` module. */
const VIRTUAL_SUFFIX = '.azeroth.ts';

/** Basename of the injected ambient declarations (always in the program). */
const INTRINSICS_BASENAME = '__azeroth-intrinsics.d.ts';

/**
 * Ambient types injected into every project. `AzerothHandler<'onClick'>` maps a
 * camelCase event prop to the right DOM event (via lib.dom's
 * GlobalEventHandlersEventMap), so the virtual code can contextually type host
 * event handlers - `<button onClick={(e) => ...}>` infers `e: MouseEvent` - without
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

/**
 * Normalizes a path to forward slashes - the separator TypeScript uses
 * internally and the one `uriToPath` produces. Open-document keys and resolved
 * module paths must agree on it: on Windows, `ts.sys.resolvePath` returns
 * backslashes, so a raw compare against a forward-slash open-doc key would miss
 * and a cross-file `.azeroth` import would wrongly resolve to `any`.
 */
function toSlashes(filePath: string): string
{
    return filePath.replace(/\\/g, '/');
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

    readonly #open = new Map<string, OpenDoc>();

    readonly #virtualCache = new Map<string, CachedVirtual>();

    readonly #options: ts.CompilerOptions;

    /** Virtual names of every `.azeroth` file found in the workspace. */
    #discovered: string[];

    /**
     * Memoized `getScriptFileNames` result. TS queries the root file list very
     * frequently; the set only changes when `projectVersion` does (open/close or
     * a workspace refresh), so we rebuild lazily and cache against that version.
     */
    #scriptNamesCache: { version: number; names: string[] } | null = null;

    /**
     * Per-file disk mtime cache for `getScriptVersion`. Without it every version
     * query stats the disk; TS asks once per file per program build, so the same
     * `.azeroth`/real file gets stat-ed repeatedly. The cache is valid for one
     * `projectVersion` epoch - any edit (which bumps the version) clears it, so a
     * genuine change is never masked.
     */
    readonly #mtimeCache = new Map<string, string>();

    #mtimeCacheVersion = -1;

    /**
     * The consuming project's own ambient/global declaration files (`.d.ts`
     * roots from the tsconfig's `include`/`files`). They are kept in the program
     * so their global augmentations apply inside `.azeroth` - see
     * {@link resolveProject}.
     */
    readonly #ambientFiles: string[];

    /**
     * The consuming project's real `.ts` source files (from the tsconfig).
     * AzerothJS projects are `.ts` + `.azeroth` (markup lives in `.azeroth`, the
     * framework's own format). The editor doesn't root these - they enter the program on demand
     * via imports - but the combined command-line checker does
     * ({@link rootProjectFiles}), so a `.ts` file importing a `.azeroth`
     * component is type-checked in the SAME program as the `.azeroth` files.
     */
    readonly #projectFiles: string[];

    /** When true, {@link projectFiles} are program roots (the CLI checker). */
    readonly #rootProjectFiles: boolean;

    #projectVersion = 0;

    /** Workspace CSS class index (for `class="..."` completion/hover/definition), built on first use. */
    #styleIndex: StyleIndex | null = null;

    /** The native diagnostics backend, when this project opted in and the native API is installed. */
    #nativeBackend: NativeLsBackend | null = null;

    readonly #currentDirectory: string;

    constructor(
        currentDirectory: string,
        configPath?: string,
        options: { rootProjectFiles?: boolean; nativeDiagnostics?: boolean } = {}
    )
    {
        this.#currentDirectory = currentDirectory;
        const resolved = AzerothProject.#resolveProject(currentDirectory, configPath);
        this.#options = resolved.options;
        this.#ambientFiles = resolved.ambientFiles;
        this.#projectFiles = resolved.projectFiles;
        this.#rootProjectFiles = options.rootProjectFiles ?? false;
        this.#intrinsicsFile = `${ currentDirectory.replace(/\\/g, '/').replace(/\/$/, '') }/${ INTRINSICS_BASENAME }`;
        this.#discovered = this.#discoverWorkspace();
        this.service = ts.createLanguageService(this.#createHost(), ts.createDocumentRegistry());

        if (options.nativeDiagnostics ?? false)
        {
            this.#nativeBackend = createNativeLsBackend({
                currentDirectory,
                configFileName: resolved.configFileName,
                baseOptions: resolved.baseOptions,
                rootNames: () => this.#programRootNames(),
                version: () => this.#projectVersion,
                virtualContent: (fileName) => this.#nativeVirtualContent(fileName),
                azerothSource: (azerothPath) => this.#readAzeroth(azerothPath)
            });
        }
    }

    /**
     * Raw TypeScript diagnostics (syntactic then semantic) for one program file - the ONE
     * primitive every diagnostics consumer goes through, so the engine can be swapped under
     * it. The native backend answers when this project opted in and the native compiler is
     * installed; otherwise (or after any native failure) the classic language service does,
     * with identical results.
     */
    public rawTsDiagnostics(fileName: string): readonly RawTsDiagnostic[]
    {
        if (this.#nativeBackend !== null)
        {
            const native = this.#nativeBackend.diagnosticsFor(fileName);
            if (native !== null)
            {
                return native;
            }
            // The backend shut down (spawn or protocol failure); classic serves the rest of
            // the session.
            this.#nativeBackend = null;
        }
        return [
            ...this.service.getSyntacticDiagnostics(fileName),
            ...this.service.getSemanticDiagnostics(fileName)
        ];
    }

    /** Serves the native overlay's virtual reads: the intrinsics file and `.azeroth.ts` projection twins. */
    #nativeVirtualContent(fileName: string): string | undefined
    {
        if (fileName === this.#intrinsicsFile)
        {
            return INTRINSICS_CONTENT;
        }
        if (isVirtualFile(fileName))
        {
            const azerothPath = toAzerothPath(fileName);
            return this.#readAzeroth(azerothPath) === undefined ? undefined : this.getVirtual(azerothPath).code;
        }
        return undefined;
    }

    /**
     * The consuming project's real `.ts` files (absolute, forward-slash). Used
     * by the combined checker to iterate diagnostics over the `.ts` side.
     */
    public getProjectFiles(): readonly string[]
    {
        return this.#projectFiles;
    }

    /** Path of the injected ambient declarations file. */
    readonly #intrinsicsFile: string;

    /**
     * Finds every `.azeroth` file in the workspace so they all join the TS
     * program - enabling cross-file go-to-definition and auto-import of
     * components defined in other `.azeroth` files, plus workspace symbols.
     */
    #discoverWorkspace(): string[]
    {
        try
        {
            const files = ts.sys.readDirectory(
                this.#currentDirectory,
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
        const key = toSlashes(azerothPath);
        const prev = this.#open.get(key);
        this.#open.set(key, { source, version: (prev?.version ?? 0) + 1 });
        this.#virtualCache.delete(key);
        this.#projectVersion++;
    }

    /** Drops an open document (e.g. the editor closed it). */
    public closeDocument(azerothPath: string): void
    {
        const key = toSlashes(azerothPath);
        this.#open.delete(key);
        this.#virtualCache.delete(key);
        this.#projectVersion++;
    }

    /** All currently-open `.azeroth` paths. */
    public openPaths(): string[]
    {
        return [...this.#open.keys()];
    }

    /**
     * Sizes of the per-document caches, for leak detection. Every entry here is
     * keyed by a document/file path, so after a document is closed its entries
     * must be released - a stress loop of open/close cycles asserts these stay
     * bounded rather than growing with the number of cycles.
     */
    public cacheStats(): { openDocuments: number; virtualCache: number; mtimeCache: number }
    {
        return {
            openDocuments: this.#open.size,
            virtualCache: this.#virtualCache.size,
            mtimeCache: this.#mtimeCache.size
        };
    }

    /**
     * Re-scans the workspace for `.azeroth` files and bumps the project version
     * so the program picks up files created or deleted since startup. The
     * editor/LSP should call this on a watched-file create/delete; without it a
     * newly-added component would be invisible to cross-file completion and
     * go-to-definition until the service restarts.
     */
    public refreshWorkspace(): void
    {
        this.#discovered = this.#discoverWorkspace();
        this.#styleIndex?.refresh();
        this.#projectVersion++;
    }

    /**
     * The workspace CSS class index, built lazily on first use (so a project
     * that never writes `class="..."` pays nothing for it) and re-scanned on
     * {@link refreshWorkspace}. Backs class-name completion, hover, and
     * go-to-definition in markup.
     */
    public getStyleIndex(): StyleIndex
    {
        return this.#styleIndex ??= new StyleIndex(this.#currentDirectory);
    }

    /**
     * Re-discovers stylesheet files for the class index without touching the TS
     * program. Call on a watched stylesheet create/delete; an edit to an existing
     * file needs no call (the index re-reads it by mtime). No-op until the index
     * has been built.
     */
    public refreshStyles(): void
    {
        this.#styleIndex?.refresh();
    }

    /**
     * Picks up an on-disk CONTENT change to an existing file without re-scanning
     * the workspace file set. Disk mtimes are memoized per `projectVersion` epoch
     * (see {@link diskVersion}), so a closed file changed on disk is otherwise
     * served stale - bumping the version clears that epoch so TypeScript re-stats
     * and re-reads it. Cheaper than {@link refreshWorkspace} (no `readDirectory`
     * scan, no style re-discovery), which is only needed when the file SET changes.
     */
    public invalidateDiskCache(): void
    {
        this.#projectVersion++;
    }

    /** The current source of a `.azeroth` document (open buffer or disk). */
    public getSource(azerothPath: string): string | undefined
    {
        return this.#readAzeroth(azerothPath);
    }

    /**
     * Returns the virtual compilation for a `.azeroth` path, building it from
     * the open document or from disk. Cached against the exact source so the
     * mapping always matches the snapshot TypeScript analyzed.
     */
    public getVirtual(azerothPath: string): VirtualCode
    {
        // Normalize so the cache key matches the forward-slash key openDocument
        // stores - the read and write sides must agree (see toSlashes).
        const key = toSlashes(azerothPath);
        const source = this.#readAzeroth(key) ?? '';
        const cached = this.#virtualCache.get(key);
        if (cached && cached.source === source)
        {
            return cached;
        }
        const built = generateVirtualCode(source);
        const entry: CachedVirtual = { ...built, source };
        this.#virtualCache.set(key, entry);
        return entry;
    }

    /** Reads a `.azeroth` source from the open set or disk. */
    #readAzeroth(azerothPath: string): string | undefined
    {
        // Look the open buffer up under the same forward-slash key openDocument
        // writes; a backslash path would otherwise miss it and serve stale disk.
        const doc = this.#open.get(toSlashes(azerothPath));
        if (doc)
        {
            return doc.source;
        }
        return ts.sys.readFile(azerothPath);
    }

    /**
     * Disk mtime as a version string, memoized for the current `projectVersion`
     * epoch so repeated `getScriptVersion` queries don't re-stat the same file.
     * Cleared on any edit (the version bump), so a real on-disk change is still
     * seen on the next epoch.
     */
    #diskVersion(fileName: string): string
    {
        if (this.#mtimeCacheVersion !== this.#projectVersion)
        {
            this.#mtimeCache.clear();
            this.#mtimeCacheVersion = this.#projectVersion;
        }
        const cached = this.#mtimeCache.get(fileName);
        if (cached !== undefined)
        {
            return cached;
        }
        const version = String(ts.sys.getModifiedTime?.(fileName)?.getTime() ?? 0);
        this.#mtimeCache.set(fileName, version);
        return version;
    }

    /**
     * The program's root file names: the intrinsics file, the project's ambient declaration
     * roots, its real `.ts` files (when rooted), and every `.azeroth` virtual twin (open or
     * discovered). Shared verbatim by the classic host and the native backend so both engines
     * check the SAME program. Memoized per project version - TypeScript queries it constantly.
     */
    #programRootNames(): string[]
    {
        if (this.#scriptNamesCache?.version === this.#projectVersion)
        {
            return this.#scriptNamesCache.names;
        }
        const names = [
            this.#intrinsicsFile,
            ...new Set([
                ...this.#ambientFiles,
                ...(this.#rootProjectFiles ? this.#projectFiles : []),
                ...this.openPaths().map(toVirtualFile),
                ...this.#discovered
            ])
        ];
        this.#scriptNamesCache = { version: this.#projectVersion, names };
        return names;
    }

    /** Builds the language service host backing the virtual project. */
    #createHost(): ts.LanguageServiceHost
    {
        // Every member below is an arrow function, so `this` is lexically the
        // project instance; no alias is needed.
        const host: ts.LanguageServiceHost =
        {
            getScriptFileNames: () => this.#programRootNames(),
            getProjectVersion: () => String(this.#projectVersion),

            getScriptVersion: (fileName) =>
            {
                if (fileName === this.#intrinsicsFile)
                {
                    return '1';
                }

                if (isVirtualFile(fileName))
                {
                    const azerothPath = toSlashes(toAzerothPath(fileName));
                    const doc = this.#open.get(azerothPath);
                    if (doc)
                    {
                        return `o${ doc.version }`;
                    }
                    return `d${ this.#diskVersion(azerothPath) }`;
                }

                return this.#diskVersion(fileName);
            },

            getScriptSnapshot: (fileName) =>
            {
                if (fileName === this.#intrinsicsFile)
                {
                    return ts.ScriptSnapshot.fromString(INTRINSICS_CONTENT);
                }

                if (isVirtualFile(fileName))
                {
                    const azerothPath = toAzerothPath(fileName);
                    if (this.#readAzeroth(azerothPath) === undefined)
                    {
                        return undefined;
                    }
                    return ts.ScriptSnapshot.fromString(this.getVirtual(azerothPath).code);
                }

                const contents = ts.sys.readFile(fileName);
                return contents === undefined ? undefined : ts.ScriptSnapshot.fromString(contents);
            },

            getCurrentDirectory: () => this.#currentDirectory,
            getCompilationSettings: () => this.#options,
            getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
            fileExists: (fileName) => this.#hostFileExists(fileName),
            readFile: (fileName) => this.#hostReadFile(fileName),
            readDirectory: ts.sys.readDirectory.bind(ts.sys),
            directoryExists: ts.sys.directoryExists.bind(ts.sys),
            getDirectories: ts.sys.getDirectories.bind(ts.sys),
            // ts.sys.realpath is itself optional; under exactOptionalPropertyTypes an
            // explicit undefined is not assignable to the host's `realpath?:` slot.
            ...(ts.sys.realpath !== undefined ? { realpath: ts.sys.realpath.bind(ts.sys) } : {}),
            useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
            resolveModuleNameLiterals: (literals, containingFile, _redirect, options) =>
                this.#resolveModules(literals, containingFile, options)
        };

        return host;
    }

    /** fileExists that also reports the synthetic virtual twins as present. */
    #hostFileExists(fileName: string): boolean
    {
        if (fileName === this.#intrinsicsFile)
        {
            return true;
        }

        if (isVirtualFile(fileName))
        {
            const azerothPath = toSlashes(toAzerothPath(fileName));
            return this.#open.has(azerothPath) || ts.sys.fileExists(azerothPath);
        }

        return ts.sys.fileExists(fileName);
    }

    /** readFile that materializes the virtual TS for a `.azeroth` twin. */
    #hostReadFile(fileName: string): string | undefined
    {
        if (fileName === this.#intrinsicsFile)
        {
            return INTRINSICS_CONTENT;
        }

        if (isVirtualFile(fileName))
        {
            const azerothPath = toAzerothPath(fileName);
            return this.#readAzeroth(azerothPath) === undefined
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
    #resolveModules(
        literals: readonly ts.StringLiteralLike[],
        containingFile: string,
        options: ts.CompilerOptions
    ): ts.ResolvedModuleWithFailedLookupLocations[]
    {
        const dir = toSlashes(ts.sys.resolvePath(containingFile)).replace(/\/[^/]*$/, '');

        // A `.azeroth` source resolved to its virtual twin, in TS's result shape.
        const asAzeroth = (azerothPath: string): ts.ResolvedModuleWithFailedLookupLocations => ({
            resolvedModule:
            {
                resolvedFileName: toVirtualFile(azerothPath),
                extension: ts.Extension.Ts,
                isExternalLibraryImport: false
            }
        });

        return literals.map((literal) =>
        {
            const text = literal.text;
            const relative = text.startsWith('.') || text.startsWith('/');

            // Explicit `./x.azeroth`.
            if (relative && text.endsWith('.azeroth'))
            {
                const candidate = toSlashes(ts.sys.resolvePath(`${ dir }/${ text }`));
                if (this.#hostFileExists(toVirtualFile(candidate)))
                {
                    return asAzeroth(candidate);
                }
            }

            const base = ts.resolveModuleName(text, containingFile, options, ts.sys);

            // Extensionless relative import nothing else resolved (`./x.component`
            // for `x.component.azeroth`) - try the `.azeroth` sibling. Standard
            // resolution runs first, so a real `.ts` of the same name wins.
            if (!base.resolvedModule && relative && !text.endsWith('.azeroth'))
            {
                const candidate = toSlashes(ts.sys.resolvePath(`${ dir }/${ text }.azeroth`));
                if (this.#hostFileExists(toVirtualFile(candidate)))
                {
                    return asAzeroth(candidate);
                }
            }

            return base;
        });
    }

    /**
     * Discovers the nearest tsconfig and resolves both the compiler options the
     * virtual modules need (TS source, bundler resolution - keeping the
     * project's `paths`, `baseUrl`, `types`, `lib`) and the project's own
     * ambient/global declaration files.
     *
     * The ambient files matter: a Vite app's `src/vite-env.d.ts` carries
     * `/// <reference types="vite/client" />`, which augments `ImportMeta` with
     * `.env` and declares the `*.css` / `?url` asset modules. That `.d.ts` is
     * not a `.azeroth` file, so without explicitly adding it to the program its
     * global augmentations would never apply inside `.azeroth` - and
     * `import.meta.env.X` would wrongly report
     * "Property 'env' does not exist on type 'ImportMeta'", even though `tsc`
     * (which loads the same `.d.ts`) is happy.
     */
    static #resolveProject(
        currentDirectory: string,
        configPath?: string
    ): { options: ts.CompilerOptions; ambientFiles: string[]; projectFiles: string[]; configFileName: string | undefined; baseOptions: ts.CompilerOptions }
    {
        let options: ts.CompilerOptions = {};
        let ambientFiles: string[] = [];
        let projectFiles: string[] = [];
        const found = configPath ?? ts.findConfigFile(currentDirectory, (p) => ts.sys.fileExists(p), 'tsconfig.json');
        if (found)
        {
            const read = ts.readConfigFile(found, (p) => ts.sys.readFile(p));
            const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, found.replace(/[\\/][^\\/]*$/, ''));
            options = parsed.options;
            // The project's real source files (not `.d.ts`), so the combined
            // checker can type-check the `.ts` side in the same program as the
            // `.azeroth` files. AzerothJS projects are `.ts` + `.azeroth`.
            projectFiles = parsed.fileNames.filter(name => !name.endsWith('.d.ts')).map(toSlashes);
            // Keep the project's ambient/global declaration roots so their
            // augmentations (and ambient module declarations) apply inside
            // `.azeroth`. Only `.d.ts` files - pulling in every project `.ts`
            // would bloat the program and isn't needed for global typing.
            const roots = parsed.fileNames.filter(name => name.endsWith('.d.ts'));

            // Resolve `compilerOptions.types` the way tsc does (type reference
            // directives -> typeRoots / node_modules) and include each resolved
            // `.d.ts`. tsc loads these packages for their globals (e.g.
            // "vite/client" -> node_modules/vite/client.d.ts, which augments
            // `ImportMeta.env` and declares `*.png` / `?url`); including them
            // explicitly makes those augmentations apply inside `.azeroth` even
            // when the project has NO triple-slash `vite-env.d.ts`. The TS
            // program already includes `types` automatically, but a language
            // service host can miss them, so this guarantees parity with tsc.
            for (const typeName of options.types ?? [])
            {
                const resolved = ts.resolveTypeReferenceDirective(typeName, found, options, ts.sys)
                    .resolvedTypeReferenceDirective;
                if (resolved?.resolvedFileName)
                {
                    roots.push(resolved.resolvedFileName);
                }
            }

            // Zero-config Vite: if `vite/client` resolves (Vite is installed),
            // include its globals - `interface ImportMeta` (so `import.meta.env`
            // works) and the asset module declarations (`*.png`, `*.svg`, `?url`,
            // `?raw`, ...). This lets a consumer delete BOTH `src/vite-env.d.ts`
            // and the `"types": ["vite/client"]` tsconfig entry and still have
            // those resolve inside `.azeroth`. Harmless otherwise: resolution
            // fails when Vite isn't installed (nothing added), and a duplicate
            // (already pulled in via `types`/a `vite-env.d.ts`) is deduped below.
            const viteClient = ts.resolveTypeReferenceDirective('vite/client', found, options, ts.sys)
                .resolvedTypeReferenceDirective?.resolvedFileName;
            if (viteClient)
            {
                roots.push(viteClient);
            }

            ambientFiles = [...new Set(roots)];
        }

        return {
            options:
            {
                ...options,
                allowJs: true,
                checkJs: false,
                noEmit: true,
                module: options.module ?? ts.ModuleKind.ESNext,
                target: options.target ?? ts.ScriptTarget.ESNext,
                moduleResolution: options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
                allowImportingTsExtensions: true,
                skipLibCheck: true,
                lib: options.lib ?? ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts']
            },
            ambientFiles,
            projectFiles,
            configFileName: found ? toSlashes(found) : undefined,
            // The tsconfig's own options BEFORE the overrides above - the native backend
            // mirrors the same only-if-absent defaults when deriving its config.
            baseOptions: options
        };
    }
}
