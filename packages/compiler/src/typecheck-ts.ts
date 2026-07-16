/**
 * MODULE: compiler/typecheck-ts - the type-checking layer (real TypeScript Program backend).
 *
 * A genuine TypeScript-backed checker. It lowers an `.azeroth` module to TypeScript through the SINGLE
 * shared projection ({@link generateVirtualCode} - the same one the editor language service, the
 * TypeScript plugin, and the declaration emitter use), builds a real `ts.Program` over a `ts.CompilerHost`,
 * and uses the real `TypeChecker` (via `getSemanticDiagnostics`) as the AUTHORITY on types. Diagnostics
 * are mapped back to `.azeroth` spans through the projection's {@link CodeMapping}. There is no second
 * lowering here: this module only chooses WHICH of the real type errors to surface.
 *
 * WHAT IT SURFACES (sound - no false positives):
 *   - COMPONENT PROPS: a wrong-typed `<Child a={x} />` is a real assignability error on `Child({ a: (x) })`,
 *     mapped to the attribute. Markup CHILDREN are an `any`-typed spread (`...__children`), so passing
 *     children to a component is never a false error.
 *   - MISSING required props: `<Card/>` projects to `Card({})`; the missing-prop error lands on the
 *     synthesized argument (generated scaffolding) and is anchored to the component tag.
 *   - EVENT HANDLERS on host elements: `onClick={...}` projects to `(...) satisfies AzerothHandler<'onClick'>`,
 *     so a non-function handler is a real `satisfies` failure (TS 1360).
 *
 * SOUNDNESS: only diagnostics that map to an ATTRIBUTE segment (a provided prop / handler value), a
 * handler `satisfies` (1360), or the missing-argument scaffolding before a component TAG are surfaced;
 * a diagnostic anywhere else (component body, an initializer, a child render) is dropped. Combined with an
 * enforced-code allowlist ({@link ENFORCED_CODES}), the checker stays free of false positives.
 *
 * Cross-file: a relative import of another `.azeroth` file resolves, through the real module resolver, to
 * that file's projection, so component prop types cross file boundaries.
 *
 * STAGED: this runs as an OPT-IN check (see the `azeroth` plugin's `typeCheck` option), not the silent
 * default, until the projection is exercised widely enough to make it the always-on gate.
 */

import * as ts from 'typescript';

import type { CodeMapping } from './mapping.ts';
import type { AzerothDiagnostic } from './diagnostics.ts';

import { parseModule } from './parser.ts';
import { generateVirtualCode } from './project.ts';
import { nativeCheckOnce, createNativeIncrementalBackend } from './native-check.ts';

/**
 * The diagnostic fields the mappers consume. Both the classic `ts.Diagnostic` and the
 * native-adapted diagnostic satisfy it structurally, so one mapping implementation serves
 * whichever engine produced the raw diagnostics.
 */
interface DiagnosticLike
{
    start?: number | undefined;
    length?: number | undefined;
    code: number;
    messageText: string | ts.DiagnosticMessageChain;
}

/** Optional inputs that enable cross-file resolution. */
export interface TypeCheckOptions
{
    /** Path of the `.azeroth` module being checked; relative imports resolve against its directory. */
    fileName?: string;
    /** Reads a dependency `.azeroth` file (for tests / virtual filesystems). Default: `ts.sys.readFile`. */
    readFile?: (path: string) => string | undefined;
}

/** A diagnostic class this checker surfaces, used as the public code. */
type CheckCode = 'azeroth/handler-type' | 'azeroth/prop-type' | 'azeroth/prop-missing' | 'azeroth/syntax';

/** Human-readable prefix for each diagnostic class. */
const MESSAGE_PREFIX: Record<CheckCode, string> =
{
    'azeroth/handler-type': 'Event handler must be a function',
    'azeroth/prop-type': 'Component prop type mismatch',
    'azeroth/prop-missing': 'Component is missing a required prop',
    'azeroth/syntax': 'Syntax error'
};

const COMPILER_OPTIONS: ts.CompilerOptions =
{
    target: ts.ScriptTarget.ESNext,
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    noLib: false,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext
};

