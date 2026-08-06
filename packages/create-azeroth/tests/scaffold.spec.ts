// @vitest-environment node
//
// The scaffold engine, closed-loop: every template scaffolds into a temp dir with the
// substitutions applied and the _gitignore rename done - and the result is then fed to
// the CLI's OWN shape detection, which must classify each template as the shape it
// claims to be. The scaffolder and the detector can never drift apart unnoticed.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold, isEmptyTarget, resolveProjectTarget, TEMPLATES } from '../src/scaffold.ts';
import { detectProject } from '../../cli/src/detect.ts';
import { npmCli } from '../../cli/src/upgrade.ts';

const TEMPLATES_ROOT = fileURLToPath(new URL('../templates', import.meta.url));

const roots: string[] = [];
function target(): string
{
    const dir = join(mkdtempSync(join(tmpdir(), 'create-azeroth-')), 'app');
    roots.push(dir);
    return dir;
}
afterEach(() =>
{
    while (roots.length > 0)
    {
        rmSync(roots.pop() ?? '', { recursive: true, force: true });
    }
});

describe('the copy engine', () =>
{
    it('substitutes {{name}} and {{version}} and restores underscore-aliased names', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'my-app', '^1.2.3');
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
        expect(pkg.name).toBe('my-app');
        expect(pkg.dependencies['azerothjs']).toBe('^1.2.3');
        expect(existsSync(join(dir, '.gitignore'))).toBe(true);
        expect(existsSync(join(dir, '_gitignore'))).toBe(false);
        expect(existsSync(join(dir, 'eslint.config.ts'))).toBe(true);
        expect(existsSync(join(dir, '_eslint.config.ts'))).toBe(false);
        expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('<title>my-app</title>');
    });

    it('binary assets survive byte-for-byte - no UTF-8 round trip', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'binary-safe', '^1.0.0');
        for (const asset of ['favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png'])
        {
            const source = readFileSync(join(TEMPLATES_ROOT, 'frontend/public', asset));
            const copied = readFileSync(join(dir, 'public', asset));
            expect(copied.equals(source), asset).toBe(true);
        }
    });

    it('refuses a non-empty target - scaffolding never overwrites', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'backend', dir, 'x', '^1.0.0');
        expect(() => scaffold(TEMPLATES_ROOT, 'backend', dir, 'x', '^1.0.0')).toThrow(/never overwrites/);
        writeFileSync(join(dir, 'extra.txt'), '');
        expect(isEmptyTarget(dir)).toBe(false);
    });
});

// The name doubles as the target DIRECTORY, so the old character-class check (which allowed
// both `.` and `/`) let a name resolve anywhere: `../escaped` and `a/../../b` scaffolded
// outside the working directory, and `/name` landed at the drive root on Windows.
describe('the project name is one path segment inside the cwd', () =>
{
    const cwd = join(tmpdir(), 'create-azeroth-cwd');

    it('refuses every name that resolves outside the working directory', () =>
    {
        for (const name of ['.', '..', '../escaped', 'a/../../b-marker', '/az-root-marker', '//server/share', 'a/b', '\\\\server\\share', 'C:/anywhere', 'x/..'])
        {
            expect(resolveProjectTarget(cwd, name), name).toBeNull();
        }
    });

    it('accepts npm\'s own package-name shape, scaffolding under the cwd', () =>
    {
        expect(resolveProjectTarget(cwd, 'my-app')).toBe(join(cwd, 'my-app'));
        expect(resolveProjectTarget(cwd, 'app.v2_final~1')).toBe(join(cwd, 'app.v2_final~1'));
        expect(resolveProjectTarget(cwd, '@acme/web')).toBe(join(cwd, '@acme', 'web'));
    });

    it('refuses names npm itself would refuse', () =>
    {
        for (const name of ['', 'MyApp', '.hidden', '_leading', 'has space', 'ünïcode'])
        {
            expect(resolveProjectTarget(cwd, name), name).toBeNull();
        }
    });
});

