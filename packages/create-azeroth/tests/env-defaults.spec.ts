// @vitest-environment node
//
// A server template that defaults NODE_ENV to 'development' hands `dev: true` to every deploy
// that forgot the variable, and `dev: true` is what puts thrown-error messages and stack traces
// on the wire (see errorResponse's `dev` option). The fullstack template was corrected for
// exactly this reason in an earlier release; the backend template kept the unsafe default and
// its .env.example actively pinned NODE_ENV=development, so a scaffolded API server ran in dev
// mode in production. No gate noticed, because nothing scaffolds and boots a template.
//
// The rule: a template may name development anywhere it likes, but it must never DEFAULT to it,
// and its .env.example must not pin it.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every template that boots a long-lived server process. */
const SERVER_TEMPLATES: ReadonlyArray<{ name: string; main: string; env: string }> = [
    { name: 'backend', main: 'templates/backend/src/main.ts', env: 'templates/backend/.env.example' },
    { name: 'fullstack', main: 'templates/fullstack/server/src/main.ts', env: 'templates/fullstack/server/.env.example' }
];

describe.each(SERVER_TEMPLATES)('$name template environment defaults', ({ main, env }) =>
{
    it('defaults NODE_ENV to production, never development', () =>
    {
        const source = readFileSync(join(PACKAGE_ROOT, main), 'utf8');
        const declaration = /oneOf\('NODE_ENV'[^)]*\{\s*default:\s*'([a-z]+)'\s*\}/.exec(source);
        expect(declaration?.[1]).toBe('production');
    });

    it('does not pin NODE_ENV=development in .env.example (a commented line is fine)', () =>
    {
        const file = join(PACKAGE_ROOT, env);
        if (!existsSync(file))
        {
            return;
        }
        const active = readFileSync(file, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('NODE_ENV='));
        expect(active).toEqual([]);
    });
});
