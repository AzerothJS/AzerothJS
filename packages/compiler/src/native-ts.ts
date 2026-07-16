/**
 * MODULE: compiler/native-ts - loader for the NATIVE TypeScript compiler's API.
 *
 * TypeScript 7 ships the type checker as a native executable whose JS-facing API lives under
 * `typescript/unstable/sync`: a synchronous client that spawns the native server and exposes
 * projects, programs, and diagnostics over IPC, with a virtual-filesystem hook. The classic
 * in-process compiler API does not exist in that package, so this module is the ONE seam
 * through which AzerothJS talks to the native checker: it loads the API if it is installed
 * (under either the repo's `tsc7` alias or a consumer's `typescript` >= 7), spawns one client
 * per filesystem overlay, and adapts native diagnostics to the classic field names the rest of
 * the tooling consumes. Everything else keeps importing the classic `typescript` package.
 *
 * When the native API is NOT installed (or fails to spawn), every entry point here returns
 * null and callers fall back to their classic implementation - behavior is identical either
 * way, the native path is purely a speed upgrade. Set AZEROTH_NATIVE_TS=0 to force the
 * classic path (used by parity tests to compare both backends).
 */

import { createRequire } from 'node:module';

/** Virtual-filesystem callbacks delegated to the native server. Returning undefined falls back to the real filesystem. */
export interface NativeFileSystem
{
    fileExists?: (fileName: string) => boolean | undefined;
    readFile?: (fileName: string) => string | null | undefined;
    directoryExists?: (directoryName: string) => boolean | undefined;
    getAccessibleEntries?: (directoryName: string) => { files: string[]; directories: string[] } | undefined;
    realpath?: (path: string) => string | undefined;
}

/** A diagnostic as the native server reports it: flat text, absolute positions. */
export interface NativeDiagnostic
{
    readonly fileName?: string | undefined;
    readonly pos: number;
    readonly end: number;
    readonly code: number;
    /** Same numeric values as the classic DiagnosticCategory (Warning 0, Error 1, Suggestion 2, Message 3). */
    readonly category: number;
    readonly text: string;
    readonly relatedInformation?: readonly NativeDiagnostic[] | undefined;
}

/** The per-file diagnostic surface of a native program. */
export interface NativeProgram
{
    getSyntacticDiagnostics(file?: string): readonly NativeDiagnostic[];
    getSemanticDiagnostics(file?: string): readonly NativeDiagnostic[];
    getSourceFileNames(): readonly string[];
}

/** One configured project inside a snapshot. */
export interface NativeProject
{
    readonly configFileName: string;
    readonly program: NativeProgram;
}

/** An immutable view of the projects at one point in time; dispose when done. */
export interface NativeSnapshot
{
    getProjects(): readonly NativeProject[];
    getProject(configFileName: string): NativeProject | undefined;
    dispose(): void;
}

/** Snapshot-update request: which tsconfigs to (keep) open and what changed since last time. */
export interface NativeUpdateParams
{
    openProjects?: string[];
    closeProjects?: string[];
    fileChanges?: { changed?: string[]; created?: string[]; deleted?: string[] } | { invalidateAll: true };
}

/** The synchronous native API client (one spawned server per instance). */
export interface NativeApi
{
    updateSnapshot(params?: NativeUpdateParams): NativeSnapshot;
    close(): void;
}

interface NativeModule
{
    API: new (options: { fs?: NativeFileSystem }) => NativeApi;
}

/**
 * A native diagnostic re-shaped to the classic field names (`start`/`length`/`messageText`)
 * so it can flow through the same mapping code as a classic `ts.Diagnostic`. `file` carries
 * just enough for position formatting; it is undefined when the diagnostic has no file or the
 * caller supplied no content reader.
 */
export interface AdaptedDiagnostic
{
    file: { fileName: string; getLineAndCharacterOfPosition(position: number): { line: number; character: number } } | undefined;
    start: number;
    length: number;
    code: number;
    category: number;
    messageText: string;
    relatedInformation?: AdaptedDiagnostic[];
}

