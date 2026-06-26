#!/usr/bin/env node
// Release helper for the AzerothJS monorepo.
//
// The whole monorepo is versioned in lockstep: every package and editor
// integration shares one version, and every inter-package dependency is pinned
// to that exact version. This script bumps that version everywhere, verifies the
// build, commits, tags, pushes the tag to GitHub, and publishes the
// @azerothjs/* packages to npm.
//
// ----------------------------------------------------------------------------
// VERSIONING GUIDE (SemVer 2.0.0 + npm dist-tags)
//
// A version is MAJOR.MINOR.PATCH, optionally with a `-prerelease` suffix:
//
//   MAJOR  incompatible / breaking change - code using the old version may break.
//   MINOR  new functionality, backward-compatible.
//   PATCH  backward-compatible bug fix.
//   Bump the LEFTMOST part that applies and reset the parts to its right to 0
//   (a MINOR bump zeroes PATCH: 1.4.7 -> 1.5.0).
//
//   0.y.z (major version zero) is the "still stabilizing" phase: ANYTHING may
//   change at any time, so even a MINOR bump is allowed to break. AzerothJS is
//   here (0.6.x) until it commits to a stable 1.0.0 API.
//
// A `-<channel>.<n>` suffix marks a PRE-RELEASE: a version that comes BEFORE the
// stable release of the same number (1.0.0-beta.2 is OLDER than 1.0.0). The
// channel names a maturity stage; `.n` is the iteration within that stage:
//
//   alpha  earliest, unstable, incomplete; internal / early testers. APIs churn
//          freely.                         e.g. 1.0.0-alpha.1
//   beta   feature-complete-ish but still buggy; public testing. APIs mostly
//          frozen.                         e.g. 1.0.0-beta.1
//   rc     release candidate: believed shippable; ships AS the final unless a
//          blocker turns up. Only bug fixes land between an rc and the final.
//                                          e.g. 1.0.0-rc.1
//   next / canary  rolling bleeding-edge builds (a moving pointer, not a gate).
//
// Precedence, low -> high (this is also the only sane release ORDER):
//   1.0.0-alpha.1  <  1.0.0-beta.1  <  1.0.0-rc.1  <  1.0.0  <  1.0.1
// A pre-release ALWAYS ranks below its stable (1.0.0-rc.1 < 1.0.0); within a
// channel the trailing number is compared numerically (beta.2 < beta.11).
//
// A typical road to 1.0:
//   0.6.0 -> 1.0.0-alpha.1 -> ... -> 1.0.0-beta.1 -> 1.0.0-rc.1 -> 1.0.0
//
// npm DIST-TAG (a MOVABLE pointer, separate from the immutable version):
//   `npm i @azerothjs/core`        installs whatever `latest` points to.
//   `npm i @azerothjs/core@beta`   installs whatever `beta`   points to.
//   This script derives the tag from the version: a stable version publishes
//   under `latest`; a pre-release under its channel (-beta.3 -> beta; a
//   bare-numeric -0 -> next). See distTag() / prereleaseChannel() below.
// ----------------------------------------------------------------------------
//
// Usage:
//   npm run release -- <version> [options]
//   node scripts/release.mjs <version> [options]
//
// Examples:
//   npm run release -- 0.4.0-beta.2
//   npm run release -- 1.0.0
//   npm run release -- 0.5.0-rc.1 --dry-run
//   npm run release -- 0.4.0-beta.1 --no-bump        # finish a release already bumped/tagged
//
// Options:
//   --dry-run       Print every step without changing files, committing, or publishing.
//   --skip-checks   Skip the build / lint / test gate (not recommended).
//   --no-bump       Don't bump/commit/tag; just push the existing tag and publish.
//   --no-push       Skip the git push.
//   --no-publish    Skip the npm publish.
//   --no-promote-latest  Don't move the `latest` dist-tag to a prerelease.
//   --provenance    Attach an npm provenance attestation to each publish. Only
//                   valid when publishing from CI with OIDC; the publish
//                   workflow passes it. A local run must omit it.
//   --promote-only  Only move `latest` to an already-published version (no
//                   bump/push/publish). Fixes a `latest` left on an older beta:
//                     node scripts/release.mjs 0.4.0-beta.2 --promote-only -y
//   --otp <code>    npm one-time password (2FA), forwarded to every publish.
//   -y, --yes       Don't pause for the confirmation prompt.
//
// The npm dist-tag is derived from the version: a prerelease (1.2.0-beta.3) is
// published under its prerelease id (`beta`); a stable version under `latest`.
//
// Dist-tag policy: `npm publish --tag beta` leaves `latest` untouched, so a
// plain `npm i @azerothjs/<pkg>` would install whatever `latest` last pointed at
// (e.g. a stale earlier beta). Until a stable version ships there is no `latest`
// line to protect, so after publishing a prerelease this script also moves
// `latest` to the new version - keeping a fresh `npm i` current. Pass
// `--no-promote-latest` once a real stable release exists and prereleases should
// stay off `latest`.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Packages published to npm, in dependency order (dependencies first) so a
// freshly published package can always resolve the ones it depends on.
const PUBLISH_ORDER =
[
    'reactivity',
    'component',
    'testing',
    'renderer',
    'server',
    'router',
    'store',
    'form',
    'compiler',
    'core',
    // DevTools: a thin consumer of `@azerothjs/reactivity`'s stable, versioned devtools hook. Builds
    // and ships now that the hook protocol is in place; ordered after reactivity (its only framework dep).
    'devtools',
    // Editor tooling. Published too: the VS Code extension declares
    // `@azerothjs/language-server` + `@azerothjs/typescript-plugin` as runtime deps,
    // so a clean Marketplace install resolves them from npm. Ordered after their
    // deps (language-service before language-server / typescript-plugin).
    'eslint-plugin',
    'language-service',
    'language-server',
    'typescript-plugin'
];

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message)
{
    console.error('release: ' + message);
    process.exit(1);
}

