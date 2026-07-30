// The upgrade verb's pure core: pin rewriting (targeted text edits - formatting
// survives byte-for-byte outside the touched versions) and workspace manifest
// collection. The npm/network side stays behind injected effects and is not
// exercised here.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { collectManifests, npmCli, rewritePins, runNpm, runUpgrade } from '../src/upgrade.ts';
import { planTest } from '../src/plan.ts';
import { detectProject } from '../src/detect.ts';

describe('rewritePins', () =>
{
    const manifest = `{
    "name": "my-app",
    "dependencies": {
        "azerothjs": "^1.0.0-beta.2",
        "left-pad": "^1.3.0"
    },
    "devDependencies": {
        "@azerothjs/compiler": "1.0.0-beta.2",
        "@azerothjs/typescript-plugin": "~1.0.0-beta.2"
    }
}
`;

    it('rewrites every azerothjs pin, preserving each range prefix and all formatting', () =>
    {
        const { text, changes } = rewritePins(manifest, 'package.json', '1.0.0-beta.3');
        expect(changes.map((c) => `${ c.name } ${ c.from } -> ${ c.to }`)).toEqual([
            'azerothjs ^1.0.0-beta.2 -> ^1.0.0-beta.3',
            '@azerothjs/compiler 1.0.0-beta.2 -> 1.0.0-beta.3',
            '@azerothjs/typescript-plugin ~1.0.0-beta.2 -> ~1.0.0-beta.3'
        ]);
        expect(text).toContain('"left-pad": "^1.3.0"');           // untouched
        expect(text).toContain('"azerothjs": "^1.0.0-beta.3"');
        expect(text.endsWith('\n')).toBe(true);                    // trailing byte survives
    });

    it('a project NAMED azerothjs-something is never rewritten (names are values, pins are keys)', () =>
    {
        const named = '{\n    "name": "azerothjs",\n    "version": "9.9.9"\n}\n';
        const { changes } = rewritePins(named, 'package.json', '1.0.0-beta.3');
        expect(changes).toEqual([]);
    });

    it('already at the target is a no-op, whatever the range prefix', () =>
    {
        const { text, changes } = rewritePins(manifest, 'package.json', '1.0.0-beta.2');
        expect(changes).toEqual([]);
        expect(text).toBe(manifest);
    });

    // A specifier that is not a plain version is a resolution its author chose: replacing
    // `file:`/`workspace:`/`git:` with a registry version breaks a local checkout, and
    // replacing a peer RANGE publishes an unsatisfiable constraint to every consumer.
    it('leaves every non-semver specifier standing and reports it as skipped', () =>
    {
        const exotic = `{
    "dependencies": {
        "azerothjs": "file:../azerothjs-local-checkout",
        "@azerothjs/http": "workspace:*",
        "@azerothjs/kit": "github:AzerothJS/AzerothJS#deadbeef",
        "@azerothjs/logger": "npm:@azerothjs/logger@1.0.0",
        "@azerothjs/schema": ">=1.0.0 <2",
        "@azerothjs/cron": "^1.0.0"
    }
}
`;
        const { text, changes, skipped } = rewritePins(exotic, 'package.json', '1.1.0');
        expect(changes.map((c) => c.name)).toEqual(['@azerothjs/cron']);
        expect(skipped.map((s) => `${ s.name } ${ s.spec }`)).toEqual([
            'azerothjs file:../azerothjs-local-checkout',
            '@azerothjs/http workspace:*',
            '@azerothjs/kit github:AzerothJS/AzerothJS#deadbeef',
            '@azerothjs/logger npm:@azerothjs/logger@1.0.0',
            '@azerothjs/schema >=1.0.0 <2'
        ]);
        expect(text).toContain('"azerothjs": "file:../azerothjs-local-checkout"');
        expect(text).toContain('"@azerothjs/http": "workspace:*"');
        expect(text).toContain('"@azerothjs/kit": "github:AzerothJS/AzerothJS#deadbeef"');
        expect(text).toContain('"@azerothjs/schema": ">=1.0.0 <2"');
        expect(text).toContain('"@azerothjs/cron": "^1.1.0"');
    });

    it('never touches peerDependencies or overrides - only the three dependency sections', () =>
    {
        const library = `{
    "dependencies": {
        "@azerothjs/http": "1.0.0"
    },
    "devDependencies": {
        "@azerothjs/cli": "1.0.0"
    },
    "optionalDependencies": {
        "@azerothjs/devtools": "1.0.0"
    },
    "peerDependencies": {
        "azerothjs": "1.0.0"
    },
    "overrides": {
        "azerothjs": "1.0.0"
    }
}
`;
        const { text, changes } = rewritePins(library, 'package.json', '2.0.0');
        expect(changes.map((c) => c.name)).toEqual(['@azerothjs/http', '@azerothjs/cli', '@azerothjs/devtools']);
        expect(text).toContain('"peerDependencies": {\n        "azerothjs": "1.0.0"');
        expect(text).toContain('"overrides": {\n        "azerothjs": "1.0.0"');
        expect(text).toContain('"@azerothjs/devtools": "2.0.0"');
    });

    it('an unparseable manifest is left exactly as it is', () =>
    {
        const broken = '{ "dependencies": { "azerothjs": "1.0.0",, } }';
        const { text, changes } = rewritePins(broken, 'package.json', '2.0.0');
        expect(changes).toEqual([]);
        expect(text).toBe(broken);
    });
});