/**
 * The TypeScript diagnostic codes we ENFORCE - genuine type-safety failures only:
 *   1360 Type X does not satisfy the expected type   (a non-function host event handler)
 *   2322 Type X is not assignable to type Y           (wrong-typed prop / on* component prop)
 *   2345 Argument of type X not assignable to param   (missing/!assignable component props)
 *   2353 Object literal may only specify known props  (a typo'd / unknown component prop)
 *   2739 Type X is missing properties from type Y     (missing component props, member-level report)
 *   2741 Property P is missing in type X              (one missing component prop, member-level report)
 *   2769 No overload matches this call                (overloaded handler/prop signatures)
 * 2739/2741 are the same missing-prop failure as 2345 reported at member level - which engine picks which
 * wording differs (the native checker favors the member-level codes), and the editor's component-prop set
 * enforces all three, so the gate must too. Everything else (e.g. "cannot find name" projection-gap noise,
 * "property does not exist") is dropped, so the checker stays sound (no false positives) at the cost of
 * some false negatives, by design.
 */
const ENFORCED_CODES: ReadonlySet<number> = new Set([1360, 2322, 2345, 2353, 2739, 2741, 2769]);

// The TypeScript lib directory and a process-lifetime cache of its parsed SourceFiles - large, immutable
// `.d.ts` files whose re-parse dominates per-file cost; reused across every Program build.
const LIB_DIR = ts.getDefaultLibFilePath(COMPILER_OPTIONS).replace(/[\\/][^\\/]*$/, '');
const libSourceCache = new Map<string, ts.SourceFile>();

// --- path helpers (avoid TS-internal path APIs, which are not part of the public typings) ---

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

/** Resolves a relative specifier against a directory, collapsing `.`/`..` segments. */
function resolvePath(dir: string, rel: string): string
{
    const r = normalizeSlashes(rel);
    if (r.startsWith('/') || /^[A-Za-z]:/.test(r))
    {
        return r;
    }
    const stack: string[] = [];
    for (const part of (normalizeSlashes(dir) + '/' + r).split('/'))
    {
        if (part === '' || part === '.')
        {
            continue;
        }
        if (part === '..')
        {
            stack.pop();
        }
        else
        {
            stack.push(part);
        }
    }
    return (normalizeSlashes(dir).startsWith('/') ? '/' : '') + stack.join('/');
}

// --- the Program host (with cross-file `.azeroth` projection) ---

/**
 * Builds a CompilerHost that serves the main module's projection and, on demand, the projection of any
 * sibling `.azeroth` file reached through a relative import. Virtual TS paths are the real `.azeroth` path
 * plus a `.ts` suffix.
 */