describe('options: overlays compose over the base', () =>
{
    /** Every file under `dir`, relative, with its content - for placeholder/alias sweeps. */
    function walk(dir: string, prefix = ''): Array<{ path: string; text: string }>
    {
        return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory()
                ? walk(join(dir, entry.name), `${ prefix }${ entry.name }/`)
                : [{ path: `${ prefix }${ entry.name }`, text: readFileSync(join(dir, entry.name), 'utf8') }]);
    }

    it('frontend --router: table + pages + shell, zero new dependencies', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'routed', '^1.0.0', ['router']);
        expect(existsSync(join(dir, 'src/routes.ts'))).toBe(true);
        expect(existsSync(join(dir, 'src/pages/home.azeroth'))).toBe(true);
        expect(existsSync(join(dir, 'src/pages/about.azeroth'))).toBe(true);
        expect(readFileSync(join(dir, 'src/App.azeroth'), 'utf8')).toContain('RouterProvider');
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
        expect(pkg.devDependencies['tailwindcss']).toBeUndefined();
        expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('Router (applied)');
        expect(detectProject(dir).kind).toBe('frontend');
    });

    it('frontend --tailwind: plugin wired, deps merged sorted, tokens exposed', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'styled', '^1.0.0', ['tailwind']);
        expect(readFileSync(join(dir, 'src/styles.css'), 'utf8')).toContain("@import 'tailwindcss'");
        expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain('tailwindcss()');
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
        expect(pkg.devDependencies['tailwindcss']).toBe('^4.0.0');
        expect(pkg.devDependencies['@tailwindcss/vite']).toBe('^4.0.0');
        expect(Object.keys(pkg.devDependencies)).toEqual([...Object.keys(pkg.devDependencies)].sort((a, b) => a.localeCompare(b)));
        expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('Tailwind CSS (applied)');
        expect(detectProject(dir).kind).toBe('frontend');
    });

    it('frontend --router --tailwind: the combined overlay wins the shared files', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'both', '^1.0.0', ['router', 'tailwind']);
        const app = readFileSync(join(dir, 'src/App.azeroth'), 'utf8');
        expect(app).toContain('RouterProvider');
        expect(app).toContain('animate-rise');
        expect(readFileSync(join(dir, 'src/pages/home.azeroth'), 'utf8')).toContain('bg-panel');
        expect(readFileSync(join(dir, 'src/styles.css'), 'utf8')).toContain("@import 'tailwindcss'");
        const readme = readFileSync(join(dir, 'README.md'), 'utf8');
        expect(readme).toContain('Router (applied)');
        expect(readme).toContain('Tailwind CSS (applied)');
        expect(detectProject(dir).kind).toBe('frontend');
    });

    it('fullstack --tailwind: the application half is styled, the SSR seam intact', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'fullstack', dir, 'full-styled', '^1.0.0', ['tailwind']);
        expect(readFileSync(join(dir, 'application/src/styles.css'), 'utf8')).toContain("@import 'tailwindcss'");
        expect(readFileSync(join(dir, 'application/src/App.azeroth'), 'utf8')).toContain('handoff');
        expect(readFileSync(join(dir, 'application/vite.config.ts'), 'utf8')).toContain("'/api': 'http://localhost:3000'");
        const pkg = JSON.parse(readFileSync(join(dir, 'application/package.json'), 'utf8')) as { devDependencies: Record<string, string> };
        expect(pkg.devDependencies['@tailwindcss/vite']).toBe('^4.0.0');
        expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('Tailwind CSS (applied)');
        expect(detectProject(dir).kind).toBe('fullstack');
    });

    it('an option outside its shape is refused', () =>
    {
        expect(() => scaffold(TEMPLATES_ROOT, 'backend', target(), 'x', '^1.0.0', ['router']))
            .toThrow(/--router is not an option/);
        expect(() => scaffold(TEMPLATES_ROOT, 'backend', target(), 'x', '^1.0.0', ['tailwind']))
            .toThrow(/--tailwind is not an option/);
    });

    it('no combination leaks a placeholder, a manifest file, or an underscore alias', () =>
    {
        const combos: Array<['frontend' | 'fullstack', Array<'router' | 'tailwind'>]> =
            [['frontend', ['router']], ['frontend', ['tailwind']], ['frontend', ['router', 'tailwind']], ['fullstack', ['tailwind']]];
        for (const [template, options] of combos)
        {
            const dir = target();
            scaffold(TEMPLATES_ROOT, template, dir, 'swept', '^1.0.0', options);
            for (const file of walk(dir))
            {
                expect(file.text, file.path).not.toContain('{{name}}');
                expect(file.text, file.path).not.toContain('{{version}}');
                expect(file.path).not.toMatch(/(^|\/)_/);
            }
        }
    });

    it('no scaffolded file climbs more than one directory, except the one cross-half seam', () =>
    {
        // Path depth is a design constraint, not taste. A page that reaches
        // `../../../server/src/contract.ts` breaks the moment it moves, and an alias cannot
        // rescue it: the zero-build server halves run under plain `node`, which does not read
        // tsconfig `paths` at all, and the compiler's build-time gate for `.azeroth` files uses
        // fixed options with no `paths` either - so an aliased import there resolves to
        // nothing and silently types as `any`. One seam owns the crossing instead.
        const combos: Array<['frontend' | 'fullstack' | 'backend', Array<'router' | 'tailwind'>]> =
            [['backend', []], ['frontend', []], ['frontend', ['router']], ['frontend', ['tailwind']],
                ['frontend', ['router', 'tailwind']], ['fullstack', []], ['fullstack', ['tailwind']]];
        for (const [template, options] of combos)
        {
            const dir = target();
            scaffold(TEMPLATES_ROOT, template, dir, 'depth', '^1.0.0', options);
            for (const file of walk(dir))
            {
                if (!/\.(ts|azeroth)$/.test(file.path))
                {
                    continue;
                }
                for (const [, prefix] of file.text.matchAll(/from '((?:\.\.\/)+)[^']*'/g))
                {
                    const depth = (prefix as string).length / 3;
                    const where = `${ template }${ options.length > 0 ? `+${ options.join('+') }` : '' } ${ file.path }`;
                    expect(depth, `${ where } climbs ${ depth } levels`).toBeLessThanOrEqual(2);
                    if (depth === 2)
                    {
                        // The application's single seam to the server's contract, and only it.
                        expect(file.path.replaceAll('\\', '/'), where).toMatch(/src\/api\.ts$/);
                    }
                }
            }
        }
    });

    it('an overlay vite config keeps what the base one declared', () =>
    {
        // A tailwind overlay REPLACES vite.config.ts wholesale rather than merging, so
        // anything the base config declares has to be restated there. The dev port is the
        // canary: the README names it and the fullstack devtools bridge is written against
        // it, so an overlay that dropped it would move the app out from under both.
        const combos: Array<[template: 'frontend' | 'fullstack', options: Array<'router' | 'tailwind'>, config: string]> = [
            ['frontend', [], 'vite.config.ts'],
            ['frontend', ['tailwind'], 'vite.config.ts'],
            ['frontend', ['router', 'tailwind'], 'vite.config.ts'],
            ['fullstack', [], 'application/vite.config.ts'],
            ['fullstack', ['tailwind'], 'application/vite.config.ts']
        ];
        for (const [template, options, config] of combos)
        {
            const dir = target();
            scaffold(TEMPLATES_ROOT, template, dir, 'ports', '^1.0.0', options);
            const text = readFileSync(join(dir, config), 'utf8');
            expect(text, `${ template } ${ options.join('+') || '(base)' }`).toContain('port: 5173');
            if (template === 'fullstack')
            {
                expect(text, `${ template } ${ options.join('+') || '(base)' }`).toContain("'/api': 'http://localhost:3000'");
            }
        }
    });
});

