// @vitest-environment node
//
// The scaffold engine, closed-loop: every template scaffolds into a temp dir with the
// substitutions applied and the _gitignore rename done - and the result is then fed to
// the CLI's OWN shape detection, which must classify each template as the shape it
// claims to be. The scaffolder and the detector can never drift apart unnoticed.

import { describe, it, expect, afterEach } from 'vitest';
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
    it('substitutes {{name}} and {{version}} and renames _gitignore', () =>
    {
        const dir = target();
        scaffold(TEMPLATES_ROOT, 'frontend', dir, 'my-app', '^1.2.3');
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
        expect(pkg.name).toBe('my-app');
        expect(pkg.dependencies['azerothjs']).toBe('^1.2.3');
        expect(existsSync(join(dir, '.gitignore'))).toBe(true);
        expect(existsSync(join(dir, '_gitignore'))).toBe(false);
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