function log(message)
{
    console.log(message);
}

/** Prints usage + a versioning cheat-sheet (the full detail is in the file header). */
function printHelp()
{
    log(`Release the AzerothJS monorepo (one lockstep version across every package).

Usage:  npm run release -- <version> [options]
        node scripts/release.mjs <version> [options]

Version:  MAJOR.MINOR.PATCH[-channel.n]      e.g. 1.0.0   1.0.0-beta.2
  MAJOR breaking | MINOR feature | PATCH fix   (0.y.z: anything may break)
  channels, low -> high maturity:  alpha  <  beta  <  rc  <  (stable)
  release order:  1.0.0-alpha.1 < 1.0.0-beta.1 < 1.0.0-rc.1 < 1.0.0
  the channel becomes the npm dist-tag (stable -> latest). See the file header.

Options:
  --dry-run            Show every step; change nothing.
  --skip-checks        Skip the build/lint/test gate (not recommended).
  --no-bump            Push + publish an existing tag; don't bump/commit/tag.
  --no-push            Skip the git push.
  --no-publish         Skip the npm publish.
  --no-promote-latest  Don't move 'latest' to a pre-release.
  --promote-only       Only move 'latest' to an already-published version.
  --provenance         Attach an npm provenance attestation (CI/OIDC only).
  --otp <code>         npm 2FA one-time password, forwarded to each publish.
  -y, --yes            Skip the confirmation prompt.
  -h, --help           Show this help.`);
}

/** Reads a command's stdout (used for read-only queries; always runs). */
function query(command)
{
    return execSync(command, { cwd: ROOT, encoding: 'utf8' }).trim();
}

let dryRun = false;

/** Runs a state-changing command, honouring --dry-run and forwarding stdio. */
function act(command, extra)
{
    log('  $ ' + command);
    if (dryRun)
    {
        return;
    }
    execSync(command, { cwd: ROOT, stdio: 'inherit', ...(extra ?? {}) });
}

/** Every file that carries the shared version (root, packages). */
function releaseFiles()
{
    const files = ['package.json'];
    for (const entry of readdirSync(path.join(ROOT, 'packages')))
    {
        const relative = path.join('packages', entry, 'package.json');
        if (existsSync(path.join(ROOT, relative)))
        {
            files.push(relative);
        }
    }
    // The editor integrations share the monorepo version (the header's promise) but live outside
    // `packages/`. Include their manifests so a release bumps them in lockstep instead of leaving
    // them stranded at the previous version - bumpFiles replaces the exact version string, which
    // appears as `"version"` in the VS Code manifest and `version = "..."` in the Gradle build.
    for (const editorFile of [path.join('editors', 'vscode', 'package.json'), path.join('editors', 'jetbrains', 'build.gradle.kts')])
    {
        if (existsSync(path.join(ROOT, editorFile)))
        {
            files.push(editorFile);
        }
    }
    return files;
}

