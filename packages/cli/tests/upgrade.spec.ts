// The upgrade verb's pure core: pin rewriting (targeted text edits - formatting
// survives byte-for-byte outside the touched versions) and workspace manifest
// collection. The npm/network side stays behind injected effects and is not
// exercised here.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { collectManifests, rewritePins } from '../src/upgrade.ts';
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
