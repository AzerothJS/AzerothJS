// @vitest-environment node
//
// The repo's own release script, driven through --dry-run: the preconditions a publish
// cannot take back. `--no-bump` publishes a bump an EARLIER run made, and `npm publish`
// packs the working tree rather than the tag, so the version in the manifest, the commit
// the tag names, the branch and the tree state are all verified before the registry is
// touched - and the npm OTP must never appear in a printed command line.
//
// It lives in this package's suite because `scripts/` has no suite of its own: the vitest
// include is `packages/*/tests/**`, and the release script is what publishes this CLI.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const RELEASE = join(ROOT, 'scripts', 'release.mjs');

/** Runs the release script and returns its exit code plus everything it printed. */
function release(args: readonly string[]): { status: number; output: string }
{
    const result = spawnSync(process.execPath, [RELEASE, ...args], { cwd: ROOT, encoding: 'utf8', shell: false });
    return { status: result.status ?? 1, output: `${ result.stdout }${ result.stderr }` };
}

function git(args: readonly string[]): string
{
    return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false }).stdout.trim();
}

const currentVersion = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const RESUME = ['--no-bump', '--skip-checks', '--dry-run', '-y', '--allow-branch'];

describe('release --no-bump (the documented resume path)', () =>
{
    it('refuses a version the working tree does not carry', () =>
    {
        const run = release(['9.9.9-beta.1', ...RESUME]);
        expect(run.status).toBe(1);
        expect(run.output).toContain(`package.json says ${ currentVersion }, not 9.9.9-beta.1`);
        expect(run.output).not.toContain('Publishing to npm');
    });

    it('refuses unless the release tag exists AND points at HEAD', () =>
    {
        const tag = `v${ currentVersion }`;
        const tagRevision = git(['rev-parse', '--verify', `${ tag }^{commit}`]);
        const headRevision = git(['rev-parse', 'HEAD']);
        const run = release([currentVersion, ...RESUME]);
        if (tagRevision === headRevision && tagRevision !== '')
        {
            // The tagged commit IS checked out: the tag is not what stops the run.
            expect(run.output).not.toContain('points at');
            expect(run.output).not.toContain('needs the release tag to exist');
        }
        else if (tagRevision === '')
        {
            expect(run.status).toBe(1);
            expect(run.output).toContain(`needs the release tag to exist already, but ${ tag } does not`);
        }
        else
        {
            expect(run.status).toBe(1);
            expect(run.output).toContain(`${ tag } points at`);
            expect(run.output).toContain('publish packs the tree, not the tag');
        }
    });

    it('reports the tree state whether or not a bump is happening', () =>
    {
        const dirty = git(['status', '--porcelain']) !== '';
        const run = release(['9.9.9-beta.1', ...RESUME]);
        // Under --dry-run the check reports; a real run fails on the same condition.
        expect(run.output.includes('working tree is not clean')).toBe(dirty);
    });
});

describe('release branch guard', () =>
{
    it('a non-default branch stops the release unless --allow-branch says otherwise', () =>
    {
        const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
        const origin = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).replace(/^refs\/remotes\/origin\//, '');
        const expected = origin === '' ? 'main' : origin;
        const run = release(['9.9.9-beta.1', '--no-bump', '--skip-checks', '--dry-run', '-y']);
        if (head === expected)
        {
            expect(run.output).not.toContain('not the default branch');
        }
        else
        {
            expect(run.status).toBe(1);
            expect(run.output).toContain(`not the default branch ${ expected }`);
        }
        expect(release(['9.9.9-beta.1', ...RESUME]).output).not.toContain('not the default branch');
    });
});

