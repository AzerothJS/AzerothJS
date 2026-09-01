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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every template that boots a long-lived server process. */
const SERVER_TEMPLATES: ReadonlyArray<{ name: string; main: string; env: string; root: string }> = [
    { name: 'backend', main: 'templates/backend/src/main.ts', env: 'templates/backend/.env.example', root: 'templates/backend' },
    { name: 'fullstack', main: 'templates/fullstack/server/src/main.ts', env: 'templates/fullstack/server/.env.example', root: 'templates/fullstack/server' }
];

describe.each(SERVER_TEMPLATES)('$name template environment defaults', ({ main, env, root }) =>
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

    // The other half of the same rule, and the half nothing checked: the app's own config is
    // not the framework's. The runtime reads NODE_ENV while modules EVALUATE, before
    // process.loadEnvFile() has run, so a deploy that leaves it unset ran the framework in DEV
    // - dev warnings, dev checks, dev cost paths - while the app reported production. `.env`
    // cannot reach it at all; only the process environment can.
    it('the start script declares production to the RUNTIME, not just to the app', () =>
    {
        const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        expect(manifest.scripts?.start).toContain('--import');
        expect(manifest.scripts?.start).toContain('deploy-env');
    });

    it('the launcher sets NODE_ENV when it is unset and leaves an explicit value alone', () =>
    {
        const launcher = join(PACKAGE_ROOT, root, 'src', 'deploy-env.ts');
        expect(existsSync(launcher)).toBe(true);
        const read = (nodeEnv: string | undefined): string =>
            // A file:// URL, because an absolute Windows path is not a legal ESM specifier. The
            // template's own script passes the relative './src/deploy-env.ts', which is.
            execFileSync(process.execPath, ['--import', pathToFileURL(launcher).href, '-e', 'process.stdout.write(String(process.env.NODE_ENV))'],
                {
                    encoding: 'utf8',
                    env: nodeEnv === undefined
                        ? Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_ENV'))
                        : { ...process.env, NODE_ENV: nodeEnv }
                });

        expect(read(undefined)).toBe('production');
        // `azeroth dev`, a Dockerfile and a process manager all keep the mode they declared.
        expect(read('development')).toBe('development');
    });
});
