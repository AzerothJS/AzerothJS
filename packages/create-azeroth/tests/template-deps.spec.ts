// @vitest-environment node
//
// A scaffolded project must be installable from its own manifest: every package its sources
// import has to be declared. A template that imports one it does not declare works in this
// repo - the monorepo hoists it - and fails for the user, which is the worst place to find out.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

function sourcesIn(dir: string, out: string[] = []): string[]
{
    for (const entry of readdirSync(dir))
    {
        if (entry === 'node_modules')
        {
            continue;
        }
        const full = join(dir, entry);
        if (statSync(full).isDirectory())
        {
            sourcesIn(full, out);
        }
        else if (/\.(ts|mts|cts|azeroth)$/.test(entry))
        {
            out.push(full);
        }
    }
    return out;
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageOf(specifier: string): string
{
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** Every directory in the template that carries its own manifest. */
function workspacesIn(templateDir: string): string[]
{
    const nested = readdirSync(templateDir)
        .map((entry) => join(templateDir, entry))
        .filter((path) => statSync(path).isDirectory())
        .filter((path) => existsSync(join(path, 'package.json')));
    return [templateDir, ...nested];
}

/** Sources owned by `workspace` - excluding any nested workspace, which answers for its own. */
function ownSources(workspace: string, allWorkspaces: string[]): string[]
{
    const nested = allWorkspaces.filter((path) => path !== workspace && path.startsWith(workspace + sep));
    return sourcesIn(workspace).filter((file) => !nested.some((path) => file.startsWith(path + sep)));
}

function declaredIn(dir: string): Set<string>
{
    const declared = new Set<string>();
    let manifest: Record<string, Record<string, string> | undefined>;
    try
    {
        manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof manifest;
    }
    catch
    {
        return declared;
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'])
    {
        for (const name of Object.keys(manifest[field] ?? {}))
        {
            declared.add(name);
        }
    }
    return declared;
}

function importsOf(files: string[]): Set<string>
{
    const imported = new Set<string>();
    for (const file of files)
    {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/(?:from|import)\s+['"]([^'".][^'"]*)['"]/g))
        {
            const specifier = match[1] ?? '';
            if (specifier.startsWith('node:') || specifier.startsWith('/'))
            {
                continue;
            }
            imported.add(packageOf(specifier));
        }
    }
    return imported;
}

const templates = readdirSync(TEMPLATES).filter((entry) => statSync(join(TEMPLATES, entry)).isDirectory());

describe('every template declares what it imports', () =>
{
    it('finds the templates to check', () =>
    {
        expect(templates.length).toBeGreaterThan(0);
    });

    for (const template of templates)
    {
        it(`${ template } has no undeclared dependency, per workspace`, () =>
        {
            const dir = join(TEMPLATES, template);
            const workspaces = workspacesIn(dir);
            const root = declaredIn(dir);
            for (const workspace of workspaces)
            {
                const declared = new Set([...root, ...declaredIn(workspace)]);
                const missing = [...importsOf(ownSources(workspace, workspaces))]
                    .filter((name) => !declared.has(name)).sort();
                expect({ workspace: workspace.slice(dir.length) || '.', missing }).toEqual(
                    { workspace: workspace.slice(dir.length) || '.', missing: [] });
            }
        });
    }

    it('reads real imports, so a missing declaration would be caught', () =>
    {
        const dir = join(TEMPLATES, 'fullstack');
        const imported = importsOf(ownSources(dir, workspacesIn(dir)).concat(
            workspacesIn(dir).flatMap((w) => ownSources(w, workspacesIn(dir)))));
        expect(imported.has('azerothjs')).toBe(true);
        expect(imported.has('@azerothjs/schema')).toBe(true);
    });
});
