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
