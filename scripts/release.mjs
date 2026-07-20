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
//   `npm i azerothjs`              installs whatever `latest` points to.
//   `npm i azerothjs@beta`         installs whatever `beta`   points to.
//   This script derives the tag from the version: a stable version publishes
//   under `latest`; a pre-release under its channel (-beta.3 -> beta; a
//   bare-numeric -0 -> next). See distTag() / prereleaseChannel() below.
// ----------------------------------------------------------------------------
//
// Usage:
//   npm run release -- <version | keyword> [options]
//   node scripts/release.mjs <version | keyword> [options]
//
// The version may be a FULL version (1.2.3, 1.2.3-beta.4) or a BUMP KEYWORD resolved
// against the current version, so nothing has to be computed by hand:
//
//   beta | alpha | rc   same base, that channel (.1 to enter, .n+1 when already on it)
//                       0.7.0-beta.1 -> `beta` -> 0.7.0-beta.2; -> `rc` -> 0.7.0-rc.1
//   pre                 next iteration of the current prerelease channel
//   stable              drop the prerelease suffix        0.7.0-beta.3 -> 0.7.0
//   patch|minor|major   SemVer increment; a prerelease line keeps its channel for
//                       minor/major (0.7.0-beta.1 -> `minor` -> 0.8.0-beta.1) and
//                       finalizes for patch (-> 0.7.0). `--channel <c|stable>` overrides.
//
// Examples:
//   npm run release -- beta                          # next beta iteration
//   npm run release -- rc                            # promote the line to rc.1
//   npm run release -- stable                        # cut the stable release
//   npm run release -- minor --channel stable        # 0.7.x-beta -> 0.8.0 directly
//   npm run release -- 0.5.0-rc.1 --dry-run
//   npm run release -- 0.4.0-beta.1 --no-bump        # finish a release already bumped/tagged
//
// Options:
//   --dry-run       Print every step without changing files, committing, or publishing.
//   --channel <c>   Channel for patch/minor/major bumps (alpha|beta|rc|next|canary|stable).
//   --no-changelog  Skip the automatic CHANGELOG.md [Unreleased] promotion.
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
// Publishing is IDEMPOTENT: versions already on the registry are skipped, so an
// interrupted run can simply be re-run. The bump also promotes CHANGELOG.md's
// [Unreleased] section and keeps the version examples in CONTRIBUTING.md and the
// bug-report template current.
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
// freshly published package can always resolve the ones it depends on. Full
// package names: the official entry package `azerothjs` is unscoped, so a
// hardcoded `@azerothjs/` prefix would misname it.
const PUBLISH_ORDER =
[
    '@azerothjs/reactivity',
    '@azerothjs/component',
    '@azerothjs/testing',
    '@azerothjs/renderer',
    '@azerothjs/server',
    '@azerothjs/router',
    '@azerothjs/store',
    // Logger before the backend packages: @azerothjs/http prints the startup banner
    // through it, so it must be resolvable on npm before http publishes.
    '@azerothjs/logger',
    // schema before form: @azerothjs/form depends on @azerothjs/schema (form re-exports
    // its validators), so schema must be resolvable on npm before form publishes.
    // Remaining backend packages follow deps-first when they land: cron, http, ws, api.
    '@azerothjs/schema',
    '@azerothjs/form',
    '@azerothjs/compiler',
    'azerothjs',
    // DevTools: a thin consumer of `@azerothjs/reactivity`'s stable, versioned devtools hook. Builds
    // and ships now that the hook protocol is in place; ordered after reactivity (its only framework dep).
    '@azerothjs/devtools',
    // Editor tooling. Published too: the VS Code extension declares
    // `@azerothjs/language-server` + `@azerothjs/typescript-plugin` as runtime deps,
    // so a clean Marketplace install resolves them from npm. Ordered after their
    // deps (language-service before language-server / typescript-plugin).
    '@azerothjs/eslint-plugin',
    '@azerothjs/language-service',
    '@azerothjs/language-server',
    '@azerothjs/typescript-plugin'
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

/**
 * Resolves a version INPUT - either a full version string or a bump keyword - against the current
 * version, so the operator never has to compute the next number by hand:
 *
 *   full version   1.2.3 / 1.2.3-beta.4   used as-is
 *   alpha|beta|rc  same base, that channel: enter it at .1, or increment .n if already on it
 *                  (0.7.0-beta.1 -> `beta` -> 0.7.0-beta.2; -> `rc` -> 0.7.0-rc.1)
 *   pre            increment the current prerelease number (alias of the current channel)
 *   stable         drop the prerelease suffix (0.7.0-beta.3 -> 0.7.0)
 *   patch|minor|major
 *                  on a stable current: normal SemVer increment (0.7.0 -> patch -> 0.7.1)
 *                  on a prerelease: increments the BASE then applies --channel (default: keep the
 *                  current channel) at .1 (0.7.0-beta.1 -> minor -> 0.8.0-beta.1); pass
 *                  `--channel stable` to cut a stable directly.
 */
function resolveVersion(input, current)
{
    if (VERSION_PATTERN.test(input))
    {
        return input;
    }

    const base = baseVersion(current);
    const [major, minor, patch] = base.split('.').map(Number);
    const channel = prereleaseChannel(current);
    const iteration = channel === null ? 0 : Number(current.slice(current.indexOf('-') + 1).split('.')[1] ?? 0);

    // Channel keywords: same base, enter that channel at .1, or advance .n when already on it.
    if (['alpha', 'beta', 'rc', 'next', 'canary'].includes(input))
    {
        return input === channel
            ? `${ base }-${ channel }.${ iteration + 1 }`
            : `${ base }-${ input }.1`;
    }

    if (input === 'pre' || input === 'prerelease')
    {
        if (channel === null)
        {
            fail(`current version ${ current } is stable - name the channel instead (e.g. \`release -- beta\`)`);
        }
        return `${ base }-${ channel }.${ iteration + 1 }`;
    }

    if (input === 'stable' || input === 'release')
    {
        if (channel === null)
        {
            fail(`current version ${ current } is already stable - use patch/minor/major`);
        }
        return base;
    }

    // patch/minor/major: compute the next BASE, then decide its channel.
    let nextBase;
    if (input === 'patch')
    {
        // SemVer: "patch" on a prerelease releases the base it precedes (0.7.0-beta.1 -> 0.7.0).
        nextBase = channel !== null ? base : `${ major }.${ minor }.${ patch + 1 }`;
    }
    else if (input === 'minor')
    {
        nextBase = `${ major }.${ minor + 1 }.0`;
    }
    else if (input === 'major')
    {
        nextBase = `${ major + 1 }.0.0`;
    }
    else
    {
        fail(`"${ input }" is neither a version nor a bump keyword `
            + '(alpha, beta, rc, pre, stable, patch, minor, major)');
    }

    if (options.channel === 'stable')
    {
        return nextBase;
    }
    if (options.channel)
    {
        return `${ nextBase }-${ options.channel }.1`;
    }
    // No --channel: a prerelease line stays on its channel for minor/major; `patch` finalizes.
    if (channel !== null && input !== 'patch')
    {
        return `${ nextBase }-${ channel }.1`;
    }
    return nextBase;
}

/** Prints usage + a versioning cheat-sheet (the full detail is in the file header). */
function printHelp()
{
    log(`Release the AzerothJS monorepo (one lockstep version across every package).

Usage:  npm run release -- <version | keyword> [options]
        node scripts/release.mjs <version | keyword> [options]

Keywords (resolved against the current version - no math needed):
  beta / alpha / rc   same base, that channel (.1 to enter, .n+1 when on it)
  pre                 next iteration of the current prerelease
  stable              drop the prerelease suffix (cut the release)
  patch|minor|major   SemVer bump; prerelease lines keep their channel
                      (override with --channel <c> or --channel stable)

Version:  MAJOR.MINOR.PATCH[-channel.n]      e.g. 1.0.0   1.0.0-beta.2
  MAJOR breaking | MINOR feature | PATCH fix   (0.y.z: anything may break)
  channels, low -> high maturity:  alpha  <  beta  <  rc  <  (stable)
  release order:  1.0.0-alpha.1 < 1.0.0-beta.1 < 1.0.0-rc.1 < 1.0.0
  the channel becomes the npm dist-tag (stable -> latest). See the file header.

Options:
  --dry-run            Show every step; change nothing.
  --channel <c>        Channel for patch/minor/major (alpha|beta|rc|stable).
  --no-changelog       Skip the CHANGELOG.md [Unreleased] promotion.
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
    // Docs that quote the current version as an example (the CONTRIBUTING release commands, the
    // bug-report version placeholder). Including them keeps the examples current for free instead
    // of drifting a release behind until someone notices.
    for (const docFile of ['CONTRIBUTING.md', path.join('.github', 'ISSUE_TEMPLATE', 'bug_report.yml')])
    {
        if (existsSync(path.join(ROOT, docFile)))
        {
            files.push(docFile);
        }
    }
    return files;
}

/**
 * Promotes CHANGELOG.md's `[Unreleased]` section to `next`: retitles it with the version and
 * today's date, inserts a fresh empty `[Unreleased]` above it, and rewrites the compare links at
 * the bottom. Warns and does nothing when the file or section is missing - a changelog problem
 * should never block a release, only nag.
 */
function promoteChangelog(nextVersion)
{
    const changelogPath = path.join(ROOT, 'CHANGELOG.md');
    if (!existsSync(changelogPath))
    {
        log('  ! no CHANGELOG.md - skipping changelog promotion');
        return;
    }
    const text = readFileSync(changelogPath, 'utf8');
    if (!text.includes('## [Unreleased]'))
    {
        log('  ! CHANGELOG.md has no [Unreleased] section - skipping changelog promotion');
        return;
    }
    if (text.includes(`## [${ nextVersion }]`))
    {
        log(`  CHANGELOG.md already has a ${ nextVersion } section - leaving it as is`);
        return;
    }
    const today = new Date().toISOString().slice(0, 10);
    let out = text.replace('## [Unreleased]', `## [Unreleased]\n\n## [${ nextVersion }] - ${ today }`);
    // Link block: [Unreleased] compares from the NEW tag; the new version compares from the
    // previous tag (taken from the old [Unreleased] link).
    const unreleasedLink = out.match(/^\[Unreleased\]: (.+?)compare\/(v\S+)\.\.\.HEAD$/m);
    if (unreleasedLink)
    {
        const [, repoBase, previousTag] = unreleasedLink;
        out = out.replace(unreleasedLink[0],
            `[Unreleased]: ${ repoBase }compare/v${ nextVersion }...HEAD\n`
            + `[${ nextVersion }]: ${ repoBase }compare/${ previousTag }...v${ nextVersion }`);
    }
    log(`  CHANGELOG.md: [Unreleased] -> [${ nextVersion }] - ${ today }`);
    if (!dryRun)
    {
        writeFileSync(changelogPath, out);
    }
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

/**
 * Post-bump safety net for the literal string replace: while versions carry a prerelease suffix
 * they are effectively unique, but a plain `1.0.0` could coincide with a THIRD-PARTY dependency
 * pin in a manifest and get clobbered. Re-parse every bumped package.json and flag any
 * non-AzerothJS dependency that now equals the release version.
 */
function guardBumpedManifests(nextVersion)
{
    for (const file of releaseFiles())
    {
        if (!file.endsWith('package.json'))
        {
            continue;
        }
        const manifest = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
        {
            for (const [name, pin] of Object.entries(manifest[section] ?? {}))
            {
                if (pin === nextVersion && name !== 'azerothjs' && !name.startsWith('@azerothjs/'))
                {
                    log(`\n  ! ${ file }: third-party dependency "${ name }" is pinned to ${ nextVersion } - `
                        + 'the literal version replace may have clobbered it. Check before committing.');
                }
            }
        }
    }
}

/** True when `name@version` already exists on the registry (makes publish resumable). */
function alreadyPublished(name, version)
{
    try
    {
        return query(`npm view ${ name }@${ version } version`) === version;
    }
    catch
    {
        return false;
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
    const options = { help: false, skipChecks: false, noBump: false, noPush: false, noPublish: false, promoteLatest: true, promoteOnly: false, provenance: false, otp: null, version: null, channel: undefined, changelog: true };
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
        else if (arg === '--channel')
        {
            options.channel = argv[++i];
        }
        else if (arg.startsWith('--channel='))
        {
            options.channel = arg.slice('--channel='.length);
        }
        else if (arg === '--no-changelog')
        {
            options.changelog = false;
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

if (!options.version)
{
    fail('a version or bump keyword is required, e.g. `npm run release -- beta` or `-- 0.8.0-rc.1` (try --help)');
}
if (options.channel !== undefined && options.channel !== 'stable' && !PRERELEASE_CHANNELS.includes(options.channel))
{
    fail(`unknown --channel "${ options.channel }". Use one of: ${ PRERELEASE_CHANNELS.join(', ') }, stable.`);
}

const currentForResolve = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const next = resolveVersion(options.version, currentForResolve);

if (!VERSION_PATTERN.test(next))
{
    fail(`"${ next }" is not a valid version (expected MAJOR.MINOR.PATCH[-prerelease])`);
}
if (options.version !== next)
{
    log(`\n  ${ options.version } -> ${ next }  (resolved against current ${ currentForResolve })`);
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
const current = currentForResolve;

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
    guardBumpedManifests(next);
    if (options.changelog)
    {
        log('\nPromoting the changelog');
        promoteChangelog(next);
    }
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

// Publish BEFORE pushing: the pushed commit/tag triggers CI that builds the editor
// extensions, whose manifests pin the just-released @azerothjs/* versions from the
// REGISTRY. Pushing first raced that publish - CI's `npm ci`/`npm install` asked npm
// for versions that were still minutes away and failed with ETARGET. Publishing
// first makes the registry consistent before any CI can start; if a publish dies
// mid-run, nothing was pushed and the resume flow (`--no-bump`) finishes the job.
if (!options.noPublish)
{
    log('\nPublishing to npm');
    const otpFlag = options.otp ? ` --otp=${ options.otp }` : '';
    const provenanceFlag = options.provenance ? ' --provenance' : '';
    const tagName = distTag(next);
    for (const name of PUBLISH_ORDER)
    {
        // Idempotent: a resumed run (a publish that died halfway, or a re-run after a network
        // hiccup) skips versions already on the registry instead of failing with E403.
        if (!dryRun && alreadyPublished(name, next))
        {
            log(`  ${ name }@${ next } already on the registry - skipping`);
            continue;
        }
        act(`npm publish -w ${ name } --access public --tag ${ tagName }${ provenanceFlag }${ otpFlag }`);
    }

    // Registry-readiness gate: `npm publish` returning is NOT the same as the version being
    // resolvable - packuments propagate through the registry's caches for seconds, and for a
    // FIRST-EVER publish of a name it can take minutes. Everything downstream resolves these
    // versions from the registry (the lockfile sync below, and the CI the push triggers), so
    // wait here until every package actually answers before moving on.
    if (!dryRun)
    {
        log('\nWaiting for the registry to serve every published version');
        const deadline = Date.now() + 10 * 60_000;
        let pending = [...PUBLISH_ORDER];
        for (;;)
        {
            pending = pending.filter(name => !alreadyPublished(name, next));
            if (pending.length === 0)
            {
                log('  registry consistent - all versions resolvable');
                break;
            }
            if (Date.now() > deadline)
            {
                log(`  WARNING: still unresolvable after 10m: ${ pending.join(', ') } - continuing anyway`);
                break;
            }
            log(`  waiting on ${ pending.length } package(s): ${ pending.join(', ') }`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
        }
    }

    // The VS Code extension pins the @azerothjs versions released MOMENTS ago, so its lockfile
    // could not be regenerated at bump time (the registry had nothing to resolve). Now it can;
    // ship the sync as a small follow-up commit so the next clone's `npm ci` there just works.
    // Runs on resumed (--no-bump) runs too: the install is idempotent and the commit below
    // only happens when the lockfile actually changed.
    if (existsSync(path.join(ROOT, 'editors', 'vscode', 'package-lock.json')))
    {
        log('\nSyncing editors/vscode lockfile against the published versions');
        // The registry can lag a publish by seconds while packuments propagate through its
        // caches, so an ETARGET here is TRANSIENT - retry with a pause instead of dying after
        // every package is already live. --prefer-online defeats the stale local packument.
        const syncCommand = 'npm install --package-lock-only --prefer-online --no-audit --no-fund';
        const attempts = 5;
        for (let attempt = 1; attempt <= attempts; attempt++)
        {
            try
            {
                act(syncCommand, { cwd: path.join(ROOT, 'editors', 'vscode') });
                break;
            }
            catch
            {
                if (attempt === attempts)
                {
                    // NON-FATAL: dying here stranded the release in its worst state - published
                    // and committed but never pushed. The lockfile sync is a nicety; the push is
                    // not. Skip the sync and let the release finish; run it by hand afterwards.
                    log('  WARNING: lockfile sync still failing - continuing WITHOUT it.');
                    log(`  Run manually later: cd editors/vscode && ${ syncCommand }, then commit the lockfile.`);
                    break;
                }
                log(`  registry not caught up yet (attempt ${ attempt }/${ attempts }); retrying in 15s`);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
            }
        }
        const lockDirty = query('git status --porcelain editors/vscode/package-lock.json');
        if (lockDirty)
        {
            act('git add editors/vscode/package-lock.json');
            act(`git commit -m "chore(release): sync editor lockfile for ${ tag }"`);
        }
    }
}

if (!options.noPush)
{
    log('\nPushing to GitHub');
    act('git push origin HEAD');
    act('git push origin ' + tag);
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
        act(`npm dist-tag add ${ name }@${ next } latest${ otpAdd }`);
    }
}

log(`\nDone: ${ next }`);
log('Verify with: ' + PUBLISH_ORDER.map(n => `npm view ${ n } dist-tags`).slice(0, 1).join('') + '  (repeat per package)');