// Recognized pre-release channels, in increasing maturity order. The channel is
// the alphabetic id at the start of the `-prerelease` suffix (1.2.0-beta.3 ->
// `beta`) and becomes the npm dist-tag. `next`/`canary` are rolling pointers, not
// maturity gates; a bare-numeric pre-release (1.2.0-0) has no channel name and
// also publishes under `next`. Anything outside this set is rejected as a typo
// (see the channel check below) so a slip like `1.0.0-bta.1` can't publish under
// a junk `bta` tag.
const PRERELEASE_CHANNELS = ['alpha', 'beta', 'rc', 'next', 'canary'];

// Maturity rank of the gated channels; used to warn on a backwards step
// (e.g. beta -> alpha for the SAME x.y.z). `next`/`canary` are unranked (rolling).
const CHANNEL_RANK = { alpha: 0, beta: 1, rc: 2 };

/**
 * The pre-release channel of a version, or null for a stable release.
 * `1.0.0` -> null; `1.0.0-beta.3` -> 'beta'; `1.0.0-0` -> 'next' (bare numeric).
 */
function prereleaseChannel(version)
{
    const dash = version.indexOf('-');
    if (dash === -1)
    {
        return null;
    }
    const id = version.slice(dash + 1).split('.')[0];
    return /^[a-z]+$/i.test(id) ? id.toLowerCase() : 'next';
}

/** The npm dist-tag implied by a version: its pre-release channel, or `latest` for a stable release. */
function distTag(version)
{
    return prereleaseChannel(version) ?? 'latest';
}

/** The MAJOR.MINOR.PATCH part of a version, without any pre-release suffix. */
function baseVersion(version)
{
    const dash = version.indexOf('-');
    return dash === -1 ? version : version.slice(0, dash);
}

/**
 * Replaces the current version string with the next one in every release file.
 * Inter-package pins equal the package version, so a literal replace updates
 * both `version` and the pins while leaving the file's formatting untouched.
 */
function bumpFiles(current, next)
{
    let total = 0;
    for (const file of releaseFiles())
    {
        const full = path.join(ROOT, file);
        const before = readFileSync(full, 'utf8');
        const occurrences = before.split(current).length - 1;
        if (occurrences === 0)
        {
            continue;
        }
        if (!dryRun)
        {
            writeFileSync(full, before.split(current).join(next));
        }
        total += occurrences;
        log(`  ${ file }: ${ occurrences } occurrence(s)`);
    }
    if (total === 0)
    {
        fail(`current version ${ current } not found in any release file`);
    }
}

