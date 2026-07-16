// The NATIVE diagnostics backend for AzerothProject - the same virtual project the classic
// language service checks, mirrored onto the native TypeScript compiler. Opt-in per project
// instance (the command-line checker turns it on; the editor stays on the classic service,
// whose richer per-position APIs have no native equivalent yet). Diagnostics are raw and
// unfiltered here; the providers map and filter them exactly as they do the classic ones, so
// which engine answered is invisible to everything downstream.
//
// The project reaches the native server as a DERIVED virtual tsconfig: `extends` the real
// one (so paths/baseUrl/types/strictness carry over), overrides the same options the classic
// host overrides, and pins `files` to the exact root set the classic program uses. `.azeroth`
// modules are served through the filesystem overlay under their virtual `<path>.azeroth.ts`
// twins - the native resolver finds them by appending `.ts` to the import specifier, so no
// resolution hook is needed.

import ts from 'typescript';
import { loadNativeTs, adaptDiagnostics, type NativeApi, type NativeSnapshot, type NativeProject } from '@azerothjs/compiler';

/** The diagnostic fields the language-service consumers read; see {@link AzerothProject.rawTsDiagnostics}. */
export interface RawTsDiagnostic
{
    file: { fileName: string; getLineAndCharacterOfPosition(position: number): { line: number; character: number } } | undefined;
    start: number | undefined;
    length: number | undefined;
    code: number;
    category: ts.DiagnosticCategory;
    messageText: string | ts.DiagnosticMessageChain;
    relatedInformation?: readonly RawTsDiagnostic[] | undefined;
}

/** What the backend needs from the owning AzerothProject. */
export interface NativeBackendHost
{
    /** Workspace root (the derived tsconfig lives here virtually). */
    currentDirectory: string;

    /** The real tsconfig path the project resolved, if any. */
    configFileName: string | undefined;

    /** The tsconfig's own options BEFORE the host overrides (to mirror only-if-absent defaults). */
    baseOptions: ts.CompilerOptions;

    /** The exact program roots the classic host serves (intrinsics, ambients, projects, twins). */
    rootNames(): readonly string[];

    /** Monotonic project version; any content or file-set change bumps it. */
    version(): number;

    /** Virtual file contents: the intrinsics file and `<path>.azeroth.ts` projection twins. */
    virtualContent(fileName: string): string | undefined;

    /** Reads a `.azeroth` source (open buffer or disk); backs the extensionless-import fallback. */
    azerothSource(azerothPath: string): string | undefined;
}

/** A live native diagnostics backend; any failure returns null once and the backend is done. */
export interface NativeLsBackend
{
    /** Raw syntactic + semantic diagnostics for one program file, or null when the backend is unusable. */
    diagnosticsFor(fileName: string): RawTsDiagnostic[] | null;

    /** Shuts the spawned server down (idempotent). */
    close(): void;
}

function normalizeSlashes(p: string): string
{
    return p.replace(/\\/g, '/');
}

/**
 * Builds the backend, or returns null when the native API is not installed. One spawned
 * server per backend; the snapshot is re-synced lazily whenever the host's version moved.
 */
