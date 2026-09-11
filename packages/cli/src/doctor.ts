/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Environment diagnosis.
 *
 * Every check here is traceable to a real incident that cost real debugging hours:
 * strip-only Node meeting a decorator ORM, the TS2591 flood from a missing @types/node,
 * editor extensions running a stale compiler, a stale .azeroth/types mirror, version
 * skew between the halves of a fullstack app. Doctor diagnoses; it never mutates.
 * Checks are best-effort by design - an unreadable file is a skip, not a crash - and
 * only 'fail' results make the exit code non-zero.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { allDeps, readPackage, type BackendProject, type FrontendProject, type Project } from './detect.ts';
import { resolveTool } from './plan.ts';

/** A check's verdict: only `fail` makes the doctor's exit code non-zero. */
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

/** One diagnosis line: the check's name, its verdict, and what to do about it. */
export interface DoctorResult
{
    name: string;
    status: DoctorStatus;
    detail: string;
}

const DECORATOR_PACKAGES = ['typeorm', '@mikro-orm/core'];
const SUPPORTED_VITE_MAJORS = [7, 8];
// The one-process dev session is written and measured against vite 8, and refuses any other
// major at startup - so here the mismatch is a warning, not a surprise at the first request.
const DEV_SESSION_VITE_MAJOR = 8;
const KIT_DEV_MODULE = '@azerothjs/kit/dev';
// The zero-build backend runs TypeScript source directly (`node src/main.ts`), which needs
// unflagged native type-stripping: Node 22.18+ (backported), 23.6+, or 24+. The published
// packages themselves run on Node 22+ as compiled JS; this floor is the DEV-run requirement.
const NATIVE_TS_NODE = { major: 22, minor: 18 };

/** True when `version` (e.g. "22.18.0") can run `node file.ts` without a flag. */
function runsTypeScriptNatively(version: string): boolean
{
    const [major, minor] = version.split('.').map((part) => Number(part) || 0);
    return (major ?? 0) > NATIVE_TS_NODE.major
        || ((major ?? 0) === NATIVE_TS_NODE.major && (minor ?? 0) >= NATIVE_TS_NODE.minor);
}

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

/** The `version` field of one package.json, by path. */
function versionAt(manifestPath: string): string | null
{
    try
    {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
        return parsed.version ?? null;
    }
    catch
    {
        return null;
    }
}

function installedVersion(fromDir: string, packageName: string): string | null
{
    const packageJson = resolveTool(fromDir, `${ packageName }/package.json`);
    return packageJson === null ? null : versionAt(packageJson);
}

function checkNodeVersion(needsBackendNode: boolean): DoctorResult
{
    if (runsTypeScriptNatively(process.versions.node))
    {
        return { name: 'node version', status: 'ok', detail: `v${ process.versions.node }` };
    }
    return {
        name: 'node version',
        status: needsBackendNode ? 'fail' : 'warn',
        detail: `v${ process.versions.node } - the zero-build backend runs TypeScript directly, which needs Node ${ NATIVE_TS_NODE.major }.${ NATIVE_TS_NODE.minor }+ (or 23.6+/24). The packages themselves run on Node 22+.`
    };
}

function checkStripOnlyTrap(server: BackendProject): DoctorResult
{
    const pkg = readPackage(server.dir);
    const deps = pkg === null ? {} : allDeps(pkg);
    const ormPresent = DECORATOR_PACKAGES.filter((name) => name in deps);
    if (ormPresent.length === 0)
    {
        return { name: 'strip-only trap', status: 'ok', detail: 'no decorator ORM; node runs the source directly' };
    }
    const raw = tsconfigText(server.dir);
    if (/"emitDecoratorMetadata"\s*:\s*true/.test(raw))
    {
        return { name: 'strip-only trap', status: 'ok', detail: `${ ormPresent.join(', ') } + emitDecoratorMetadata: the build step is configured` };
    }
    return {
        name: 'strip-only trap',
        status: 'fail',
        detail: `${ ormPresent.join(', ') } is a dependency but tsconfig lacks "emitDecoratorMetadata": true - decorator metadata cannot exist under Node's strip-only TypeScript; add it and build with tsc`
    };
}

