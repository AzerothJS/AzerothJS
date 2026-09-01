// @vitest-environment node
//
// Templates are SHIPPED SOURCE, and until this file existed no gate ever checked their markup:
// the root eslint config ignores `packages/create-azeroth/templates/**` and `overlays/**`, and
// the vitest include glob skips them too. The hole was not theoretical - a scaffolded fullstack
// app shipped an `<Image>` tag whose `{64}` violated interpolation-spacing, so a brand new
// project warned on its own first `npm run check`, while every repo gate stayed green.
//
// The check runs the compiler's OWN markup linter - the same `lintSource` the vite plugin calls
// on every transform - over the SUBSTITUTED text, because that is what the user receives.
// Linting the raw template would flag `{{name}}`, a placeholder that never reaches a project.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintSource } from '@azerothjs/compiler';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Mirrors scaffold.ts's substitution: the two placeholders every template file may carry. */
function substitute(text: string): string
{
    return text.replaceAll('{{name}}', 'sample-app').replaceAll('{{version}}', '9.9.9');
}

function azerothFilesIn(root: string): string[]
{
    const out: string[] = [];
    const walk = (dir: string): void =>
    {
        for (const entry of readdirSync(dir))
        {
            const full = join(dir, entry);
            if (statSync(full).isDirectory())
            {
                walk(full);
            }
            else if (entry.endsWith('.azeroth'))
            {
                out.push(full);
            }
        }
    };
    walk(root);
    return out;
}

const files = [
    ...azerothFilesIn(join(PACKAGE_ROOT, 'templates')),
    ...azerothFilesIn(join(PACKAGE_ROOT, 'overlays'))
];

describe('shipped template markup', () =>
{
    it('finds template sources to check (a silent empty set would defeat the guard)', () =>
    {
        expect(files.length).toBeGreaterThan(10);
    });

    it.each(files.map((file) => [relative(PACKAGE_ROOT, file).replaceAll('\\', '/'), file]))(
        '%s lints clean once scaffolded',
        (_label, file) =>
        {
            const warnings = lintSource(substitute(readFileSync(file, 'utf8')));
            // Name the rule and the offending text: a bare count tells the next reader nothing.
            const source = substitute(readFileSync(file, 'utf8'));
            expect(warnings.map((warning) => `${ warning.code }: ${ source.slice(warning.start, warning.end) }`)).toEqual([]);
        }
    );
});

// A scaffolded entry point installs the devtools panel behind a TOP-LEVEL await. That await is
// part of module evaluation, so a rejection aborts the module and the render/boot call after it
// never runs: the page comes up completely blank, and the only console error names the devtools
// module rather than the application - so the obvious reading, "devtools is broken", is wrong.
// Reproduced in a real browser against a failing import: #root had 0 children and the body was
// empty. A development-only diagnostic must never be able to stop the app from starting.
describe('a scaffolded entry point survives a failing devtools import', () =>
{
    const entryPoints = files.filter((file) => file.endsWith('main.azeroth'));

    it('finds the entry points to check (a silent empty set would defeat the guard)', () =>
    {
        expect(entryPoints.length).toBeGreaterThan(0);
    });

    for (const file of entryPoints)
    {
        const name = relative(PACKAGE_ROOT, file);

        it(`guards the top-level dynamic import in ${ name }`, () =>
        {
            const text = readFileSync(file, 'utf8');
            const awaitAt = text.indexOf('await import(');
            if (awaitAt === -1)
            {
                return;
            }

            // Positional, not merely "the file mentions try somewhere": the guard has to bracket
            // the await itself.
            const tryAt = text.lastIndexOf('try', awaitAt);
            const catchAt = text.indexOf('catch', awaitAt);
            expect(tryAt, `${ name }: the top-level await import( is not inside a try block`).toBeGreaterThan(-1);
            expect(catchAt, `${ name }: the top-level await import( has no catch after it`).toBeGreaterThan(awaitAt);
        });
    }
});