// The verb could not run AT ALL on Windows: it named `npm.cmd` with shell:false, which
// spawn refuses since the CVE-2024-27980 fix (every Node this package supports), so every
// call failed EINVAL and surfaced as "could not resolve on the registry". npm runs as a
// node script now - this proves a real spawn, on this platform, actually reaches npm.
describe('npm runs through process.execPath, shell-free', () =>
{
    it('resolves npm\'s entry script and executes it', () =>
    {
        const cli = npmCli(import.meta.dirname);
        expect(cli).not.toBeNull();
        expect(cli).toMatch(/\.js$/);
        const { status, stdout } = runNpm(cli as string, ['--version'], import.meta.dirname, true);
        expect(status).toBe(0);
        expect(stdout).toMatch(/^\d+\.\d+\.\d+/);
    });
});

describe('collectManifests', () =>
{
    const root = mkdtempSync(join(tmpdir(), 'az-upgrade-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('finds the root plus explicit and one-level-glob workspace members', () =>
    {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['application', 'packages/*'] }));
        mkdirSync(join(root, 'application'));
        writeFileSync(join(root, 'application', 'package.json'), '{}');
        mkdirSync(join(root, 'packages', 'one'), { recursive: true });
        writeFileSync(join(root, 'packages', 'one', 'package.json'), '{}');
        mkdirSync(join(root, 'packages', 'no-manifest'));

        const found = collectManifests(root).map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
        expect(found).toEqual(['package.json', 'application/package.json', 'packages/one/package.json']);
    });
});

describe('runUpgrade - the target spec is validated before it reaches npm', () =>
{
    // The spec is caller-supplied (`azeroth upgrade <target>`). It once landed inside a
    // `shell: true` command string, so a shell metacharacter in it executed. npm now takes
    // an argument array, and a spec that could not be a package specifier is refused here -
    // before any child runs. A refusal must therefore never touch the manifests.
    const shellish = ['latest; echo pwned', 'latest && echo pwned', 'latest`echo pwned`', 'latest | echo pwned', '$(echo pwned)'];

    it('refuses a spec carrying shell metacharacters, writing nothing', () =>
    {
        const root = mkdtempSync(join(tmpdir(), 'az-spec-'));
        try
        {
            const manifest = '{\n    "dependencies": {\n        "azerothjs": "^1.0.0"\n    }\n}\n';
            writeFileSync(join(root, 'package.json'), manifest);
            for (const spec of shellish)
            {
                let doctorRan = false;
                const doctor = (): number =>
                {
                    doctorRan = true;
                    return 0;
                };
                const code = runUpgrade(root, spec, { dryRun: false, doctor });
                expect(code).toBe(1);        // could not resolve
                expect(doctorRan).toBe(false);
                expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest); // untouched
            }
        }
        finally
        {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('planTest', () =>
{
    it('plans one vitest run per half that has vitest (resolved by node_modules walk-up)', () =>
    {
        // This repo's own cli package: a library to detect, but planTest takes runnable
        // shapes - fake a backend project at the cli dir; vitest resolves from the repo root.
        const dir = join(import.meta.dirname, '..');
        const plan = planTest({ kind: 'backend', dir, build: 'native' } as Parameters<typeof planTest>[0]);
        expect(plan.command).toBe('test');
        expect(plan.steps).toHaveLength(1);
        expect(plan.steps[0]!.args).toEqual(['run']);
        expect(plan.steps[0]!.script).toContain('vitest');
    });

    it('a half without vitest becomes a note, never a failure', () =>
    {
        const bare = mkdtempSync(join(tmpdir(), 'az-notest-'));
        try
        {
            writeFileSync(join(bare, 'package.json'), '{}');
            const plan = planTest({ kind: 'backend', dir: bare, build: 'native' } as Parameters<typeof planTest>[0]);
            expect(plan.steps).toEqual([]);
            expect(plan.notes[0]).toContain('vitest not installed');
        }
        finally
        {
            rmSync(bare, { recursive: true, force: true });
        }
    });
});

// Keep the import "used" for shape parity with other cli specs.
void detectProject;