function confirm(question)
{
    if (process.argv.includes('-y') || process.argv.includes('--yes') || dryRun || !process.stdin.isTTY)
    {
        return Promise.resolve(true);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve =>
    {
        rl.question(question + ' (y/N) ', answer =>
        {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

function parseArgs()
{
    const argv = process.argv.slice(2);
    const options = { help: false, skipChecks: false, noBump: false, noPush: false, noPublish: false, promoteLatest: true, promoteOnly: false, provenance: false, otp: null, version: null };
    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help')
        {
            options.help = true;
        }
        else if (arg === '--dry-run')
        {
            dryRun = true;
        }
        else if (arg === '--skip-checks')
        {
            options.skipChecks = true;
        }
        else if (arg === '--no-bump')
        {
            options.noBump = true;
        }
        else if (arg === '--no-push')
        {
            options.noPush = true;
        }
        else if (arg === '--no-publish')
        {
            options.noPublish = true;
        }
        else if (arg === '--no-promote-latest')
        {
            options.promoteLatest = false;
        }
        else if (arg === '--provenance')
        {
            // Attach an npm provenance attestation to each publish. Only works
            // when publishing from CI with OIDC (a local `npm publish
            // --provenance` errors), so this stays off by default and is passed
            // by the publish workflow.
            options.provenance = true;
        }
        else if (arg === '--promote-only')
        {
            // Move `latest` to an already-published version; change nothing else.
            options.noBump = true;
            options.noPush = true;
            options.noPublish = true;
            options.promoteLatest = true;
            options.promoteOnly = true;
        }
        else if (arg === '-y' || arg === '--yes')
        {
            // Handled in confirm(); accepted here so it isn't treated as the version.
            continue;
        }
        else if (arg === '--otp')
        {
            options.otp = argv[++i];
        }
        else if (arg.startsWith('--otp='))
        {
            options.otp = arg.slice('--otp='.length);
        }
        else if (arg.startsWith('-'))
        {
            fail('unknown option: ' + arg);
        }
        else if (options.version === null)
        {
            options.version = arg;
        }
        else
        {
            fail('unexpected argument: ' + arg);
        }
    }
    return options;
}

const options = parseArgs();

if (options.help)
{
    printHelp();
    process.exit(0);
}

const next = options.version;

if (!next)
{
    fail('a version is required, e.g. `npm run release -- 0.4.0-beta.2` (try --help)');
}
if (!VERSION_PATTERN.test(next))
{
    fail(`"${ next }" is not a valid version (expected MAJOR.MINOR.PATCH[-prerelease])`);
}

// A named (alphabetic) pre-release channel must be one we recognize, so a typo
// (`1.0.0-bta.1`) is caught here instead of silently publishing under a junk
// `bta` dist-tag that `npm i @azerothjs/<pkg>@beta` would never find.
const nextChannel = prereleaseChannel(next);
if (nextChannel !== null && !PRERELEASE_CHANNELS.includes(nextChannel))
{
    fail(`unknown pre-release channel "${ nextChannel }" in ${ next }. `
        + `Use one of: ${ PRERELEASE_CHANNELS.join(', ') } `
        + `(e.g. ${ baseVersion(next) }-beta.1), or a stable version like ${ baseVersion(next) }.`);
}

const tag = 'v' + next;
const current = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// Soft guard: for the SAME MAJOR.MINOR.PATCH, a pre-release channel should not
// step BACKWARDS in maturity (alpha -> beta -> rc -> stable). Going beta.1 then
// alpha.2 confuses consumers and inverts SemVer precedence. Warn, don't block -
// the operator may have a deliberate reason.
const currentChannel = prereleaseChannel(current);
if (
    baseVersion(current) === baseVersion(next)
    && currentChannel !== null && nextChannel !== null
    && currentChannel in CHANNEL_RANK && nextChannel in CHANNEL_RANK
    && CHANNEL_RANK[nextChannel] < CHANNEL_RANK[currentChannel]
)
{
    log(`\n  ! channel moves BACKWARDS: ${ current } (${ currentChannel }) -> ${ next } (${ nextChannel }). `
        + 'Pre-releases normally advance alpha -> beta -> rc -> stable.');
}
const tagExists = query('git tag -l ' + tag) === tag;

// A previous run can bump the version files and then die before committing or
// tagging (a failed verify, an interrupted push), leaving the files already at
// `next` with no tag. Detect that and RESUME - commit and tag the existing bump
// - instead of refusing ("version is already next") or, under `--no-bump`,
// trying to push a tag that was never created.
const resuming = !options.noBump && current === next && !tagExists;

// Promote `latest` only when this run actually publishes a prerelease, or when
// the operator explicitly asked to move it (`--promote-only`). A bare
// `--no-publish` must therefore NOT touch the registry, and a normal stable
// release leaves it to `npm publish` (which sets `latest` itself).
const willPromoteLatest = options.promoteLatest
    && (options.promoteOnly || (!options.noPublish && distTag(next) !== 'latest'));

log(`\nRelease ${ current } -> ${ next }`);
log(`  git tag:   ${ tag }${ tagExists ? ' (already exists)' : '' }`);
log(`  npm tag:   ${ distTag(next) }`);
log(`  latest:    ${ willPromoteLatest ? 'promote -> ' + next : (distTag(next) === 'latest' && !options.noPublish ? 'set by publish' : 'left unchanged') }`);
log(`  bump:      ${ options.noBump ? 'no' : (resuming ? `resume (files already at ${ next })` : 'yes') }`);
log(`  push:      ${ options.noPush ? 'no' : 'yes' }`);
log(`  publish:   ${ options.noPublish ? 'no' : PUBLISH_ORDER.length + ' packages' }`);
if (dryRun)
{
    log('  (dry run: nothing will be changed)');
}

// Changelog reminder (non-blocking): a release should describe what changed.
// Warn if CHANGELOG.md has no entry for this version yet - the operator can
// still proceed (e.g. a re-publish or promote-only run).
if (!options.promoteOnly)
{
    const changelogPath = path.join(ROOT, 'CHANGELOG.md');
    const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
    if (!changelog.includes(next))
    {
        log(`\n  ! CHANGELOG.md has no entry for ${ next } - promote the [Unreleased] section before releasing.`);
    }
}

if (!options.noBump)
{
    if (tagExists)
    {
        fail(`tag ${ tag } already exists; use --no-bump to push and publish it`);
    }
    // A fresh bump must start from a clean tree so the release commit is just
    // the bump. A resuming tree is expected to be dirty - that dirt IS the bump
    // a prior run left behind, which this run is about to commit and tag.
    if (!resuming)
    {
        const status = query('git status --porcelain');
        if (status && !dryRun)
        {
            fail('working tree is not clean; commit or stash first');
        }
    }
}

if (!(await confirm('\nProceed?')))
{
    fail('aborted');
}

if (!options.noBump && !resuming)
{
    log('\nBumping versions');
    bumpFiles(current, next);
    log('\nUpdating lockfile');
    act('npm install --package-lock-only --no-audit --no-fund');
}
else if (resuming)
{
    log(`\nVersion files already at ${ next }; resuming - committing and tagging the existing bump`);
}

if (!options.skipChecks)
{
    log('\nVerifying (build, lint, publish contract, publish smoke)');
    act('npm run build');
    act('npm run lint');
    // Validate the published artifacts before tagging: publint checks each
    // package.json contract; the smoke test packs + installs the tarballs and
    // imports them, catching a broken exports map or a corrupted inter-package
    // pin that the src-aliased suite cannot see.
    act('npm run lint:publish');
    act('npm run smoke');
}

if (!options.noBump)
{
    log('\nCommitting and tagging');
    act('git add -A');
    act(`git commit -m "chore(release): ${ tag }"`);
    act(`git tag -a ${ tag } -m "${ tag }"`);
}

if (!options.noPush)
{
    log('\nPushing to GitHub');
    act('git push origin HEAD');
    act('git push origin ' + tag);
}

if (!options.noPublish)
{
    log('\nPublishing to npm');
    const otpFlag = options.otp ? ` --otp=${ options.otp }` : '';
    const provenanceFlag = options.provenance ? ' --provenance' : '';
    const tagName = distTag(next);
    for (const name of PUBLISH_ORDER)
    {
        act(`npm publish -w @azerothjs/${ name } --access public --tag ${ tagName }${ provenanceFlag }${ otpFlag }`);
    }
}

// Dist-tag policy: `npm publish --tag beta` does NOT move `latest`, so a plain
// `npm i @azerothjs/<pkg>` would keep installing whatever `latest` happened to
// point at - here, an older beta with the pre-fix code. Until a stable
// (non-prerelease) version ships, `latest` must track the newest release so a
// fresh consumer gets current code. A stable publish already sets `latest`, so
// promotion only applies to prereleases. `--promote-only` fixes an
// already-published version's `latest` without re-publishing.
if (willPromoteLatest)
{
    log(`\nPromoting 'latest' -> ${ next } (newest release; pass --no-promote-latest to skip)`);
    const otpAdd = options.otp ? ` --otp=${ options.otp }` : '';
    for (const name of PUBLISH_ORDER)
    {
        act(`npm dist-tag add @azerothjs/${ name }@${ next } latest${ otpAdd }`);
    }
}

log(`\nDone: ${ next }`);
log('Verify with: ' + PUBLISH_ORDER.map(n => `npm view @azerothjs/${ n } dist-tags`).slice(0, 1).join('') + '  (repeat per package)');
