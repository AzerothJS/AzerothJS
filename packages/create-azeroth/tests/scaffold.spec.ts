// @vitest-environment node
//
// The scaffold engine, closed-loop: every template scaffolds into a temp dir with the
// substitutions applied and the _gitignore rename done - and the result is then fed to
// the CLI's OWN shape detection, which must classify each template as the shape it
// claims to be. The scaffolder and the detector can never drift apart unnoticed.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold, isEmptyTarget, TEMPLATES } from '../src/scaffold.ts';
import { detectProject } from '../../cli/src/detect.ts';

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
        expect(existsSync(join(dir, 'eslint.config.js'))).toBe(true);
        expect(existsSync(join(dir, '_eslint.config.js'))).toBe(false);
        expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('<title>my-app</title>');
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
        for (const file of ['src/config.ts', 'src/app.ts', 'src/main.ts', 'tests/app.spec.ts', 'Dockerfile', '.dockerignore', '.env.example', 'README.md'])
        {
            expect(existsSync(join(dir, file)), file).toBe(true);
        }
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string>; engines: Record<string, string> };
        expect(pkg.scripts['test']).toBe('vitest run');
        expect(pkg.engines['node']).toBe('>=24');
    });

    it('frontend ships a component test, a favicon slot, and its own README', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'prod', '^1.0.0');
        for (const file of ['tests/app.spec.ts', 'public/favicon.svg', 'README.md', 'vite.config.ts'])
        {
            expect(existsSync(join(dir, file)), file).toBe(true);
        }
    });

    it('fullstack ships CI, the one-origin deploy story, and both suites', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'fullstack', dir, 'prod', '^1.0.0');
        for (const file of ['.github/workflows/ci.yml', 'README.md', 'server/Dockerfile', 'server/.env.example', 'server/tests/app.spec.ts', 'application/tests/app.spec.ts', 'application/public/favicon.svg'])
        {
            expect(existsSync(join(dir, file)), file).toBe(true);
        }
        expect(readFileSync(join(dir, 'server/src/app.ts'), 'utf8')).toContain('staticFiles');
    });

    it('npm pack ships every template file - dotfiles and dot-directories included', () =>
    {
        // npm's human listing goes to stderr; --json puts the file list on stdout.
        const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
            cwd: join(TEMPLATES_ROOT, '..'),
            encoding: 'utf8',
            shell: process.platform === 'win32'
        });
        const [report] = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
        const shipped = new Set(report?.files.map((file) => file.path.replaceAll('\\', '/')));
        for (const mustShip of ['templates/fullstack/.github/workflows/ci.yml', 'templates/backend/.dockerignore', 'templates/backend/.env.example', 'templates/backend/Dockerfile', 'templates/frontend/public/favicon.svg'])
        {
            expect(shipped.has(mustShip), mustShip).toBe(true);
        }
    });
});
