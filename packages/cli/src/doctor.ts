/**
 * MODULE: cli/doctor - environment diagnosis
 *
 * Every check here is traceable to a real incident that cost real debugging hours:
 * strip-only Node meeting a decorator ORM, the TS2591 flood from a missing @types/node,
 * editor extensions running a stale compiler, a stale .azeroth-types mirror, version
 * skew between the halves of a fullstack app. Doctor diagnoses; it never mutates.
 * Checks are best-effort by design - an unreadable file is a skip, not a crash - and
 * only 'fail' results make the exit code non-zero.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { allDeps, readPackage, type BackendProject, type FrontendProject, type Project } from './detect.ts';
import { resolveTool } from './plan.ts';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorResult
{
    name: string;
    status: DoctorStatus;
    detail: string;
}

const DECORATOR_PACKAGES = ['typeorm', '@mikro-orm/core'];
const SUPPORTED_VITE_MAJORS = [7, 8];
const SUPPORTED_NODE_MAJOR = 24;

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

function installedVersion(fromDir: string, packageName: string): string | null
{
    const packageJson = resolveTool(fromDir, `${ packageName }/package.json`);
    if (packageJson === null)
    {
        return null;
    }
    try
    {
        const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: string };
        return parsed.version ?? null;
    }
    catch
    {
        return null;
    }
}

function checkNodeVersion(needsBackendNode: boolean): DoctorResult
{
    const major = Number(process.versions.node.split('.')[0] ?? '0');
    if (major >= SUPPORTED_NODE_MAJOR)
    {
        return { name: 'node version', status: 'ok', detail: `v${ process.versions.node }` };
    }
    return {
        name: 'node version',
        status: needsBackendNode ? 'fail' : 'warn',
        detail: `v${ process.versions.node } - the backend stack needs Node >= ${ SUPPORTED_NODE_MAJOR } (native TypeScript execution)`
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
    const mirror = join(app.dir, '.azeroth-types');
    if (!existsSync(mirror))
    {
        return { name: '.azeroth-types mirror', status: 'skip', detail: 'no mirror in use' };
    }
    const newestSource = newestMtime(join(app.dir, 'src'), (name) => name.endsWith('.azeroth'), 8);
    const newestMirror = newestMtime(mirror, () => true, 8);
    if (newestSource > newestMirror)
    {
        return {
            name: '.azeroth-types mirror',
            status: 'warn',
            detail: 'stale: a .azeroth source is newer than every mirrored declaration - run the dev server (or build) to regenerate, or editors resolve outdated types'
        };
    }
    return { name: '.azeroth-types mirror', status: 'ok', detail: 'mirror is at least as new as the sources' };
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
            const source = readFileSync(join(scriptsDir, name), 'utf8');
            return /shell:\s*true/.test(source) && /(execFileSync|spawnSync?|spawn)\s*\(/.test(source);
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

/** Runs the catalog against the detected project. Diagnosis only - nothing is mutated. */
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
    if (project.kind === 'library' || project.kind === 'none')
    {
        results.push({ name: 'project', status: 'skip', detail: project.kind === 'library' ? 'library package - nothing to diagnose beyond the environment' : 'no azeroth project here' });
    }
    return results;
}
