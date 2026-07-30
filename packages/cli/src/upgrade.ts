/**
 * MODULE: cli/upgrade - `azeroth upgrade [target]`
 *
 * Moves every AzerothJS pin in the project to one target version, in three visible
 * steps: rewrite the manifests, `npm install`, then the doctor. The rewrite is a
 * TARGETED text edit driven by the PARSED manifest - each `"azerothjs" |
 * "@azerothjs/*" | "create-azeroth"` pin in dependencies / devDependencies /
 * optionalDependencies gets its version swapped with its range prefix (`^`/`~`)
 * preserved - so the user's package.json formatting survives byte-for-byte everywhere
 * else. A pin that is not a plain version (`file:`, `workspace:`, `git:`, `npm:`, a
 * multi-part range) is reported and left standing, and a peer range or an `overrides`
 * entry is never considered at all: those are constraints their author wrote on
 * purpose. `--print` shows the change table and exits without touching anything.
 *
 * `target` is a version (`1.0.0-beta.3`) or a dist-tag (`latest`, `beta`); tags
 * resolve through `npm view azerothjs@<tag> version` so the pins always end up
 * concrete. The spec is validated before it is used, and npm runs as a node script
 * with an argument array - never a shell, never a `.cmd` shim - see {@link npmCli}.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveTool } from './plan.ts';
import { bold, brand, dim, fail, print, verdictGlyph } from './terminal.ts';

/** One rewritten pin, for the change table. */
export interface PinChange
{
    file: string;
    name: string;
    from: string;
    to: string;
}

/** One pin left standing because its specifier is not a version this verb may move. */
export interface PinSkip
{
    file: string;
    section: string;
    name: string;
    spec: string;
}

/**
 * The manifest sections whose azeroth pins `upgrade` may move. `peerDependencies` is a
 * promise to CONSUMERS and `overrides`/`resolutions` are deliberate redirections of
 * somebody else's tree: replacing either with one exact version publishes a constraint
 * nobody chose.
 */
const PIN_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** An AzerothJS package name, matched in KEY position only (a project may be named one). */
const AZEROTH_NAME = /^(?:azerothjs|create-azeroth|@azerothjs\/[a-z-]+)$/;

/**
 * The only specifier shape this verb understands: one exact version, optionally behind a
 * `^`/`~`. `file:`, `workspace:`, `git:`/`github:`, `npm:` and multi-part ranges each mean
 * the author resolved that dependency deliberately, so a target version is not an upgrade
 * of them - it is a different answer to a question they already answered.
 */
