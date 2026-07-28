// Commit-message gate for the husky `commit-msg` hook.
//
// Enforces the Conventional Commits shape this project documents in CONTRIBUTING
// ("Commit messages"): `type(scope): summary`, where the scope is a repository path.
//
// Deliberately strict about the parts that carry meaning - the TYPE (it is what makes
// `git log` scannable and drives the release-note categories) and a real summary - and
// deliberately loose about the scope, which is validated for SHAPE only. A hook that
// rejects legitimate work is worse than no hook, and the history contains both
// path scopes (`feat(packages/form)`) and bare ones (`feat(compiler)`).
//
// Git's own machine-generated messages (merge, revert, fixup!/squash!) are exempt:
// they are produced by commands, not typed by a human, and rewriting them breaks the
// tools that read them back.
//
// Usage: node scripts/check-commit-msg.mjs <path-to-COMMIT_EDITMSG>

import { readFileSync } from 'node:fs';
import process from 'node:process';

const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'chore', 'ci', 'style', 'revert'];

// One scope: a slash-separated path (`packages/form`, `editors/vscode`) or a bare
// name (`ci`, `deps-dev`, `changelog`).
const SCOPE = '[a-z0-9-]+(?:/[a-z0-9.-]+)*';

// `type(scope)!: summary` - scope and `!` optional. A scope may be a COMMA-SEPARATED
// list, which this history uses for a change that genuinely spans areas:
// `docs(changelog,readme)`, `feat(http,api)`. The alternative - one umbrella scope
// naming the parts in the summary, `feat(packages): store, reactivity` - also passes.
const HEADER = new RegExp(`^([a-z]+)(?:\\((${ SCOPE }(?:,${ SCOPE })*)\\))?(!)?: (.+)$`);

// Messages git writes itself; a human never types these.
const GENERATED = /^(?:Merge |Revert |fixup! |squash! |amend! )/;

// Length is a NUDGE, not a rule: it warns and lets the commit through. Real history
// runs to 153 characters on release commits, and a hook that blocks a descriptive
// summary teaches people to write worse ones.
const LONG_HEADER = 100;

function reject(header, problem, hint)
{
    const lines =
    [
        '',
        `  x ${ problem }`,
        '',
        `    ${ header === '' ? '(empty message)' : header }`,
        ''
    ];
    if (hint !== undefined)
    {
        lines.push(`    ${ hint }`, '');
    }
    lines.push(
        '    expected: type(scope): summary',
        `    types:    ${ TYPES.join(' ') }`,
        '    scope:    a repository path - packages/form, editors/vscode, ci, scripts',
        '              several areas: a comma list (http,api) or one umbrella scope',
        '              naming them in the summary (packages: store, reactivity)',
        '',
        '    examples: fix(packages/router): guard a vetoed SSR route',
        '              feat(packages): store and reactivity share one thunk-unwrap',
        '              docs(changelog,readme): promote 1.0.0',
        '',
        '    See CONTRIBUTING.md ("Commit messages"). Amend with: git commit --amend',
        ''
    );
    process.stderr.write(lines.join('\n'));
    process.exit(1);
}

const messagePath = process.argv[2];
if (messagePath === undefined)
{
    process.stderr.write('check-commit-msg: a path to the commit message file is required\n');
    process.exit(1);
}

let raw;
try
{
    raw = readFileSync(messagePath, 'utf8');
}
catch (error)
{
    process.stderr.write(`check-commit-msg: cannot read ${ messagePath }: ${ error.message }\n`);
    process.exit(1);
}

// Everything below git's scissors line is a diff for reference, not the message.
const withoutDiff = raw.split(/^# -+ >8 -+$/m)[0];
const body = withoutDiff.split('\n').filter((line) => !line.startsWith('#'));
const header = (body[0] ?? '').trim();

if (header === '')
{
    reject('', 'the commit message is empty');
}

if (GENERATED.test(header))
{
    process.exit(0);
}

const match = HEADER.exec(header);
if (match === null)
{
    // Name the likeliest specific mistake rather than restating the grammar.
    const hint = /^[a-z]+(\([^)]*\))?!?:\S/.test(header)
        ? 'a space is required after the colon.'
        : (/^[A-Z]/.test(header) ? 'start with a lowercase type, not a capital letter.' : undefined);
    reject(header, 'commit message does not follow Conventional Commits', hint);
}

const [, type, scope, , summary] = match;

if (!TYPES.includes(type))
{
    reject(header, `'${ type }' is not a commit type`);
}
if (summary.trim() === '')
{
    reject(header, 'the summary is empty');
}
if (summary.endsWith('.'))
{
    reject(header, 'the summary should not end with a period');
}
// A scope is optional, but an empty one - `feat(): x` - is a typo, not a choice.
if (scope !== undefined && scope.trim() === '')
{
    reject(header, 'the scope is empty - drop the parentheses or name a path');
}

if (header.length > LONG_HEADER)
{
    process.stderr.write(
        `\n  ! the header is ${ header.length } characters; under ${ LONG_HEADER } reads better in `
        + 'git log --oneline.\n    Consider moving detail into the body, after a blank line.\n\n'
    );
}

process.exit(0);
