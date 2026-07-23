/**
 * MODULE: cli/detect - project-shape detection
 *
 * The CLI never asks what a project is; it looks. A directory with a package.json
 * classifies as FRONTEND (a vite config plus the azeroth compiler or umbrella package),
 * BACKEND (an @azerothjs server package and no vite config), or LIBRARY (azeroth
 * dependencies behind an exports/main field). A directory that classifies as none of
 * those - typically a repo root with no package.json - is probed for the FULLSTACK
 * shape: exactly one frontend child and exactly one backend child, conventional names
 * first. Ambiguity is never guessed: the result carries a reason naming what WAS found,
 * and the caller exits with the --app/--server disambiguation flags in the message.
 *
 * Backends subdivide by how they must run. A decorator ORM (or an explicit
 * emitDecoratorMetadata) means Node's strip-only TypeScript cannot execute the source,
 * so the shape is BUILT (tsc -w + node --watch dist); otherwise NATIVE
 * (node --watch src/main.ts) - preserving the framework's no-build-step doctrine.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface FrontendProject
{
    kind: 'frontend';
    dir: string;
}

export interface BackendProject
{
    kind: 'backend';
    dir: string;

    /** How the server must run: 'native' = node executes src directly; 'built' = tsc emits first. */
    build: 'native' | 'built';

    /** The source entry, relative to dir (e.g. 'src/main.ts'). */
    entry: string;

    /** The emitted entry for a built backend (e.g. 'dist/main.js'); null for native. */
    builtEntry: string | null;
}

export interface LibraryProject
{
    kind: 'library';
    dir: string;
}

export interface FullstackProject
{
    kind: 'fullstack';
    dir: string;
    app: FrontendProject;
    server: BackendProject;
}

export interface NoProject
{
    kind: 'none';
    dir: string;

    /** What detection looked for and what it found instead - printed verbatim. */
    reason: string;
}

export type Project = FrontendProject | BackendProject | LibraryProject | FullstackProject | NoProject;

/** Explicit halves for a fullstack root the probe cannot resolve alone. */
export interface DetectOverrides
{
    app: string | null;
    server: string | null;
}

const BACKEND_PACKAGES = ['@azerothjs/http', '@azerothjs/ws', '@azerothjs/api', '@azerothjs/cron'];
const FRONTEND_PACKAGES = ['@azerothjs/compiler', 'azerothjs'];
const DECORATOR_PACKAGES = ['typeorm', '@mikro-orm/core'];
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];
const FRONTEND_DIR_NAMES = ['application', 'website', 'client', 'app', 'frontend'];
const BACKEND_DIR_NAMES = ['server', 'api', 'backend'];
const ENTRY_CANDIDATES = ['src/main.ts', 'src/index.ts', 'main.ts'];

interface PackageJson
{
    name?: string;
    main?: string;
    exports?: unknown;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
}

/** Parses dir/package.json, or null when absent or unparseable. */
export function readPackage(dir: string): PackageJson | null
{
    try
    {
        return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
    }
    catch
    {
        return null;
    }
}

/** dependencies + devDependencies as one lookup. */
export function allDeps(pkg: PackageJson): Record<string, string>
{
    return { ...pkg.dependencies, ...pkg.devDependencies };
}

function hasViteConfig(dir: string): boolean
{
    return VITE_CONFIGS.some((name) => existsSync(join(dir, name)));
}

/** Raw tsconfig text (tsconfigs are JSONC; signals are read by regex, never parsed). */
function tsconfigText(dir: string): string
{
    try
    {
        return readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    }
    catch
    {
        return '';
    }
}

function classifyBackend(dir: string, deps: Record<string, string>): BackendProject | NoProject
{
    const entry = ENTRY_CANDIDATES.find((candidate) => existsSync(join(dir, candidate)));
    if (entry === undefined)
    {
        return {
            kind: 'none',
            dir,
            reason: `backend detected (an @azerothjs server package is a dependency) but no entry file was found - probed ${ ENTRY_CANDIDATES.join(', ') }`
        };
    }

    const raw = tsconfigText(dir);
    const usesDecorators = DECORATOR_PACKAGES.some((name) => name in deps)
        || /"emitDecoratorMetadata"\s*:\s*true/.test(raw);
    if (!usesDecorators)
    {
        return { kind: 'backend', dir, build: 'native', entry, builtEntry: null };
    }

    const outDirMatch = /"outDir"\s*:\s*"\.?\/?([^"]+?)\/?"/.exec(raw);
    const outDir = outDirMatch?.[1] ?? 'dist';
    const entryBase = entry.slice(entry.lastIndexOf('/') + 1).replace(/\.ts$/, '.js');
    return { kind: 'backend', dir, build: 'built', entry, builtEntry: `${ outDir }/${ entryBase }` };
}

/**
 * Classifies one directory WITHOUT the fullstack probe - the rules a single
 * package.json can answer. Order matters: a vite config wins over a server dependency
 * (an SSR-ish app with both is served by vite in dev), and library is the fallback for
 * azeroth deps that are neither runnable shape.
 */