const PLAIN_PIN = /^([~^]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function escapeRegExp(literal: string): string
{
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The text span INSIDE one `"<section>": { ... }` object, or null when the section is
 * absent. A dependency map holds only strings, so its extent ends at the first `}` - which
 * is what confines each rewrite to the section the parse said the pin lives in.
 */
function sectionSpan(text: string, section: string): { start: number; end: number } | null
{
    const opener = new RegExp(`"${ section }"\\s*:\\s*\\{`).exec(text);
    if (opener === null)
    {
        return null;
    }
    const start = opener.index + opener[0].length;
    const end = text.indexOf('}', start);
    return end === -1 ? null : { start, end };
}

/** Rewrites the eligible AzerothJS pins in one manifest's text; the rest is untouched. */
export function rewritePins(manifestText: string, file: string, target: string): { text: string; changes: PinChange[]; skipped: PinSkip[] }
{
    const changes: PinChange[] = [];
    const skipped: PinSkip[] = [];
    let manifest: Record<string, unknown>;
    try
    {
        manifest = JSON.parse(manifestText) as Record<string, unknown>;
    }
    catch
    {
        // Which key belongs to which section is knowable only from the parse; guessing it
        // from the text is what once rewrote peer ranges and `overrides` entries too.
        return { text: manifestText, changes, skipped };
    }

    let text = manifestText;
    for (const section of PIN_SECTIONS)
    {
        const entries = manifest[section];
        if (typeof entries !== 'object' || entries === null || Array.isArray(entries))
        {
            continue;
        }
        for (const [name, spec] of Object.entries(entries as Record<string, unknown>))
        {
            if (!AZEROTH_NAME.test(name) || typeof spec !== 'string')
            {
                continue;
            }
            const parts = PLAIN_PIN.exec(spec);
            if (parts === null)
            {
                skipped.push({ file, section, name, spec });
                continue;
            }
            const prefix = parts[1] as string;
            if (parts[2] === target)
            {
                continue;
            }
            // Recomputed per pin: each replacement shifts everything after it.
            const span = sectionSpan(text, section);
            if (span === null)
            {
                continue;
            }
            const pair = new RegExp(`("${ escapeRegExp(name) }"\\s*:\\s*")${ escapeRegExp(spec) }(")`);
            const before = text.slice(span.start, span.end);
            const after = before.replace(pair, (_match, head: string, tail: string) => `${ head }${ prefix }${ target }${ tail }`);
            if (after === before)
            {
                continue;
            }
            text = `${ text.slice(0, span.start) }${ after }${ text.slice(span.end) }`;
            changes.push({ file, name, from: spec, to: `${ prefix }${ target }` });
        }
    }
    return { text, changes, skipped };
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
 * @internal npm's own entry SCRIPT, so npm runs through `process.execPath` like every
 * other child this CLI spawns (see plan.ts). A shell is not an option - it once put a
 * caller-supplied spec (`azeroth upgrade <target>`) inside a command string, so
 * `upgrade "latest; <command>"` ran `<command>` - and since the CVE-2024-27980 fix, a
 * shell-free spawn REFUSES a `.cmd` target outright, so naming `npm.cmd` cannot work on
 * any supported Node either. Looked for where npm actually lives: the npm that invoked
 * us, the project's own node_modules, then the install beside this node binary.
 */
export function npmCli(cwd: string): string | null
{
    const fromEnv = process.env['npm_execpath'];
    if (fromEnv !== undefined && fromEnv.endsWith('.js') && existsSync(fromEnv))
    {
        return fromEnv;
    }
    const local = resolveTool(cwd, join('npm', 'bin', 'npm-cli.js'));
    if (local !== null)
    {
        return local;
    }
    const nodeDir = dirname(process.execPath);
    for (const candidate of [
        // Windows: <nodeDir>\node_modules\npm; POSIX: <prefix>/lib/node_modules/npm.
        join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(dirname(nodeDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ])
    {
        if (existsSync(candidate))
        {
            return candidate;
        }
    }
    return null;
}

/**
 * @internal Runs npm with an ARGUMENT ARRAY and no shell; `cli` comes from {@link npmCli}.
 * Nothing this function receives is ever parsed by a shell.
 */
export function runNpm(cli: string, args: readonly string[], cwd: string, capture: boolean): { status: number; stdout: string }
{
    const result = spawnSync(process.execPath, [cli, ...args], {
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
function resolveTarget(cli: string, spec: string, cwd: string): string | null
{
    if (!SPEC_PATTERN.test(spec))
    {
        return null;
    }
    const { status, stdout } = runNpm(cli, ['view', `azerothjs@${ spec }`, 'version'], cwd, true);
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
    const cli = npmCli(cwd);
    if (cli === null)
    {
        fail('npm was not found - looked for npm_execpath, node_modules/npm and the npm installed beside this node');
        return 1;
    }
    const target = resolveTarget(cli, spec, cwd);
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
    const skipped: PinSkip[] = [];
    const writes: Array<{ file: string; text: string }> = [];
    for (const file of manifests)
    {
        const rewritten = rewritePins(readFileSync(file, 'utf8'), file, target);
        skipped.push(...rewritten.skipped);
        if (rewritten.changes.length > 0)
        {
            writes.push({ file, text: rewritten.text });
            all.push(...rewritten.changes);
        }
    }

    const reportSkipped = (): void =>
    {
        for (const skip of skipped)
        {
            print(`  ${ dim(skip.file) }  ${ skip.name }  ${ dim(`${ skip.spec } in ${ skip.section } is not a plain version - left as it is`) }`);
        }
    };

    if (all.length === 0)
    {
        print(`${ verdictGlyph() } already at ${ brand(target) } - nothing to do`);
        reportSkipped();
        return 0;
    }
    print(`${ bold('azeroth upgrade') } ${ dim('->') } ${ brand(target) }`);
    for (const change of all)
    {
        print(`  ${ dim(change.file) }  ${ change.name }  ${ dim(change.from) } ${ dim('->') } ${ brand(change.to) }`);
    }
    reportSkipped();
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
    const install = runNpm(cli, ['install'], cwd, false);
    if (install.status !== 0)
    {
        fail('npm install failed - the pins are rewritten; fix the install and re-run `azeroth doctor`');
        return 1;
    }
    return options.doctor();
}