// The module is loaded once per process and the result (including failure) is sticky: if the
// native API is absent or broken we do not retry per call - callers land on the classic path
// for the life of the process.
let cached: NativeModule | null | undefined;

/**
 * Loads the native TypeScript API, or returns null when it is not installed. Resolution order:
 * the monorepo's `tsc7` alias first, then plain `typescript` (a consumer on TypeScript 7 has
 * the API under the real package name; on 6 the specifier does not exist and resolution moves
 * on). Loading is synchronous - the compile pipeline is synchronous.
 */
export function loadNativeTs(): NativeModule | null
{
    if (cached !== undefined)
    {
        return cached;
    }
    if (process.env.AZEROTH_NATIVE_TS === '0')
    {
        cached = null;
        return cached;
    }
    // Anchor createRequire at THIS module's URL when available (ESM), else the cwd - so a CJS
    // bundle (the editor language-server ships one), where `import.meta.url` is empty, still
    // resolves against the real node_modules instead of throwing on an empty specifier base.
    const base = import.meta.url && import.meta.url.length > 0
        ? import.meta.url
        : `${ process.cwd().replace(/\\/g, '/') }/index.js`;
    const require = createRequire(base);
    for (const specifier of ['tsc7/unstable/sync', 'typescript/unstable/sync'])
    {
        try
        {
            const mod = require(specifier) as NativeModule;
            if (typeof mod.API === 'function')
            {
                cached = mod;
                return cached;
            }
        }
        catch
        {
            // Not installed under this name - try the next one.
        }
    }
    cached = null;
    return cached;
}

/**
 * Re-shapes native diagnostics to the classic field names. `contentOf` (optional) supplies
 * file contents for line/character lookup shims; without it `file` stays undefined, which the
 * offset-based consumers never touch.
 */
export function adaptDiagnostics(
    diagnostics: readonly NativeDiagnostic[],
    contentOf?: (fileName: string) => string | undefined
): AdaptedDiagnostic[]
{
    const shims = new Map<string, AdaptedDiagnostic['file']>();

    const shimFor = (fileName: string | undefined): AdaptedDiagnostic['file'] =>
    {
        if (fileName === undefined || contentOf === undefined)
        {
            return undefined;
        }
        const known = shims.get(fileName);
        if (known !== undefined)
        {
            return known;
        }
        const content = contentOf(fileName);
        const shim = content === undefined ? undefined : lineShim(fileName, content);
        shims.set(fileName, shim);
        return shim;
    };

    const adaptOne = (diagnostic: NativeDiagnostic): AdaptedDiagnostic =>
    {
        const adapted: AdaptedDiagnostic =
        {
            file: shimFor(diagnostic.fileName),
            start: diagnostic.pos,
            length: diagnostic.end - diagnostic.pos,
            code: diagnostic.code,
            category: diagnostic.category,
            messageText: diagnostic.text
        };
        if (diagnostic.relatedInformation !== undefined && diagnostic.relatedInformation.length > 0)
        {
            adapted.relatedInformation = diagnostic.relatedInformation.map(adaptOne);
        }
        return adapted;
    };

    return diagnostics.map(adaptOne);
}

/** A minimal SourceFile stand-in: file name plus offset -> line/character over known content. */
function lineShim(fileName: string, content: string): NonNullable<AdaptedDiagnostic['file']>
{
    // Line starts are computed lazily once; diagnostics per file are few.
    let starts: number[] | null = null;
    const lineStarts = (): number[] =>
    {
        if (starts !== null)
        {
            return starts;
        }
        starts = [0];
        for (let i = 0; i < content.length; i++)
        {
            if (content.charCodeAt(i) === 10)
            {
                starts.push(i + 1);
            }
        }
        return starts;
    };

    return {
        fileName,
        getLineAndCharacterOfPosition: (position: number) =>
        {
            const all = lineStarts();
            let low = 0;
            let high = all.length - 1;
            while (low < high)
            {
                const mid = (low + high + 1) >> 1;
                if ((all[mid] ?? 0) <= position)
                {
                    low = mid;
                }
                else
                {
                    high = mid - 1;
                }
            }
            return { line: low, character: position - (all[low] ?? 0) };
        }
    };
}
