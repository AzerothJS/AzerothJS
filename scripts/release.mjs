#!/usr/bin/env node
// Release helper for the AzerothJS monorepo.
//
// The whole monorepo is versioned in lockstep: every package and editor
// integration shares one version, and every inter-package dependency is pinned
// to that exact version. This script bumps that version everywhere, verifies the
// build, commits, tags, pushes the tag to GitHub, and publishes the
// @azerothjs/* packages to npm.
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
//
// Editor integrations (editors/*) get their version bumped for consistency but
// are not published to npm: the VS Code extension ships through vsce and the
// JetBrains plugin through Gradle.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Packages published to npm, in dependency order (dependencies first) so a
// freshly published package can always resolve the ones it depends on.
// devtools-overlay sits before compiler because compiler optionally peers on
// it (the dev-serve error overlay); the dev tooling (devtools, testing,
// eslint-plugin) goes after its own deps.
const PUBLISH_ORDER =
[
    'reactivity',
    'devtools-overlay',
    'devtools',
    'component',
    'testing',
    'renderer',
    'server',
    'router',
    'store',
    'form',
    'compiler',
    'core',
    'language-service',
    'typescript-plugin',
    'language-server',
    'eslint-plugin'
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

/** Every file that carries the shared version (root, packages, editors). */
function releaseFiles()
{
    const files = ['package.json', 'editors/vscode/package.json', 'editors/jetbrains/build.gradle.kts'];
    for (const entry of readdirSync(path.join(ROOT, 'packages')))
    {
        const relative = path.join('packages', entry, 'package.json');
        if (existsSync(path.join(ROOT, relative)))
        {
            files.push(relative);
        }
    }
    return files;
}

/** The npm dist-tag implied by a version string. */
function distTag(version)
{
    const dash = version.indexOf('-');
    if (dash === -1)
    {
        return 'latest';
    }
    const id = version.slice(dash + 1).split('.')[0];
    return /^[a-z]+$/i.test(id) ? id : 'next';
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
    const options = { skipChecks: false, noBump: false, noPush: false, noPublish: false, promoteLatest: true, promoteOnly: false, otp: null, version: null };
    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        if (arg === '--dry-run')
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
const next = options.version;

if (!next)
{
    fail('a version is required, e.g. `npm run release -- 0.4.0-beta.2`');
}
if (!VERSION_PATTERN.test(next))
{
    fail(`"${ next }" is not a valid version (expected MAJOR.MINOR.PATCH[-prerelease])`);
}

const tag = 'v' + next;
const current = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
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
    log('\nUpdating lockfile');
    act('npm install --package-lock-only --no-audit --no-fund');
}
else if (resuming)
{
    log(`\nVersion files already at ${ next }; resuming - committing and tagging the existing bump`);
}

if (!options.skipChecks)
{
    log('\nVerifying (build, lint, test)');
    act('npm run build');
    act('npm run lint');
    act('npx vitest run');
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
    const tagName = distTag(next);
    for (const name of PUBLISH_ORDER)
    {
        act(`npm publish -w @azerothjs/${ name } --access public --tag ${ tagName }${ otpFlag }`);
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