describe('release --otp', () =>
{
    it('never prints the code: it reaches npm through the environment, not an argv', () =>
    {
        // `--promote-latest` so the dist-tag move is part of the plan: it is the last command
        // an OTP reaches, and a stable release holds `latest`, which otherwise (correctly)
        // suppresses the promotion for a prerelease.
        const run = release(['9.9.9-beta.1', '--dry-run', '-y', '--skip-checks', '--allow-branch', '--promote-latest', '--otp', '987654']);
        expect(run.status).toBe(0);
        expect(run.output).toContain('Publishing to npm');
        expect(run.output).toContain('npm publish -w @azerothjs/schema --access public --tag beta');
        expect(run.output).toContain('npm dist-tag add');
        expect(run.output).toContain('forwarded through NPM_CONFIG_OTP (never argv)');
        expect(run.output).not.toContain('987654');
    });
});

describe('release dist-tag safety', () =>
{
    it('a prerelease leaves a STABLE latest alone - no flag to remember', () =>
    {
        // `latest` on a published stable line must not move to a prerelease, or a plain
        // `npm i azerothjs` downgrades everyone. The condition is read from the registry,
        // not left to the operator, and the plan says which version it is protecting.
        const run = release(['9.9.9-beta.1', '--dry-run', '-y', '--skip-checks', '--allow-branch']);
        expect(run.status).toBe(0);
        expect(run.output).toMatch(/latest:\s+left on \d+\.\d+\.\d+ \(a prerelease must not downgrade/);
        expect(run.output).not.toContain('npm dist-tag add');
    });

    it('--promote-latest overrides it deliberately', () =>
    {
        const run = release(['9.9.9-beta.1', '--dry-run', '-y', '--skip-checks', '--allow-branch', '--promote-latest']);
        expect(run.status).toBe(0);
        expect(run.output).toContain('promote -> 9.9.9-beta.1');
        expect(run.output).toContain('npm dist-tag add');
    });

    it('a STABLE release still lets npm publish set latest itself', () =>
    {
        const run = release(['9.9.9', '--dry-run', '-y', '--skip-checks', '--allow-branch']);
        expect(run.status).toBe(0);
        expect(run.output).toContain('set by publish');
        expect(run.output).not.toContain('npm dist-tag add');
    });
});

// The GitHub release body is composed from CHANGELOG.md and the API caps it at 125,000
// characters. A major's section can exceed that (2.0.0-beta.1's was 141,136), and the API
// rejects the whole request - failing the release AFTER npm has published, which is the
// worst moment for it. The body therefore has to fit by construction.
describe('release notes fit a GitHub release body', () =>
{
    const NOTES = join(ROOT, 'scripts', 'release-notes.mjs');
    const LIMIT = 125_000;

    function notes(version: string): { status: number; body: string; warnings: string }
    {
        const result = spawnSync(process.execPath, [NOTES, version], { cwd: ROOT, encoding: 'utf8', shell: false });
        return { status: result.status ?? 1, body: result.stdout, warnings: result.stderr };
    }

    it('stays under the cap for the version this repo currently carries', () =>
    {
        const run = notes(currentVersion);
        expect(run.status).toBe(0);
        expect(run.body.length).toBeLessThan(LIMIT);
    });

    it('degrades an oversized section to its outline instead of truncating prose', () =>
    {
        // Whether THIS version's section is oversized depends on the release; assert the
        // rule that holds either way - the body fits, and an oversized one keeps the index.
        const run = notes(currentVersion);
        expect(run.body.length).toBeLessThan(LIMIT);
        if (run.warnings.includes('over the'))
        {
            const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
            const section = changelog.split(`## [${ currentVersion }]`)[1]?.split('\n## [')[0] ?? '';
            const headings = (section.match(/^### /gm) ?? []).length;
            expect(headings).toBeGreaterThan(0);
            // Every heading survives as an index entry, and no prose is cut mid-sentence.
            expect((run.body.match(/^- /gm) ?? []).length).toBe(headings);
            expect(run.body).toContain('## What changed');
        }
        expect(run.body).toContain('[Full changelog]');
    });

    it('always emits the install block, section or not', () =>
    {
        const run = notes('9.9.9-beta.1');
        expect(run.status).toBe(0);
        expect(run.body).toContain('npm install azerothjs@9.9.9-beta.1');
    });
});
