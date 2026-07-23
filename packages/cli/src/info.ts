/**
 * MODULE: cli/info - the bug-report block
 *
 * One paste-able block for every issue: CLI + node + platform, the detected shape, and
 * the azeroth/vite/typescript versions each half actually has installed (read from
 * node_modules, falling back to the declared range). Plain text, no color - it is made
 * to be copied.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { allDeps, readPackage, type Project } from './detect.ts';
import { resolveTool } from './plan.ts';

function installed(fromDir: string, packageName: string): string | null
{
    const packageJson = resolveTool(fromDir, `${ packageName }/package.json`);
    if (packageJson === null)
    {
        return null;
    }
    try
    {
        return (JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: string }).version ?? null;
    }
    catch
    {
        return null;
    }
}

function toolLines(dir: string): string[]
{
    const pkg = readPackage(dir);
    const deps = pkg === null ? {} : allDeps(pkg);
    const lines: string[] = [];
    const names = Object.keys(deps)
        .filter((name) => name === 'azerothjs' || name.startsWith('@azerothjs/'))
        .sort();
    for (const name of names)
    {
        const actual = installed(dir, name);
        lines.push(`    ${ name.padEnd(34) } ${ actual ?? `${ deps[name] ?? '' } (declared, not installed)` }`);
    }
    for (const name of ['vite', 'typescript'])
    {
        if (name in deps)
        {
            const actual = installed(dir, name);
            lines.push(`    ${ name.padEnd(34) } ${ actual ?? `${ deps[name] ?? '' } (declared, not installed)` }`);
        }
    }
    return lines;
}

/** Renders the info block for the detected project. */
export function renderInfo(project: Project, cliVersion: string): string
{
    const lines: string[] = [];
    lines.push(`azeroth cli   ${ cliVersion }`);
    lines.push(`node          v${ process.versions.node } (${ process.platform } ${ process.arch })`);
    lines.push(`project       ${ project.kind }${ project.kind === 'none' ? ` - ${ project.reason }` : '' }`);
    if (project.kind === 'fullstack')
    {
        lines.push(`  web         ${ relative(project.dir, project.app.dir) || '.' }`);
        lines.push(...toolLines(project.app.dir));
        lines.push(`  api         ${ relative(project.dir, project.server.dir) || '.' } (${ project.server.build })`);
        lines.push(...toolLines(project.server.dir));
    }
    else if (project.kind === 'frontend' || project.kind === 'backend' || project.kind === 'library')
    {
        lines.push(...toolLines(project.dir));
    }
    return lines.join('\n');
}