describe('closed loop: each template detects as the shape it claims', () =>
{
    it('frontend scaffolds to a frontend', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'front', '^1.0.0');
        expect(detectProject(dir).kind).toBe('frontend');
    });

    it('backend scaffolds to a NATIVE backend (the no-build-step doctrine survives scaffolding)', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'backend', dir, 'back', '^1.0.0');
        const project = detectProject(dir);
        expect(project).toMatchObject({ kind: 'backend', build: 'native', entry: 'src/main.ts' });
    });

    it('fullstack scaffolds to a fullstack root with the conventional halves', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'fullstack', dir, 'full', '^1.0.0');
        const project = detectProject(dir);
        expect(project.kind).toBe('fullstack');
        if (project.kind === 'fullstack')
        {
            expect(project.app.dir).toBe(join(dir, 'application'));
            expect(project.server.dir).toBe(join(dir, 'server'));
            expect(project.server.build).toBe('native');
        }
    });

    it('every template ships an azeroth dev script at its root', () =>
    {
        for (const template of TEMPLATES)
        {
            const dir = target();
            scaffold(TEMPLATES_ROOT, template, dir, 'scripts-check', '^1.0.0');
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
            expect(pkg.scripts['dev'], template).toBe('azeroth dev');
        }
    });
});

describe('production shape: the hour-three files are already waiting', () =>
{
    it('backend ships env, tests, Docker, and its own README', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'backend', dir, 'prod', '^1.0.0');
        for (const file of ['src/app.ts', 'src/main.ts', 'tests/app.spec.ts', 'Dockerfile', '.dockerignore', '.env.example', 'README.md'])
        {
            expect(existsSync(join(dir, file)), file).toBe(true);
        }
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string>; engines: Record<string, string> };
        expect(pkg.scripts['test']).toBe('azeroth test');
        // The shape that runs TypeScript with no build step needs the Node that strips
        // types unflagged - the same one its Dockerfile and CI pin.
        expect(pkg.engines['node']).toBe('>=24');
    });

    it('frontend ships a component test, a favicon slot, and its own README', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'prod', '^1.0.0');
        for (const file of ['tests/app.spec.ts', 'public/favicon-32.png', 'README.md', 'vite.config.ts'])
        {
            expect(existsSync(join(dir, file)), file).toBe(true);
        }
    });

    it('fullstack ships CI, the one-origin deploy story, and both suites', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'fullstack', dir, 'prod', '^1.0.0');
        for (const file of ['.github/workflows/ci.yml', 'README.md', 'server/Dockerfile', 'server/.env.example', 'server/tests/app.spec.ts', 'application/tests/app.spec.ts', 'application/public/favicon-32.png', 'application/src/routes.ts', 'application/src/entry.server.ts'])
        {
            expect(existsSync(join(dir, file)), file).toBe(true);
        }
        expect(readFileSync(join(dir, 'server/src/app.ts'), 'utf8')).toContain('mountPages');
    });

    it('the fullstack halves agree on the API path the demo calls (no first-click 404)', () =>
    {
        // The app's very first cross-half interaction must hit a route the server
        // actually defines - a drifted path ships a 404 as the newcomer's first
        // impression (the /api/health vs /api/healthz regression this guards).
        const sources = ['App.azeroth', 'pages/home.azeroth', 'pages/guest-book.azeroth']
            .map((f) => readFileSync(join(TEMPLATES_ROOT, 'fullstack/application/src', f), 'utf8'))
            .join('\n');
        const server = readFileSync(join(TEMPLATES_ROOT, 'fullstack/server/src/app.ts'), 'utf8');
        const fetched = [...sources.matchAll(/fetch\('(\/api\/[^']+)'/g)].map((m) => m[1]);
        expect(fetched.length).toBeGreaterThan(0);
        for (const path of fetched)
        {
            expect(server, `server must define ${ path }`).toContain(`'${ path }'`);
        }
    });

    it('the fullstack Dockerfile installs from the root workspace context (npm ci needs the root lockfile)', () =>
    {
        // A workspace member has no package-lock.json of its own, so any stage that
        // copies only server/package*.json and runs `npm ci` can never succeed. Every
        // `npm ci` in the Dockerfile must copy the ROOT manifests first.
        const dockerfile = readFileSync(join(TEMPLATES_ROOT, 'fullstack/server/Dockerfile'), 'utf8');
        expect(dockerfile).not.toMatch(/COPY server\/package\*\.json \.\/\s*\nRUN npm ci/);
        const stages = dockerfile.split(/^FROM /m).filter((s) => s.includes('npm ci'));
        expect(stages.length).toBeGreaterThan(0);
        for (const stage of stages)
        {
            expect(stage, 'each npm ci stage copies the root manifests + lockfile').toContain('COPY package*.json ./');
        }
    });

    it('npm pack ships every template file - dotfiles and dot-directories included', { timeout: 30000 }, () =>
    {
        // npm's human listing goes to stderr; --json puts the file list on stdout. An isolated cache and
        // the notifiers off keep a busy parallel run from serializing behind a shared npm cache lock or
        // corrupting stdout with an update notice; the JSON is sliced from its first `[` for the same reason.
        const cache = mkdtempSync(join(tmpdir(), 'create-azeroth-npm-cache-'));
        roots.push(cache);
        // npm is reached through its entry SCRIPT, never `npm.cmd` and never a shell: spawning a
        // `.cmd` needs `shell: true`, which concatenates the argument array without quoting
        // (DEP0190) - the same hazard `azeroth doctor` reports, and it has no business being in
        // this repo's own suite.
        const packageRoot = join(TEMPLATES_ROOT, '..');
        const cli = npmCli(packageRoot);
        if (cli === null)
        {
            throw new Error('npm could not be resolved, so the packed file list cannot be checked');
        }
        const raw = execFileSync(process.execPath, [cli, 'pack', '--dry-run', '--json'], {
            cwd: packageRoot,
            encoding: 'utf8',
            env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }
        });
        const jsonStart = raw.indexOf('[');
        const [report] = (jsonStart >= 0 ? JSON.parse(raw.slice(jsonStart)) : []) as Array<{ files: Array<{ path: string }> }>;
        const shipped = new Set((report?.files ?? []).map((file) => file.path.replaceAll('\\', '/')));
        // .editorconfig ships under its real name: unlike .gitignore (which npm would read as
        // nested pack-ignore rules, hence _gitignore), npm has no special handling for it.
        for (const mustShip of ['templates/fullstack/.github/workflows/ci.yml', 'templates/fullstack/.dockerignore', 'templates/backend/.dockerignore', 'templates/backend/.env.example', 'templates/backend/Dockerfile', 'templates/backend/.github/workflows/ci.yml', 'templates/frontend/.github/workflows/ci.yml', 'templates/frontend/public/favicon-32.png', 'overlays/frontend/router/src/routes.ts', 'overlays/fullstack/tailwind/application/_package.merge.json', 'templates/backend/.editorconfig', 'templates/frontend/.editorconfig', 'templates/fullstack/.editorconfig'])
        {
            expect(shipped.has(mustShip), mustShip).toBe(true);
        }
    });
});