export function classifyLeaf(dir: string): FrontendProject | BackendProject | LibraryProject | NoProject
{
    const abs = resolve(dir);
    const pkg = readPackage(abs);
    if (pkg === null)
    {
        return { kind: 'none', dir: abs, reason: 'no package.json' };
    }
    const deps = allDeps(pkg);
    const hasFrontendDep = FRONTEND_PACKAGES.some((name) => name in deps);
    const hasBackendDep = BACKEND_PACKAGES.some((name) => name in deps);
    const vite = hasViteConfig(abs);

    if (vite && (hasFrontendDep || 'vite' in deps))
    {
        return hasFrontendDep
            ? { kind: 'frontend', dir: abs }
            : { kind: 'none', dir: abs, reason: 'a vite config exists but neither @azerothjs/compiler nor azerothjs is a dependency' };
    }
    if (hasBackendDep && !vite)
    {
        return classifyBackend(abs, deps);
    }
    const hasAnyAzerothDep = Object.keys(deps).some((name) => name === 'azerothjs' || name.startsWith('@azerothjs/'));
    if (hasAnyAzerothDep && (pkg.exports !== undefined || pkg.main !== undefined))
    {
        return { kind: 'library', dir: abs };
    }
    return {
        kind: 'none',
        dir: abs,
        reason: hasAnyAzerothDep
            ? 'azeroth dependencies found, but no vite config (frontend), no server package without vite (backend), and no exports/main field (library)'
            : 'no azeroth dependency, no vite config with the azeroth plugin'
    };
}

function probeChildren(root: string, names: string[]): string[]
{
    const found: string[] = [];
    for (const name of names)
    {
        if (existsSync(join(root, name, 'package.json')))
        {
            found.push(join(root, name));
        }
    }
    return found;
}

function scanChildren(root: string): string[]
{
    try
    {
        return readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory()
                && !entry.name.startsWith('.')
                && entry.name !== 'node_modules'
                && entry.name !== 'dist')
            .map((entry) => join(root, entry.name));
    }
    catch
    {
        return [];
    }
}

function fullstackFrom(root: string, candidates: string[]): FullstackProject | null
{
    const fronts: FrontendProject[] = [];
    const backs: BackendProject[] = [];
    for (const dir of candidates)
    {
        const leaf = classifyLeaf(dir);
        if (leaf.kind === 'frontend')
        {
            fronts.push(leaf);
        }
        else if (leaf.kind === 'backend')
        {
            backs.push(leaf);
        }
    }
    const app = fronts.length === 1 ? fronts[0] : undefined;
    const server = backs.length === 1 ? backs[0] : undefined;
    if (app !== undefined && server !== undefined)
    {
        return { kind: 'fullstack', dir: root, app, server };
    }
    return null;
}

/**
 * The full detection algorithm. With overrides, both halves are classified from the
 * given paths and must match their expected shapes - the escape hatch when the probe
 * reports ambiguity. Without overrides: leaf classification first; a leaf miss falls
 * through to the fullstack probe (conventional child names, then a one-level scan).
 */
export function detectProject(dir: string, overrides: DetectOverrides = { app: null, server: null }): Project
{
    const root = resolve(dir);

    if (overrides.app !== null || overrides.server !== null)
    {
        if (overrides.app === null || overrides.server === null)
        {
            return { kind: 'none', dir: root, reason: '--app and --server must be given together' };
        }
        const app = classifyLeaf(resolve(root, overrides.app));
        if (app.kind !== 'frontend')
        {
            return { kind: 'none', dir: root, reason: `--app ${ overrides.app } is not an azeroth frontend (${ app.kind === 'none' ? app.reason : `classified as ${ app.kind }` })` };
        }
        const server = classifyLeaf(resolve(root, overrides.server));
        if (server.kind !== 'backend')
        {
            return { kind: 'none', dir: root, reason: `--server ${ overrides.server } is not an azeroth backend (${ server.kind === 'none' ? server.reason : `classified as ${ server.kind }` })` };
        }
        return { kind: 'fullstack', dir: root, app, server };
    }

    const leaf = classifyLeaf(root);
    if (leaf.kind !== 'none')
    {
        return leaf;
    }

    const conventional = fullstackFrom(root, probeChildren(root, [...FRONTEND_DIR_NAMES, ...BACKEND_DIR_NAMES]));
    if (conventional !== null)
    {
        return conventional;
    }
    const scanned = fullstackFrom(root, scanChildren(root));
    if (scanned !== null)
    {
        return scanned;
    }

    const candidates = scanChildren(root);
    const summary = candidates
        .map((child) => `${ child.slice(root.length + 1) }: ${ classifyLeaf(child).kind }`)
        .join(', ');
    return {
        kind: 'none',
        dir: root,
        reason: `not an azeroth project (${ leaf.reason }), and the fullstack probe did not find exactly one frontend + one backend child`
            + (summary === '' ? '' : ` - children: ${ summary }`)
            + '. Disambiguate with --app <dir> --server <dir>.'
    };
}