function createHost(mainAzerothPath: string, mainProjected: string, options: TypeCheckOptions): { host: ts.CompilerHost; mainTsPath: string }
{
    const sys = ts.sys;
    const readAzeroth = options.readFile ?? ((path: string): string | undefined => sys.readFile(path));
    const mainTsPath = mainAzerothPath + '.ts';
    const projectionCache = new Map<string, string | undefined>();

    // Returns the projected TS for a virtual `.azeroth.ts` path, or undefined if it can't be made.
    const projectedFor = (tsPath: string): string | undefined =>
    {
        if (tsPath === mainTsPath)
        {
            return mainProjected;
        }
        if (!tsPath.endsWith('.azeroth.ts'))
        {
            return undefined;
        }
        if (projectionCache.has(tsPath))
        {
            return projectionCache.get(tsPath);
        }
        const azerothPath = tsPath.slice(0, -'.ts'.length);
        let projected: string | undefined;
        const depSource = readAzeroth(azerothPath);
        if (depSource !== undefined)
        {
            try
            {
                projected = generateVirtualCode(depSource).code;
            }
            catch
            {
                // A malformed dependency resolves to nothing -> imported symbols become `any` (a false
                // negative), never a false error in the file under check.
                projected = undefined;
            }
        }
        projectionCache.set(tsPath, projected);
        return projected;
    };

    // Resolves a relative `.azeroth` specifier to its real path, or undefined.
    const resolveAzeroth = (spec: string, containingFile: string): string | undefined =>
    {
        if (!spec.startsWith('.'))
        {
            return undefined;
        }
        const base = resolvePath(dirOf(containingFile), spec);
        const candidates = base.endsWith('.azeroth') ? [base] : [`${ base }.azeroth`];
        for (const candidate of candidates)
        {
            if (readAzeroth(candidate) !== undefined)
            {
                return candidate;
            }
        }
        return undefined;
    };

    const host: ts.CompilerHost =
    {
        fileExists: (f) =>
        {
            if (f === mainTsPath)
            {
                return true;
            }
            if (f.endsWith('.azeroth.ts'))
            {
                return projectedFor(f) !== undefined;
            }
            return sys.fileExists(f);
        },
        readFile: (f) =>
        {
            if (f === mainTsPath || f.endsWith('.azeroth.ts'))
            {
                return projectedFor(f);
            }
            return sys.readFile(f);
        },
        getSourceFile: (f, languageVersion) =>
        {
            // Virtual files (the main module + projected `.azeroth` deps) are read fresh each call.
            if (f === mainTsPath || f.endsWith('.azeroth.ts'))
            {
                const text = projectedFor(f);
                return text === undefined ? undefined : ts.createSourceFile(f, text, languageVersion, true);
            }
            // Real files: reuse a cached parse for immutable lib files across Program builds.
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
        writeFile: () => undefined,
        getCurrentDirectory: () => sys.getCurrentDirectory(),
        getCanonicalFileName: (f) => f,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        directoryExists: (d) => sys.directoryExists(d),
        getDirectories: (d) => sys.getDirectories(d),

        // Resolve relative `.azeroth` imports to their projection; delegate the rest to TypeScript.
        resolveModuleNameLiterals: (literals, containingFile, _redirect, opts) =>
            literals.map((literal) =>
            {
                const azerothPath = resolveAzeroth(literal.text, containingFile);
                if (azerothPath !== undefined)
                {
                    return {
                        resolvedModule: {
                            resolvedFileName: `${ azerothPath }.ts`,
                            extension: ts.Extension.Ts,
                            isExternalLibraryImport: false
                        }
                    };
                }
                const resolved = ts.resolveModuleName(literal.text, containingFile, opts, {
                    fileExists: (f) => sys.fileExists(f),
                    readFile: (f) => sys.readFile(f)
                });
                return { resolvedModule: resolved.resolvedModule };
            })
    };

    return { host, mainTsPath };
}

/**
 * typeCheckModuleTS
 *
 * Returns every type error the real TypeChecker finds in a component-prop or handler position, mapped
 * back to `.azeroth` source spans. With `options.fileName`, relative imports of other `.azeroth` files are
 * resolved and checked.
 *
 * @param source - The `.azeroth` module source.
 * @param options - Optional file path + dependency reader enabling cross-file resolution.
 * @returns Type-level diagnostics (severity 'error'), located in the original source.
 * @internal
 */
export function typeCheckModuleTS(source: string, options: TypeCheckOptions = {}): AzerothDiagnostic[]
{
    const module = parseModule(source);
    if (!module.items.some((i) => i.kind === 'component'))
    {
        return [];
    }

    const { code, mapping } = generateVirtualCode(source);
    const mainAzerothPath = normalizeSlashes(options.fileName ?? '/virtual/__main__.azeroth');

    // The native engine first: same projection, same mapping, same filtering - only the raw
    // diagnostics come from the native compiler. Unavailable or failed -> the classic Program.
    const readAzeroth = options.readFile ?? ((path: string): string | undefined => ts.sys.readFile(path));
    const native = nativeCheckOnce(`${ mainAzerothPath }.ts`, code, readAzeroth);
    if (native !== null)
    {
        return [
            ...mapSyntacticDiagnostics(native.syntactic, mapping),
            ...mapDiagnostics(native.semantic, mapping)
        ];
    }

    const { host, mainTsPath } = createHost(mainAzerothPath, code, options);
    const program = ts.createProgram([mainTsPath], COMPILER_OPTIONS, host);
    const sourceFile = program.getSourceFile(mainTsPath);
    if (sourceFile === undefined)
    {
        return [];
    }

    // Syntactic errors first: if the projection doesn't parse, semantic results are unreliable, so a
    // parse error (e.g. an unterminated string in an initializer) must fail the build with a located
    // message rather than letting broken JS through the gate.
    const syntactic = mapSyntacticDiagnostics(program.getSyntacticDiagnostics(sourceFile), mapping);
    return [...syntactic, ...mapDiagnostics(program.getSemanticDiagnostics(sourceFile), mapping)];
}

/**
 * Maps a projected module's raw TypeScript semantic diagnostics back to located `.azeroth` diagnostics:
 * keeps only the ENFORCED codes and anchors each one (a handler `satisfies` failure [1360] -> the
 * handler value; a wrong-typed provided prop -> its attribute; a missing-prop error on generated
 * scaffolding -> the component tag). Shared by the one-shot {@link typeCheckModuleTS} and the
 * incremental {@link createIncrementalChecker} so both produce identical results.
 */
function mapDiagnostics(diagnostics: readonly DiagnosticLike[], mapping: CodeMapping): AzerothDiagnostic[]
{
    const out: AzerothDiagnostic[] = [];
    for (const diagnostic of diagnostics)
    {
        if (diagnostic.start === undefined || !ENFORCED_CODES.has(diagnostic.code))
        {
            continue;
        }
        const start = diagnostic.start;
        const end = start + (diagnostic.length ?? 0);
        const detail = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
        const seg = mapping.segmentAt(start);

        // A handler `satisfies` failure (1360) is always an event-handler check (the only `satisfies` the
        // projection emits). TypeScript reports it at the `satisfies` keyword - generated scaffolding -
        // so anchor it to the handler value, the attribute segment immediately before.
        if (diagnostic.code === 1360)
        {
            const handlerSeg = seg ?? mapping.nearestSegmentBefore(start);
            if (handlerSeg !== null)
            {
                out.push(make('azeroth/handler-type', detail, handlerSeg.sourceStart, handlerSeg.sourceEnd));
            }
            continue;
        }

        if (seg !== null)
        {
            // A wrong-typed PROVIDED prop (or handler) value -> the attribute it was written on.
            if (seg.kind !== 'attribute')
            {
                continue;
            }
            const range = mapping.toOriginalRange(start, end) ?? { start: seg.sourceStart, end: seg.sourceEnd };
            out.push(make('azeroth/prop-type', detail, range.start, range.end));
            continue;
        }

        // Generated scaffolding (e.g. the synthesized `({ ... })` of a component call missing a required
        // prop): anchor to the component tag that precedes it, widened to include the opening `<`.
        const anchor = mapping.nearestSegmentBefore(start);
        if (anchor !== null && anchor.kind === 'tag')
        {
            out.push(make('azeroth/prop-missing', detail, anchor.sourceStart - 1, anchor.sourceEnd));
        }
    }

    return out;
}

/**
 * Maps the projection's SYNTACTIC diagnostics back to source. A syntax error in the user's code (an
 * unterminated string/template/comment, a stray token, a malformed expression) makes the projected
 * TypeScript fail to parse; without this the build gate - which only consulted semantic diagnostics -
 * passed silently and emitted broken JS. Unlike semantic diagnostics these are NOT code-filtered (a
 * parse error is unconditionally fatal) and need no prop/handler anchoring: the failing token maps
 * straight back through the verbatim segment it sits in. Diagnostics that land purely in generated
 * scaffolding (no source mapping and no preceding source segment) are dropped - they reflect an
 * internal projection issue, not the user's code, and surface via the editor's own checks.
 */
function mapSyntacticDiagnostics(diagnostics: readonly DiagnosticLike[], mapping: CodeMapping): AzerothDiagnostic[]
{
    const out: AzerothDiagnostic[] = [];
    for (const diagnostic of diagnostics)
    {
        if (diagnostic.start === undefined)
        {
            continue;
        }
        const start = diagnostic.start;
        const end = start + (diagnostic.length ?? 0);
        const detail = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');

        const range = mapping.toOriginalRange(start, end);
        if (range !== null)
        {
            out.push(make('azeroth/syntax', detail, range.start, range.end));
            continue;
        }

        // The exact span didn't map (it straddles a boundary or sits in scaffolding); anchor to the
        // nearest preceding source segment so the error still lands near its cause rather than nowhere.
        const anchor = mapping.nearestSegmentBefore(start);
        if (anchor !== null)
        {
            out.push(make('azeroth/syntax', detail, anchor.sourceStart, anchor.sourceEnd));
        }
    }
    return out;
}

/**
 * An INCREMENTAL `.azeroth` type-checker backed by ONE `ts.LanguageService`. Where
 * {@link typeCheckModuleTS} builds a fresh `ts.Program` per call - re-binding `lib.d.ts` every time, a
 * fixed cost of ~hundreds of ms regardless of file size - a checker binds the lib ONCE and reuses it,
 * so checking a project of N files costs ~one program build + N cheap incremental checks instead of N
 * full program builds. The Vite plugin holds one per build and calls {@link AzerothTypeChecker.check}
 * per file. Diagnostics are identical to {@link typeCheckModuleTS} (same projection, options, and
 * {@link mapDiagnostics}).
 */
export interface AzerothTypeChecker
{
    /**
     * Registers files as roots WITHOUT checking them, so the first {@link check} builds ONE Program over
     * the whole set (lib + every file bound once) rather than growing the root set check-by-check (which
     * forces an incremental rebuild each time). Call with all the project's `.azeroth` files up front.
     */
    prime(fileNames: readonly string[]): void;

    /** Type-checks one `.azeroth` module from its current `source`, returning located `.azeroth` diagnostics. */
    check(fileName: string, source: string): AzerothDiagnostic[];
}

/**
 * Builds an {@link AzerothTypeChecker} backed by one reused `ts.LanguageService`. Use this (over calling
 * {@link typeCheckModuleTS} per file) to check several files in a build: `prime()` the file set once, then
 * `check()` each, so the lib and program are bound a single time.
 *
 * @param options - Cross-file resolution options (see {@link TypeCheckOptions}).
 * @returns A reusable incremental checker.
 */
export function createIncrementalChecker(options: TypeCheckOptions = {}): AzerothTypeChecker
{
    const sys = ts.sys;
    const readAzeroth = options.readFile ?? ((path: string): string | undefined => sys.readFile(path));

    // The native engine when available; diagnostics are identical, so the classic service
    // below is only built if the native backend is absent or fails mid-run.
    const nativeBackend = createNativeIncrementalBackend(readAzeroth);

    // The live source's projection (the file under check / HMR) overrides any on-disk copy of the same
    // path; on-disk dep projections are cached. Versions drive the LanguageService's incremental recheck.
    const overrides = new Map<string, { code: string; version: number }>();
    const diskCache = new Map<string, string | undefined>();
    const roots = new Set<string>();

    const projectDisk = (tsPath: string): string | undefined =>
    {
        if (diskCache.has(tsPath))
        {
            return diskCache.get(tsPath);
        }
        let code: string | undefined;
        const depSource = readAzeroth(tsPath.slice(0, -'.ts'.length));
        if (depSource !== undefined)
        {
            try
            {
                code = generateVirtualCode(depSource).code;
            }
            catch
            {
                // A malformed dependency resolves to nothing -> imported symbols become `any` (a false
                // negative), never a false error in the file under check.
                code = undefined;
            }
        }
        diskCache.set(tsPath, code);
        return code;
    };
    const projectedFor = (tsPath: string): string | undefined => overrides.get(tsPath)?.code ?? projectDisk(tsPath);

    const resolveAzeroth = (spec: string, containingFile: string): string | undefined =>
    {
        if (!spec.startsWith('.'))
        {
            return undefined;
        }
        const base = resolvePath(dirOf(containingFile), spec);
        const candidate = base.endsWith('.azeroth') ? base : `${ base }.azeroth`;
        return readAzeroth(candidate) !== undefined ? candidate : undefined;
    };

    const host: ts.LanguageServiceHost =
    {
        getCompilationSettings: () => COMPILER_OPTIONS,
        getScriptFileNames: () => [...roots],
        getScriptVersion: (f) =>
        {
            const override = overrides.get(f);
            return override ? `o${ override.version }` : '1';
        },
        getScriptSnapshot: (f) =>
        {
            const text = f.endsWith('.azeroth.ts') ? projectedFor(f) : sys.readFile(f);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => sys.getCurrentDirectory(),
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (f) => (f.endsWith('.azeroth.ts') ? projectedFor(f) !== undefined : sys.fileExists(f)),
        readFile: (f) => (f.endsWith('.azeroth.ts') ? projectedFor(f) : sys.readFile(f)),
        readDirectory: (path, extensions, exclude, include, depth) => sys.readDirectory(path, extensions, exclude, include, depth),
        directoryExists: (d) => sys.directoryExists(d),
        getDirectories: (d) => sys.getDirectories(d),
        useCaseSensitiveFileNames: () => true,
        realpath: (p) => (sys.realpath ? sys.realpath(p) : p),

        // Resolve relative `.azeroth` imports to their projection; delegate the rest to TypeScript.
        resolveModuleNameLiterals: (literals, containingFile, _redirect, opts) =>
            literals.map((literal) =>
            {
                const azerothPath = resolveAzeroth(literal.text, containingFile);
                if (azerothPath !== undefined)
                {
                    return {
                        resolvedModule: {
                            resolvedFileName: `${ azerothPath }.ts`,
                            extension: ts.Extension.Ts,
                            isExternalLibraryImport: false
                        }
                    };
                }
                const resolved = ts.resolveModuleName(literal.text, containingFile, opts, {
                    fileExists: (f) => sys.fileExists(f),
                    readFile: (f) => sys.readFile(f)
                });
                return { resolvedModule: resolved.resolvedModule };
            })
    };

    // Built on first classic use only - when the native backend serves every check, the
    // classic service (and its lib binding cost) never materializes.
    let service: ts.LanguageService | null = null;
    const ensureService = (): ts.LanguageService => (service ??= ts.createLanguageService(host, ts.createDocumentRegistry()));

    return {
        prime(fileNames: readonly string[]): void
        {
            for (const fileName of fileNames)
            {
                roots.add(`${ normalizeSlashes(fileName) }.ts`);
            }
            nativeBackend?.prime([...roots]);
        },

        check(fileName: string, source: string): AzerothDiagnostic[]
        {
            const module = parseModule(source);
            if (!module.items.some((i) => i.kind === 'component'))
            {
                return [];
            }
            const { code, mapping } = generateVirtualCode(source);
            const tsPath = `${ normalizeSlashes(fileName) }.ts`;
            roots.add(tsPath);
            // Only mark the file changed when its projection differs from what the Program already has
            // (the on-disk projection on a cold build, or a prior override on HMR). An unchanged file is
            // then checked against the STABLE shared Program with no incremental rebuild - so a primed
            // cold build is one Program build + N cheap per-file checks.
            const current = overrides.get(tsPath)?.code ?? projectDisk(tsPath);
            if (current !== code)
            {
                const previous = overrides.get(tsPath);
                overrides.set(tsPath, { code, version: (previous?.version ?? 0) + 1 });
                diskCache.delete(tsPath);
            }
            // Classic bookkeeping above runs unconditionally so a native failure mid-run can
            // fall back with the full override state; diagnostics come from whichever engine
            // answers first.
            if (nativeBackend !== null)
            {
                const result = nativeBackend.check(tsPath, code);
                if (result !== null)
                {
                    return [
                        ...mapSyntacticDiagnostics(result.syntactic, mapping),
                        ...mapDiagnostics(result.semantic, mapping)
                    ];
                }
            }
            const service = ensureService();
            const syntactic = mapSyntacticDiagnostics(service.getSyntacticDiagnostics(tsPath), mapping);
            return [...syntactic, ...mapDiagnostics(service.getSemanticDiagnostics(tsPath), mapping)];
        }
    };
}

/** Builds a diagnostic with the class's human-readable prefix. */
function make(code: CheckCode, detail: string, start: number, end: number): AzerothDiagnostic
{
    return { code, severity: 'error', message: `${ MESSAGE_PREFIX[code] }: ${ detail }`, start, end };
}
