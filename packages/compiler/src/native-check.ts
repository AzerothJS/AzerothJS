/**
 * MODULE: compiler/native-check - the type-check backends running on the NATIVE TypeScript compiler.
 *
 * Mirrors the two classic backends in typecheck-ts (the one-shot Program and the incremental
 * LanguageService) on top of the native API loaded by native-ts. The projection, the diagnostic
 * mapping, and the enforced-code filtering are UNCHANGED - only the engine producing raw
 * TypeScript diagnostics differs, so both backends are behavior-identical and the classic path
 * remains the fallback whenever the native API is unavailable or errors.
 *
 * How `.azeroth` files reach the native checker without a module-resolution hook: the native
 * resolver, given `import './child.azeroth'`, appends `.ts` and probes `child.azeroth.ts` -
 * exactly the virtual-twin naming this codebase already uses - and the filesystem overlay
 * answers that probe with the dependency's projection. Extensionless relative imports
 * (`./child` for `child.azeroth`) are served the same way under `child.ts` when no real file
 * of that name exists. Everything not virtual falls through the overlay to the real
 * filesystem, so node_modules and lib files resolve natively.
 */

import { existsSync } from 'node:fs';

import { loadNativeTs, adaptDiagnostics, type AdaptedDiagnostic, type NativeApi, type NativeProject } from './native-ts.ts';
import { generateVirtualCode } from './project.ts';

/** Raw (unmapped) diagnostics for one checked module, in classic field shape. */
export interface NativeCheckResult
{
    syntactic: AdaptedDiagnostic[];
    semantic: AdaptedDiagnostic[];
}

/** Reads a `.azeroth` source by absolute path (open buffer, test fixture, or disk). */
type ReadAzeroth = (path: string) => string | undefined;

/** The compiler options every check runs under, as tsconfig JSON (mirrors the classic backend's options). */
const CHECK_OPTIONS_JSON =
{
    target: 'esnext',
    lib: ['esnext', 'dom'],
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    moduleResolution: 'bundler',
    module: 'esnext'
} as const;

function normalizeSlashes(p: string): string
{
    return p.replace(/\\/g, '/');
}

function dirOf(p: string): string
{
    const n = normalizeSlashes(p);
    const i = n.lastIndexOf('/');
    return i <= 0 ? '.' : n.slice(0, i);
}

// One native client per process, shared by every check session. Its filesystem overlay
// delegates to whichever session is active - calls are synchronous and single-threaded, so a
// session installs itself, runs, and the store stays consistent for the whole call.
interface Session
{
    /** Fixed virtual contents (the tsconfig, the file under check, incremental overrides). */
    store: Map<string, string>;
    /** Reads dependency `.azeroth` sources for on-demand projection. */
    readAzeroth: ReadAzeroth;
    /** Projections computed for this session, keyed by virtual `.ts` path. */
    projections: Map<string, string | undefined>;
}

let api: NativeApi | null | undefined;
let activeSession: Session | null = null;

/** Projects the `.azeroth` source behind a probed virtual path, caching per session. */
function projectionFor(session: Session, tsPath: string, azerothPath: string): string | undefined
{
    if (session.projections.has(tsPath))
    {
        return session.projections.get(tsPath);
    }
    let code: string | undefined;
    const source = session.readAzeroth(azerothPath);
    if (source !== undefined)
    {
        try
        {
            code = generateVirtualCode(source).code;
        }
        catch
        {
            // A malformed dependency projects to nothing -> its imports type as `any` (a false
            // negative), never a false error in the file under check.
            code = undefined;
        }
    }
    session.projections.set(tsPath, code);
    return code;
}

/**
 * Serves a virtual read for the active session, or undefined to fall back to the real
 * filesystem. Two virtual families: `<x>.azeroth.ts` (a projection twin, probed when the
 * import names `.azeroth` explicitly) and `<x>.ts` where only `<x>.azeroth` exists (the
 * extensionless-import fallback; a real `<x>.ts` always wins).
 */
function virtualRead(fileName: string): string | undefined
{
    const session = activeSession;
    if (session === null)
    {
        return undefined;
    }
    const name = normalizeSlashes(fileName);
    const stored = session.store.get(name);
    if (stored !== undefined)
    {
        return stored;
    }
    if (name.endsWith('.azeroth.ts'))
    {
        return projectionFor(session, name, name.slice(0, -'.ts'.length));
    }
    if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !existsSync(fileName))
    {
        const azerothSibling = `${ name.slice(0, -'.ts'.length) }.azeroth`;
        if (session.readAzeroth(azerothSibling) !== undefined)
        {
            return projectionFor(session, name, azerothSibling);
        }
    }
    return undefined;
}

/** Lazily spawns the shared native client (or resolves to null when the native API is absent). */
function getApi(): NativeApi | null
{
    if (api !== undefined)
    {
        return api;
    }
    const native = loadNativeTs();
    if (native === null)
    {
        api = null;
        return api;
    }
    try
    {
        api = new native.API({
            fs: {
                fileExists: (f) => (virtualRead(f) !== undefined ? true : undefined),
                readFile: (f) => virtualRead(f),
                directoryExists: (d) =>
                {
                    // A directory that only exists because virtual files live in it must be
                    // claimed, or the server's directory checks would reject the project root.
                    const session = activeSession;
                    if (session === null)
                    {
                        return undefined;
                    }
                    const prefix = `${ normalizeSlashes(d).replace(/\/$/, '') }/`;
                    for (const key of session.store.keys())
                    {
                        if (key.startsWith(prefix))
                        {
                            return true;
                        }
                    }
                    return undefined;
                },
                realpath: (f) => (virtualRead(f) !== undefined ? f : undefined)
            }
        });
        // The client holds a spawned server; close it with the process so no child outlives us.
        process.once('exit', () =>
        {
            try
            {
                api?.close();
            }
            catch
            {
                // Exit-time close is best effort.
            }
        });
    }
    catch
    {
        api = null;
    }
    return api;
}