function checkTypesNode(server: BackendProject): DoctorResult
{
    const pkg = readPackage(server.dir);
    const deps = pkg === null ? {} : allDeps(pkg);
    const raw = tsconfigText(server.dir);
    const declaresTypes = /"types"\s*:\s*\[[^\]]*"node"/.test(raw);
    if ('@types/node' in deps || declaresTypes)
    {
        return { name: '@types/node', status: 'ok', detail: 'the node: import types resolve' };
    }
    return {
        name: '@types/node',
        status: 'warn',
        detail: 'neither @types/node (devDependency) nor types: ["node"] (tsconfig) found - tsc --noEmit will flood with TS2591 on node: imports'
    };
}

function azerothVersionsOf(dir: string): Map<string, string>
{
    const pkg = readPackage(dir);
    const versions = new Map<string, string>();
    if (pkg === null)
    {
        return versions;
    }
    for (const [name, version] of Object.entries(allDeps(pkg)))
    {
        if (name === 'azerothjs' || name.startsWith('@azerothjs/'))
        {
            versions.set(name, version);
        }
    }
    return versions;
}

function checkVersionSkew(app: FrontendProject, server: BackendProject): DoctorResult
{
    const ranges = new Set<string>();
    for (const versions of [azerothVersionsOf(app.dir), azerothVersionsOf(server.dir)])
    {
        for (const version of versions.values())
        {
            ranges.add(version);
        }
    }
    if (ranges.size <= 1)
    {
        return { name: 'version skew', status: 'ok', detail: 'the @azerothjs/* family is on one version across both halves' };
    }
    return {
        name: 'version skew',
        status: 'warn',
        detail: `@azerothjs/* ranges differ across the app (${ [...ranges].join(' vs ') }) - the framework versions in lockstep; align them`
    };
}