/**
 * Packages a template needs INSTALLED but never names in a source file, so the
 * "is it used?" sweep below cannot see them. Each one earns its place here:
 * removing it breaks a command, not an import.
 */
const IMPLICIT_DEPENDENCIES: Record<string, string> =
{
    'jiti': 'ESLint loads eslint.config.ts through it - without it the flat config does not parse',
    '@azerothjs/language-server': 'ships the azeroth-tsc binary `azeroth check` runs on a frontend',
    '@azerothjs/cli': 'ships the `azeroth` binary every script in the template invokes',
    'typescript': 'the tsc binary `azeroth check` runs on a backend, and a peer of the compiler and typescript-eslint',
    '@types/node': 'reached through tsconfig "types": ["node"], which never spells the package name',
    '@azerothjs/ws': 'the optional peer @azerothjs/devtools/server needs for its bridge socket; the template imports the bridge, never the socket'
};

/**
 * Every file a template ships that could plausibly carry an import or a package name.
 * `skip` holds the workspace directories, so a fullstack root is judged on its own
 * files rather than on its halves'.
 */
function sourceFiles(dir: string, skip: readonly string[] = []): string[]
{
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        if (entry.name === 'node_modules' || skip.includes(entry.name))
        {
            continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory())
        {
            found.push(...sourceFiles(path));
        }
        else if (/\.(ts|mts|cts|js|mjs|cjs|azeroth|json|html|css|yml)$/.test(entry.name))
        {
            found.push(path);
        }
    }
    return found;
}