export function createNativeLsBackend(host: NativeBackendHost): NativeLsBackend | null
{
    const native = loadNativeTs();
    if (native === null)
    {
        return null;
    }

    const configPath = `${ normalizeSlashes(host.currentDirectory).replace(/\/$/, '') }/__azeroth_native_tsc__.json`;
    let configContent = '';

    const virtualRead = (fileName: string): string | undefined =>
    {
        const name = normalizeSlashes(fileName);
        if (name === configPath)
        {
            return configContent;
        }
        const known = host.virtualContent(name);
        if (known !== undefined)
        {
            return known;
        }
        // Extensionless-import fallback: the resolver probing `<x>.ts` where only
        // `<x>.azeroth` exists gets that module's projection; a real `<x>.ts` wins by
        // falling through to the real filesystem.
        if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.azeroth.ts') && !ts.sys.fileExists(fileName))
        {
            const sibling = `${ name.slice(0, -'.ts'.length) }.azeroth`;
            if (host.azerothSource(sibling) !== undefined)
            {
                return host.virtualContent(`${ sibling }.ts`);
            }
        }
        return undefined;
    };

    let api: NativeApi | null;
    try
    {
        api = new native.API({
            fs: {
                fileExists: (f) => (virtualRead(f) !== undefined ? true : undefined),
                readFile: (f) => virtualRead(f),
                realpath: (f) => (virtualRead(f) !== undefined ? f : undefined)
            }
        });
    }
    catch
    {
        return null;
    }

    let snapshot: NativeSnapshot | null = null;
    let project: NativeProject | null = null;
    let syncedVersion = -1;
    let syncedRootsKey = '';

    const close = (): void =>
    {
        try
        {
            snapshot?.dispose();
            api?.close();
        }
        catch
        {
            // Closing a dead server must not throw.
        }
        snapshot = null;
        project = null;
        api = null;
    };
    process.once('exit', close);

    /** Serializes the derived tsconfig from the real one plus the classic host's overrides. */
    const buildConfig = (roots: readonly string[]): string =>
    {
        const base = host.baseOptions;
        const overrides: Record<string, unknown> =
        {
            allowJs: true,
            checkJs: false,
            noEmit: true,
            allowImportingTsExtensions: true,
            skipLibCheck: true
        };
        if (base.module === undefined)
        {
            overrides.module = 'esnext';
        }
        if (base.target === undefined)
        {
            overrides.target = 'esnext';
        }
        if (base.moduleResolution === undefined)
        {
            overrides.moduleResolution = 'bundler';
        }
        if (base.lib === undefined)
        {
            overrides.lib = ['esnext', 'dom', 'dom.iterable'];
        }
        const config: Record<string, unknown> = { compilerOptions: overrides, files: roots };
        if (host.configFileName !== undefined)
        {
            config.extends = normalizeSlashes(host.configFileName);
        }
        return JSON.stringify(config);
    };

    /** Brings the snapshot up to the host's current version; returns the project or null on failure. */
    const sync = (): NativeProject | null =>
    {
        if (api === null)
        {
            return null;
        }
        const version = host.version();
        if (project !== null && version === syncedVersion)
        {
            return project;
        }
        const roots = host.rootNames();
        const rootsKey = roots.join('\n');
        // The file SET changed (or this is the first sync): rewrite the derived config so the
        // server sees the new roots. Content-only changes reuse the config as-is; either way
        // everything is revalidated - the server keeps unchanged files cheap internally.
        if (rootsKey !== syncedRootsKey)
        {
            configContent = buildConfig(roots);
            syncedRootsKey = rootsKey;
        }
        snapshot?.dispose();
        snapshot = api.updateSnapshot({ openProjects: [configPath], fileChanges: { invalidateAll: true } });
        const wanted = configPath.toLowerCase();
        project = snapshot.getProject(configPath)
            ?? snapshot.getProjects().find((candidate) => normalizeSlashes(candidate.configFileName).toLowerCase() === wanted)
            ?? null;
        syncedVersion = version;
        return project;
    };

    const contentOf = (fileName: string): string | undefined => virtualRead(fileName) ?? ts.sys.readFile(fileName);

    return {
        diagnosticsFor(fileName: string): RawTsDiagnostic[] | null
        {
            try
            {
                const current = sync();
                if (current === null)
                {
                    close();
                    return null;
                }
                const name = normalizeSlashes(fileName);
                const raw = [
                    ...current.program.getSyntacticDiagnostics(name),
                    ...current.program.getSemanticDiagnostics(name)
                ];
                return adaptDiagnostics(raw, contentOf);
            }
            catch
            {
                // A dead server or protocol failure ends the backend; the caller falls back to
                // the classic service with identical results.
                close();
                return null;
            }
        },
        close
    };
}