function newestMtime(dir: string, matches: (name: string) => boolean, depth: number): number
{
    if (depth === 0)
    {
        return 0;
    }
    let newest = 0;
    let entries;
    try
    {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch
    {
        return 0;
    }
    for (const entry of entries)
    {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist')
        {
            continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory())
        {
            newest = Math.max(newest, newestMtime(path, matches, depth - 1));
        }
        else if (matches(entry.name))
        {
            try
            {
                newest = Math.max(newest, statSync(path).mtimeMs);
            }
            catch
            {
                // A vanished file mid-scan is not a diagnosis.
            }
        }
    }
    return newest;
}

function checkAzerothTypesMirror(app: FrontendProject): DoctorResult
{
    // `.azeroth/types`, not `.azeroth-types`: the compiler's DECLARATIONS_DIR
    // (packages/compiler/src/vite.ts). A check against any other path can only ever
    // report "no mirror in use", so this must track that constant.
    const mirror = join(app.dir, '.azeroth', 'types');
    if (!existsSync(mirror))
    {
        return { name: '.azeroth/types mirror', status: 'skip', detail: 'no mirror in use' };
    }
    const newestSource = newestMtime(join(app.dir, 'src'), (name) => name.endsWith('.azeroth'), 8);
    const newestMirror = newestMtime(mirror, () => true, 8);
    if (newestSource > newestMirror)
    {
        return {
            name: '.azeroth/types mirror',
            status: 'warn',
            detail: 'stale: a .azeroth source is newer than every mirrored declaration - run the dev server (or build) to regenerate, or editors resolve outdated types'
        };
    }
    return { name: '.azeroth/types mirror', status: 'ok', detail: 'mirror is at least as new as the sources' };
}

function checkEditorSkew(anyProjectDir: string): DoctorResult
{
    const compilerVersion = installedVersion(anyProjectDir, '@azerothjs/compiler');
    if (compilerVersion === null)
    {
        return { name: 'editor extension', status: 'skip', detail: '@azerothjs/compiler is not installed here' };
    }
    let extensions: string[];
    try
    {
        extensions = readdirSync(join(homedir(), '.vscode', 'extensions'))
            .filter((name) => name.toLowerCase().includes('azeroth'));
    }
    catch
    {
        return { name: 'editor extension', status: 'skip', detail: 'no VS Code extensions directory' };
    }
    if (extensions.length === 0)
    {
        return { name: 'editor extension', status: 'skip', detail: 'no azeroth VS Code extension installed' };
    }
    const mismatched = extensions.filter((name) =>
    {
        const version = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(name)?.[1];
        return version !== undefined && version !== compilerVersion;
    });
    if (mismatched.length === 0)
    {
        return { name: 'editor extension', status: 'ok', detail: `extension matches @azerothjs/compiler ${ compilerVersion }` };
    }
    return {
        name: 'editor extension',
        status: 'warn',
        detail: `${ mismatched.join(', ') } does not match the installed compiler ${ compilerVersion } - update the extension, then reload the editor window (a stale extension keeps its old compiler in memory)`
    };
}

function checkViteRange(app: FrontendProject): DoctorResult
{
    const version = installedVersion(app.dir, 'vite');
    if (version === null)
    {
        return { name: 'vite version', status: 'skip', detail: 'vite is not installed' };
    }
    const major = Number(version.split('.')[0] ?? '0');
    if (SUPPORTED_VITE_MAJORS.includes(major))
    {
        return { name: 'vite version', status: 'ok', detail: `v${ version }` };
    }
    return {
        name: 'vite version',
        status: 'warn',
        detail: `v${ version } is outside the supported range (majors ${ SUPPORTED_VITE_MAJORS.join(', ') }) - probably fine, not verified`
    };
}

/**
 * The root declares `"azeroth": { "dev": "server" }`, so `azeroth dev` runs the server half
 * alone and that half has to create the dev session. A session factored out of the entry into
 * a module it imports is legitimate, which is why an entry without the import warns.
 */
function checkDevCapability(project: Project): DoctorResult
{
    if (project.kind !== 'fullstack')
    {
        return { name: 'dev capability', status: 'skip', detail: 'root only - the capability is declared by the fullstack root manifest' };
    }
    if (project.azeroth !== 'server')
    {
        return { name: 'dev capability', status: 'skip', detail: 'the root manifest does not declare "azeroth": { "dev": "server" }' };
    }
    let source: string;
    try
    {
        source = readFileSync(join(project.server.dir, project.server.entry), 'utf8');
    }
    catch
    {
        source = '';
    }
    if (source.includes(KIT_DEV_MODULE))
    {
        return { name: 'dev capability', status: 'ok', detail: `${ project.server.entry } imports ${ KIT_DEV_MODULE }` };
    }
    return {
        name: 'dev capability',
        status: 'warn',
        detail: `the root declares "azeroth": { "dev": "server" } but ${ project.server.entry } never imports ${ KIT_DEV_MODULE } - the conductor drops the web step, so nothing would serve the pages (fine if a module the entry imports creates the session)`
    };
}

/** The vite range a half declares, either side of its manifest; null when it declares none. */
function declaredVite(dir: string): string | null
{
    const pkg = readPackage(dir);
    return pkg === null ? null : allDeps(pkg).vite ?? null;
}

/**
 * The copy of vite the dev session will actually load: node resolves it from the REAL
 * directory of the `@azerothjs/kit` the server half sees, which is a different answer from a
 * lexical node_modules walk whenever an ancestor holds its own vite.
 */
function checkDevVite(project: Project): DoctorResult
{
    if (project.kind !== 'fullstack')
    {
        return { name: 'dev vite', status: 'skip', detail: 'root only - the dev session loads vite through the server half' };
    }
    let kitManifest: string;
    try
    {
        kitManifest = createRequire(join(project.server.dir, 'package.json')).resolve('@azerothjs/kit/package.json');
    }
    catch
    {
        return { name: 'dev vite', status: 'skip', detail: '@azerothjs/kit does not resolve from the server half - nothing would load vite' };
    }
    let viteManifest: string;
    try
    {
        viteManifest = createRequire(realpathSync.native(kitManifest)).resolve('vite/package.json');
    }
    catch
    {
        return { name: 'dev vite', status: 'skip', detail: `vite does not resolve from ${ dirname(kitManifest) } - the dev session has none to load` };
    }
    const version = versionAt(viteManifest);
    const appRange = declaredVite(project.app.dir);
    const serverRange = declaredVite(project.server.dir);
    const report = `${ version === null ? 'unreadable version' : `v${ version }` } at ${ dirname(viteManifest) }`
        + ` (declared: app ${ appRange ?? 'none' }, server ${ serverRange ?? 'none' })`;

    const problems: string[] = [];
    if (Number(version?.split('.')[0] ?? '0') !== DEV_SESSION_VITE_MAJOR)
    {
        problems.push(`the dev session is written against vite ${ DEV_SESSION_VITE_MAJOR } and refuses any other major at startup`);
    }
    if (appRange !== null && serverRange !== null && appRange !== serverRange)
    {
        problems.push('the halves declare different vite ranges - one install hoists one copy, and the session loads whichever it is');
    }
    if (serverRange === null && project.azeroth === 'server')
    {
        problems.push('the server half declares no vite, yet it runs the dev session - add vite to its devDependencies at the range the app declares');
    }
    if (problems.length === 0)
    {
        return { name: 'dev vite', status: 'ok', detail: report };
    }
    return { name: 'dev vite', status: 'warn', detail: `${ report } - ${ problems.join('; ') }` };
}

/**
 * `shell: true` inside ONE spawn call's options - the two facts have to meet at the same
 * call site. Testing them separately flagged any file that so much as named the hazard in a
 * prose comment while spawning safely, and missed a real one in a file whose spawn call this
 * CLI's alternation did not list. A `;` ends the search: an options object never contains one.
 */
const SHELL_TRUE_SPAWN = /(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\([^;]*?shell\s*:\s*true/;

/** Comments removed, so a file that merely NAMES a hazard is not diagnosed as having one. */
function stripComments(source: string): string
{
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function checkSpawnHazards(dir: string): DoctorResult
{
    const scriptsDir = join(dir, 'scripts');
    let files: string[];
    try
    {
        files = readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs') || name.endsWith('.js'));
    }
    catch
    {
        return { name: 'spawn hazards', status: 'skip', detail: 'no scripts/ directory' };
    }
    const hazardous = files.filter((name) =>
    {
        try
        {
            return SHELL_TRUE_SPAWN.test(stripComments(readFileSync(join(scriptsDir, name), 'utf8')));
        }
        catch
        {
            return false;
        }
    });
    if (hazardous.length === 0)
    {
        return { name: 'spawn hazards', status: 'ok', detail: 'no shell:true spawns in project scripts' };
    }
    return {
        name: 'spawn hazards',
        status: 'warn',
        detail: `${ hazardous.join(', ') }: shell:true with an args array concatenates WITHOUT quoting on Windows (DEP0190) - args containing spaces silently split; use shell:false with a resolved executable`
    };
}

/**
 * Runs the failure catalog against the detected project - each check targeting the
 * halves it applies to (backend checks per server, frontend checks per app, the
 * version-skew check only when both halves exist). Diagnosis only: nothing is mutated,
 * and a check that cannot run reports `skip` rather than guessing.
 */
export function runDoctor(project: Project): DoctorResult[]
{
    const results: DoctorResult[] = [];
    const servers: BackendProject[] = [];
    const apps: FrontendProject[] = [];
    if (project.kind === 'backend')
    {
        servers.push(project);
    }
    if (project.kind === 'frontend')
    {
        apps.push(project);
    }
    if (project.kind === 'fullstack')
    {
        servers.push(project.server);
        apps.push(project.app);
    }

    results.push(checkNodeVersion(servers.length > 0));
    for (const server of servers)
    {
        results.push(checkStripOnlyTrap(server));
        results.push(checkTypesNode(server));
        results.push(checkSpawnHazards(server.dir));
    }
    for (const app of apps)
    {
        results.push(checkAzerothTypesMirror(app));
        results.push(checkViteRange(app));
        results.push(checkEditorSkew(app.dir));
    }
    if (project.kind === 'fullstack')
    {
        results.push(checkVersionSkew(project.app, project.server));
    }
    if (project.kind !== 'library' && project.kind !== 'none')
    {
        results.push(checkDevCapability(project));
        results.push(checkDevVite(project));
    }
    if (project.kind === 'library' || project.kind === 'none')
    {
        results.push({ name: 'project', status: 'skip', detail: project.kind === 'library' ? 'library package - nothing to diagnose beyond the environment' : 'no azeroth project here' });
    }
    return results;
}
