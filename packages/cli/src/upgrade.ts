/**
 * MODULE: cli/upgrade - `azeroth upgrade [target]`
 *
 * Moves every AzerothJS pin in the project to one target version, in three visible
 * steps: rewrite the manifests, `npm install`, then the doctor. The rewrite is a
 * TARGETED text edit - each `"azerothjs" | "@azerothjs/*" | "create-azeroth"` pair
 * gets its version swapped with its range prefix (`^`/`~`) preserved - so the user's
 * package.json formatting survives byte-for-byte everywhere else. `--print` shows the
 * change table and exits without touching anything.
 *
 * `target` is a version (`1.0.0-beta.3`) or a dist-tag (`latest`, `beta`); tags
 * resolve through `npm view azerothjs@<tag> version` so the pins always end up
 * concrete. The spec is validated before it is used and npm is spawned with an
 * argument array, never a shell string - see {@link npm}.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bold, brand, dim, fail, print, verdictGlyph } from './terminal.ts';

/** One rewritten pin, for the change table. */
export interface PinChange
{
    file: string;
    name: string;
    from: string;
    to: string;
}

/**
 * Matches a dependency-style pair for any AzerothJS package. The NAME is the key,
 * so a project whose own `"name"` field mentions azerothjs (value position) never
 * matches; group 2 keeps the range prefix, group 3 is the version being replaced.
 */
const PIN_PATTERN = /("(?:azerothjs|create-azeroth|@azerothjs\/[a-z-]+)"\s*:\s*")([~^]?)([^"\n]+)(")/g;

/** Rewrites every AzerothJS pin in one manifest's text; the rest is untouched. */
export function rewritePins(manifestText: string, file: string, target: string): { text: string; changes: PinChange[] }
{
    const changes: PinChange[] = [];
    const text = manifestText.replace(PIN_PATTERN, (whole, head: string, prefix: string, version: string, tail: string) =>
    {
        if (version === target)
        {
            return whole;
        }
        const name = head.slice(1, head.indexOf('"', 1));
        changes.push({ file, name, from: `${ prefix }${ version }`, to: `${ prefix }${ target }` });
        return `${ head }${ prefix }${ target }${ tail }`;
    });
    return { text, changes };
}

/**
 * The project's manifests: the root package.json plus every workspace member's
 * (simple one-level globs - `packages/*` - are expanded; exotic patterns are left
 * to the user's own tooling).
 */
export function collectManifests(rootDir: string): string[]
{
    const rootManifest = join(rootDir, 'package.json');
    if (!existsSync(rootManifest))
    {
        return [];
    }
    const out = [rootManifest];
    let workspaces: string[];
    try
    {
        const parsed = JSON.parse(readFileSync(rootManifest, 'utf8')) as { workspaces?: string[] };
        workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    }
    catch
    {
        return out;
    }
    for (const pattern of workspaces)
    {
        if (pattern.endsWith('/*'))
        {
            const parent = join(rootDir, pattern.slice(0, -2));
            if (!existsSync(parent))
            {
                continue;
            }
            for (const entry of readdirSync(parent, { withFileTypes: true }))
            {
                const manifest = join(parent, entry.name, 'package.json');
                if (entry.isDirectory() && existsSync(manifest))
                {
                    out.push(manifest);
                }
            }
        }
        else
        {
            const manifest = join(rootDir, pattern, 'package.json');
            if (existsSync(manifest))
            {
                out.push(manifest);
            }
        }
    }
    return out;
}

/**
 * @internal Runs npm with an ARGUMENT ARRAY and no shell, like every other child this CLI
 * spawns. Windows needs `npm.cmd`, which is why this once went through `shell: true` - but
 * that put a caller-supplied spec (`azeroth upgrade <target>`) inside a shell string, so
 * `upgrade "latest; <command>"` ran `<command>`. The extension is chosen explicitly here
 * instead; nothing this function receives is ever parsed by a shell.
 */
function npm(args: readonly string[], cwd: string, capture: boolean): { status: number; stdout: string }
{
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd,
        shell: false,
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        encoding: 'utf8'
    });
    // @types/node types stdout as string under `encoding`, but a spawn-level failure
    // (npm missing entirely) leaves it null at runtime - widen to the truth.
    return { status: result.status ?? 1, stdout: ((result.stdout as string | null) ?? '').trim() };
}

/**
 * A publishable version or dist-tag, the only shapes `upgrade` accepts. Anything else is
 * refused before it reaches npm: the value is caller-supplied, and a name that cannot be a
 * package specifier has no business being resolved.
 */
const SPEC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/** Resolves a dist-tag (or verifies a version) to the concrete version string. */
function resolveTarget(spec: string, cwd: string): string | null
{
    if (!SPEC_PATTERN.test(spec))
    {
        return null;
    }
    const { status, stdout } = npm(['view', `azerothjs@${ spec }`, 'version'], cwd, true);
    if (status !== 0 || stdout === '')
    {
        return null;
    }
    // A tag resolves to one line; a range can list several - take the last (highest).
    const lines = stdout.split('\n');
    const last = lines[lines.length - 1] as string;
    const match = /([0-9][^\s']*)'?$/.exec(last.trim());
    return match?.[1] ?? null;
}

/** The whole verb. `dryRun` prints the change table and stops before writing. */
export function runUpgrade(cwd: string, spec: string, options: { dryRun: boolean; doctor: () => number }): number
{
    const target = resolveTarget(spec, cwd);
    if (target === null)
    {
        fail(`could not resolve azerothjs@${ spec } on the registry`);
        return 1;
    }

    const manifests = collectManifests(cwd);
    if (manifests.length === 0)
    {
        fail('no package.json here - run inside the project root');
        return 2;
    }

    const all: PinChange[] = [];
    const writes: Array<{ file: string; text: string }> = [];
    for (const file of manifests)
    {
        const { text, changes } = rewritePins(readFileSync(file, 'utf8'), file, target);
        if (changes.length > 0)
        {
            writes.push({ file, text });
            all.push(...changes);
        }
    }

    if (all.length === 0)
    {
        print(`${ verdictGlyph() } already at ${ brand(target) } - nothing to do`);
        return 0;
    }
    print(`${ bold('azeroth upgrade') } ${ dim('->') } ${ brand(target) }`);
    for (const change of all)
    {
        print(`  ${ dim(change.file) }  ${ change.name }  ${ dim(change.from) } ${ dim('->') } ${ brand(change.to) }`);
    }
    if (options.dryRun)
    {
        print(dim('  --print: nothing written'));
        return 0;
    }

    for (const write of writes)
    {
        writeFileSync(write.file, write.text);
    }
    print(dim('  installing...'));
    const install = npm(['install'], cwd, false);
    if (install.status !== 0)
    {
        fail('npm install failed - the pins are rewritten; fix the install and re-run `azeroth doctor`');
        return 1;
    }
    return options.doctor();
}