/** Bare package specifiers imported by a file - `@scope/name/sub` folded back to `@scope/name`. */
function importedPackages(text: string): Set<string>
{
    const names = new Set<string>();
    for (const match of text.matchAll(/(?:from|import)\s+'([^']+)'/g))
    {
        const specifier = match[1] ?? '';
        if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('node:'))
        {
            continue;
        }
        const parts = specifier.split('/');
        names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier));
    }
    return names;
}

/**
 * The manifests a scaffolded project ends up with, paired with the files they are
 * responsible for. A workspace root owns only its own - not its halves'.
 */
function manifestsOf(dir: string): Array<{ label: string; dir: string; files: string[] }>
{
    const root = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { workspaces?: string[] };
    const workspaces = root.workspaces ?? [];
    return [
        { label: 'root', dir, files: sourceFiles(dir, workspaces) },
        ...workspaces.map((workspace) => ({
            label: workspace,
            dir: join(dir, workspace),
            files: sourceFiles(join(dir, workspace))
        }))
    ];
}

describe('manifests: every import declared, every declaration used', () =>
{
    // The failure this catches: `application/src/api.ts` imported @azerothjs/http and
    // @azerothjs/schema while declaring neither, resolving only through workspace
    // hoisting. It worked until the app was extracted from the workspace.
    it('every package a template imports is declared in the manifest that owns it', () =>
    {
        for (const template of TEMPLATES)
        {
            const dir = target();
            scaffold(TEMPLATES_ROOT, template, dir, 'deps', '^1.0.0');

            for (const { label, dir: half, files } of manifestsOf(dir))
            {
                const pkg = JSON.parse(readFileSync(join(half, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
                const declared = new Set([...Object.keys(pkg['dependencies'] ?? {}), ...Object.keys(pkg['devDependencies'] ?? {})]);
                for (const file of files)
                {
                    for (const name of importedPackages(readFileSync(file, 'utf8')))
                    {
                        expect(declared.has(name), `${ template }/${ label } imports ${ name } in ${ file.slice(half.length + 1) } without declaring it`).toBe(true);
                    }
                }
            }
        }
    });

    it('every declared dependency is imported, or documented as an implicit one', () =>
    {
        for (const template of TEMPLATES)
        {
            const dir = target();
            scaffold(TEMPLATES_ROOT, template, dir, 'deps', '^1.0.0');

            for (const { label, dir: half, files } of manifestsOf(dir))
            {
                const pkg = JSON.parse(readFileSync(join(half, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
                // "Used" is wider than "imported": a package can be named by a tsconfig
                // plugin entry, a vitest `environment`, or a script, and that counts.
                const text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
                const imported = importedPackages(text);
                for (const name of [...Object.keys(pkg['dependencies'] ?? {}), ...Object.keys(pkg['devDependencies'] ?? {})])
                {
                    // Declared so npm does not have to auto-install it: a required peer of
                    // @azerothjs/http and @azerothjs/kit that a server half never imports.
                    if (name === 'azerothjs' && !imported.has(name))
                    {
                        continue;
                    }
                    expect(
                        imported.has(name) || text.includes(name) || name in IMPLICIT_DEPENDENCIES,
                        `${ template }/${ label } declares ${ name } but nothing uses it - delete it, or add it to IMPLICIT_DEPENDENCIES with the reason`
                    ).toBe(true);
                }
            }
        }
    });
});

describe('the devtools bridge secret outlives the process', () =>
{
    // A dev server restarts on every file save. A token minted at boot is a different
    // secret each time, so the panel - which remembers the URL it was given - is refused
    // from the first edit onward. The scaffold generates ONE per project instead.
    it('seeds a gitignored .env with a generated token, leaving the example empty', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'fullstack', dir, 'shop', '^2.0.0');

        const example = readFileSync(join(dir, 'server', '.env.example'), 'utf8');
        const local = readFileSync(join(dir, 'server', '.env'), 'utf8');

        // The committed example documents the key and carries no secret.
        expect(example).toContain('DEVTOOLS_TOKEN=');
        expect(/^DEVTOOLS_TOKEN=$/m.test(example)).toBe(true);

        // The local one carries a real, unguessable value.
        const token = (/^DEVTOOLS_TOKEN=(.+)$/m.exec(local) ?? [])[1] ?? '';
        expect(token.length).toBeGreaterThanOrEqual(16);
        expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.env');
    });

    it('gives two projects different secrets - never a shared constant', () =>
    {
        const a = target();
        const b = target();
        scaffold(TEMPLATES_ROOT, 'fullstack', a, 'a', '^2.0.0');
        scaffold(TEMPLATES_ROOT, 'fullstack', b, 'b', '^2.0.0');

        const read = (dir: string): string =>
            (/^DEVTOOLS_TOKEN=(.+)$/m.exec(readFileSync(join(dir, 'server', '.env'), 'utf8')) ?? [])[1] ?? '';
        expect(read(a)).not.toBe(read(b));
    });

    it('the server reads the token, never mints one', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'fullstack', dir, 'shop', '^2.0.0');
        const main = readFileSync(join(dir, 'server', 'src', 'main.ts'), 'utf8');

        expect(main).toContain('process.env.DEVTOOLS_TOKEN');
        // The per-boot form is the defect: it cannot survive a restart.
        expect(main).not.toContain('crypto.randomUUID()');
    });
});