/** Marks the native backend unusable for the rest of the process (a spawn or protocol failure). */
function disableNative(): void
{
    try
    {
        api?.close();
    }
    catch
    {
        // The client may already be dead; disabling must not throw.
    }
    api = null;
}

/**
 * One-shot native check of a single projected module: builds a minimal virtual project around
 * it, collects the module's syntactic + semantic diagnostics, and closes the project again.
 * Returns null when the native backend is unavailable - the caller falls back to the classic
 * Program with identical results.
 */
export function nativeCheckOnce(mainTsPath: string, mainCode: string, readAzeroth: ReadAzeroth): NativeCheckResult | null
{
    const client = getApi();
    if (client === null)
    {
        return null;
    }

    const main = normalizeSlashes(mainTsPath);
    const configPath = `${ dirOf(main) }/__azeroth_native_check__.json`;
    const session: Session =
    {
        store: new Map([
            [configPath, JSON.stringify({ compilerOptions: CHECK_OPTIONS_JSON, files: [main] })],
            [main, mainCode]
        ]),
        readAzeroth,
        projections: new Map()
    };

    activeSession = session;
    try
    {
        const snapshot = client.updateSnapshot({ openProjects: [configPath], fileChanges: { invalidateAll: true } });
        try
        {
            const project = snapshot.getProject(configPath) ?? findProject(snapshot.getProjects(), configPath);
            if (project === undefined)
            {
                return null;
            }
            return {
                syntactic: adaptDiagnostics(project.program.getSyntacticDiagnostics(main)),
                semantic: adaptDiagnostics(project.program.getSemanticDiagnostics(main))
            };
        }
        finally
        {
            snapshot.dispose();
            client.updateSnapshot({ closeProjects: [configPath] }).dispose();
        }
    }
    catch
    {
        // Any failure downgrades to the classic path for the rest of the process; behavior is
        // identical there, so nothing is lost but speed.
        disableNative();
        return null;
    }
    finally
    {
        activeSession = null;
    }
}

/** Matches a project by config path regardless of slash direction or drive-letter casing. */
function findProject(projects: readonly NativeProject[], configPath: string): NativeProject | undefined
{
    const wanted = normalizeSlashes(configPath).toLowerCase();
    return projects.find((project) => normalizeSlashes(project.configFileName).toLowerCase() === wanted);
}

/** The incremental native backend: one long-lived project whose roots and contents evolve. */
export interface NativeIncrementalBackend
{
    /** Registers virtual root paths (the `<x>.azeroth.ts` twins) without checking them. */
    prime(tsPaths: readonly string[]): void;

    /** Checks one module from its current projection, returning raw diagnostics for it. */
    check(tsPath: string, code: string): NativeCheckResult | null;
}

/**
 * Builds the incremental backend, or returns null when the native API is unavailable. The
 * session persists across checks: roots accumulate in one virtual tsconfig, projections of
 * unchanged files are reused server-side, and a content change invalidates just that file -
 * the same cost model as the classic incremental checker, on the native engine.
 */
export function createNativeIncrementalBackend(readAzeroth: ReadAzeroth): NativeIncrementalBackend | null
{
    if (getApi() === null)
    {
        return null;
    }

    const roots = new Set<string>();
    const session: Session = { store: new Map(), readAzeroth, projections: new Map() };
    let configPath: string | null = null;
    let rootsDirty = true;

    const syncConfig = (firstRoot: string): string =>
    {
        configPath ??= `${ dirOf(firstRoot) }/__azeroth_native_incremental__.json`;
        session.store.set(configPath, JSON.stringify({ compilerOptions: CHECK_OPTIONS_JSON, files: [...roots] }));
        return configPath;
    };

    return {
        prime(tsPaths: readonly string[]): void
        {
            for (const tsPath of tsPaths)
            {
                const name = normalizeSlashes(tsPath);
                if (!roots.has(name))
                {
                    roots.add(name);
                    rootsDirty = true;
                }
            }
        },

        check(tsPath: string, code: string): NativeCheckResult | null
        {
            const client = getApi();
            if (client === null)
            {
                return null;
            }
            const name = normalizeSlashes(tsPath);
            if (!roots.has(name))
            {
                roots.add(name);
                rootsDirty = true;
            }
            const contentChanged = session.store.get(name) !== code;
            session.store.set(name, code);
            // The stored override supersedes any projection cached from disk for this path.
            session.projections.delete(name);

            activeSession = session;
            try
            {
                const config = syncConfig(name);
                const snapshot = client.updateSnapshot({
                    openProjects: [config],
                    fileChanges: rootsDirty ? { invalidateAll: true } : { changed: contentChanged ? [name] : [] }
                });
                rootsDirty = false;
                try
                {
                    const project = snapshot.getProject(config) ?? findProject(snapshot.getProjects(), config);
                    if (project === undefined)
                    {
                        return null;
                    }
                    return {
                        syntactic: adaptDiagnostics(project.program.getSyntacticDiagnostics(name)),
                        semantic: adaptDiagnostics(project.program.getSemanticDiagnostics(name))
                    };
                }
                finally
                {
                    snapshot.dispose();
                }
            }
            catch
            {
                disableNative();
                return null;
            }
            finally
            {
                activeSession = null;
            }
        }
    };
}
