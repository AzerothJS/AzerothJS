// Composes the GitHub Release body for a version from CHANGELOG.md.
//
// The changelog is hand-written and is the best description of a release this
// project has; GitHub's auto-generated notes are a commit-level index. This script
// emits the former so the workflow can hand it to `gh release create --notes-file`
// ALONGSIDE `--generate-notes`: the GitHub API pre-pends a supplied body to the
// generated notes, so a release page reads curated prose first, then the
// "What's Changed" PR list and the compare link.
//
// Usage:
//   node scripts/release-notes.mjs 1.2.0              # body on stdout
//   node scripts/release-notes.mjs v1.2.0 --out F     # body written to F
//
// A missing or empty changelog section is NOT fatal: it warns on stderr and emits
// the install block alone. This mirrors promoteChangelog() in release.mjs - a
// changelog problem should nag, never block a release that is already tagged and
// published.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message)
{
    console.error('release-notes: ' + message);
    process.exit(1);
}

function warn(message)
{
    console.error('release-notes: ' + message);
}

/** The https repository URL, derived from package.json rather than hardcoded. */
function repositoryUrl()
{
    try
    {
        const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? '';
        const cleaned = raw.replace(/^git\+/, '').replace(/\.git$/, '');
        return cleaned.startsWith('http') ? cleaned : 'https://github.com/AzerothJS/AzerothJS';
    }
    catch
    {
        return 'https://github.com/AzerothJS/AzerothJS';
    }
}

/**
 * The body of `## [version] - date` in CHANGELOG.md, up to the next `## [` heading.
 * Returns null when the file or the section is absent - both are non-fatal.
 */
function changelogSection(version)
{
    let text;
    try
    {
        text = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    }
    catch
    {
        warn('no CHANGELOG.md - emitting the install block alone');
        return null;
    }

    // Match the heading promoteChangelog() writes: `## [1.2.0] - 2026-07-27`. The date
    // is optional so a hand-written section without one still resolves.
    const heading = new RegExp(`^## \\[${ version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }\\][^\\n]*$`, 'm');
    const start = text.search(heading);
    if (start === -1)
    {
        warn(`no '## [${ version }]' section in CHANGELOG.md - emitting the install block alone`);
        return null;
    }

    const after = text.slice(start);
    const nextHeading = after.slice(1).search(/^## \[/m);
    const section = nextHeading === -1 ? after : after.slice(0, nextHeading + 1);
    // Drop the heading itself: the release page already shows the version as its title.
    const body = section.replace(heading, '').trim();
    if (body === '')
    {
        warn(`the '## [${ version }]' section is empty - emitting the install block alone`);
        return null;
    }
    return body;
}

function compose(version, section, repo)
{
    // Pad the two commands to a common width so their comments line up whatever
    // the version's length.
    const scaffold = 'npm create azeroth@latest my-app';
    const install = `npm install azerothjs@${ version }`;
    const column = Math.max(scaffold.length, install.length) + 2;

    const parts =
    [
        '## Install',
        '',
        '```sh',
        `${ scaffold.padEnd(column) }# scaffold a new app`,
        `${ install.padEnd(column) }# add to an existing one`,
        '```',
        '',
        'Every `@azerothjs/*` package ships at this same version - the monorepo is versioned',
        'in lockstep. Editor plugins are attached to this release: the `.vsix` for VS Code,',
        'the `.zip` for JetBrains (Settings -> Plugins -> Install Plugin from Disk).'
    ];

    if (section !== null)
    {
        parts.push('', '---', '', section);
    }

    parts.push(
        '',
        '---',
        '',
        `[Full changelog](${ repo }/blob/v${ version }/CHANGELOG.md)`
    );

    return parts.join('\n') + '\n';
}

function parseArgs(argv)
{
    let version = null;
    let out = null;
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--out')
        {
            out = argv[index + 1] ?? null;
            index += 1;
        }
        else if (arg.startsWith('--out='))
        {
            out = arg.slice('--out='.length);
        }
        else if (arg.startsWith('-'))
        {
            fail(`unknown option: ${ arg }`);
        }
        else if (version === null)
        {
            version = arg;
        }
        else
        {
            fail(`unexpected argument: ${ arg }`);
        }
    }
    return { version, out };
}

const args = parseArgs(process.argv.slice(2));
if (args.version === null)
{
    fail('a version is required, e.g. `node scripts/release-notes.mjs 1.2.0`');
}
if (args.out === null && process.argv.includes('--out'))
{
    fail('--out needs a file path');
}

// Accept both `1.2.0` and the tag form `v1.2.0`.
const version = args.version.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
{
    fail(`'${ args.version }' is not a version`);
}

const body = compose(version, changelogSection(version), repositoryUrl());

if (args.out === null)
{
    process.stdout.write(body);
}
else
{
    writeFileSync(args.out, body);
    console.error(`release-notes: wrote ${ args.out }`);
}
