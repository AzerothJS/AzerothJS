// CI guard against version drift. The monorepo ships in lockstep: every package
// and both editor integrations carry the SAME version, the editors pin the
// language server to that version, and the VS Code extension contributes the
// TypeScript plugin. If any of these drift, a release would ship an editor whose
// bundled server (or contributed plugin) no longer matches the code - exactly
// the "stale server in the .vsix" failure this test exists to prevent.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function json(rel: string): Record<string, unknown>
{
    return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
}

const VERSION = (json('package.json').version as string);

describe('workspace version is in lockstep', () =>
{
    it('every packages/*/package.json matches the root version', () =>
    {
        const drifted: string[] = [];
        for (const entry of readdirSync(path.join(ROOT, 'packages')))
        {
            const rel = path.join('packages', entry, 'package.json');
            if (!existsSync(path.join(ROOT, rel)))
            {
                continue;
            }
            const version = json(rel).version as string;
            if (version !== VERSION)
            {
                drifted.push(`${ rel }: ${ version }`);
            }
        }
        expect(drifted).toEqual([]);
    });

    it('the VS Code extension matches the root version and pins the server + plugin', () =>
    {
        const pkg = json('editors/vscode/package.json');
        expect(pkg.version).toBe(VERSION);
        const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
        expect(deps['@azerothjs/language-server']).toBe(VERSION);
        expect(deps['@azerothjs/typescript-plugin']).toBe(VERSION);
    });

    it('the VS Code extension contributes the TypeScript plugin (takeover)', () =>
    {
        const pkg = json('editors/vscode/package.json');
        const plugins = ((pkg.contributes as Record<string, unknown>).typescriptServerPlugins ?? []) as Array<{ name: string; enableForWorkspaceTypeScriptVersions?: boolean }>;
        const entry = plugins.find(p => p.name === '@azerothjs/typescript-plugin');
        expect(entry).toBeTruthy();
        expect(entry!.enableForWorkspaceTypeScriptVersions).toBe(true);
    });

    it('the JetBrains plugin declares the root version', () =>
    {
        const gradle = readFileSync(path.join(ROOT, 'editors/jetbrains/build.gradle.kts'), 'utf8');
        const match = gradle.match(/version\s*=\s*"([^"]+)"/);
        expect(match?.[1]).toBe(VERSION);
    });

    it('release tooling publishes the typescript-plugin in dependency order', () =>
    {
        const release = readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
        // It must be published AFTER language-service (which it bundles) and the
        // editors must NOT be in the npm publish set.
        expect(release).toContain("'typescript-plugin'");
        const order = release.slice(release.indexOf('PUBLISH_ORDER'));
        expect(order.indexOf("'language-service'")).toBeLessThan(order.indexOf("'typescript-plugin'"));
    });
});
