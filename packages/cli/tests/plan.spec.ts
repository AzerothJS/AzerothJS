// @vitest-environment node
//
// Command planning: the exact child invocations each shape produces, tool resolution by
// walking up to the project's own node_modules, and the transparency contract - a plan
// IS what runs, so these assertions pin what `--print` shows the user.

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { detectProject, type BackendProject, type FrontendProject, type FullstackProject } from '../src/detect.ts';
import { planDev, planCheck, planBuild, resolveTool, formatStep, PlanError } from '../src/plan.ts';
import { makeRoot, write, cleanup, packageJson } from './fixtures.ts';

const roots: string[] = [];
function root(): string
{
    const dir = makeRoot();
    roots.push(dir);
    return dir;
}
afterEach(() =>
{
    while (roots.length > 0)
    {
        cleanup(roots.pop() ?? '');
    }
});

function installTools(dir: string): void
{
    write(dir, 'node_modules/vite/bin/vite.js', '');
    write(dir, 'node_modules/typescript/bin/tsc', '');
    write(dir, 'node_modules/eslint/bin/eslint.js', '');
    write(dir, 'node_modules/@azerothjs/language-server/dist/tsc-cli.js', '');
}

function frontend(dir: string, rel = '.'): FrontendProject
{
    write(dir, join(rel, 'package.json'), packageJson({ azerothjs: '^0.9.0' }));
    write(dir, join(rel, 'vite.config.ts'), 'export default {}');
    const project = detectProject(join(dir, rel));
    if (project.kind !== 'frontend')
    {
        throw new Error(`fixture is ${ project.kind }`);
    }
    return project;
}

function nativeBackend(dir: string, rel = '.'): BackendProject
{
    write(dir, join(rel, 'package.json'), packageJson({ '@azerothjs/http': '^0.9.0' }));
    write(dir, join(rel, 'src/main.ts'), '');
    const project = detectProject(join(dir, rel));
    if (project.kind !== 'backend')
    {
        throw new Error(`fixture is ${ project.kind }`);
    }
    return project;
}

function builtBackend(dir: string, rel = '.'): BackendProject
{
    write(dir, join(rel, 'package.json'), packageJson({ '@azerothjs/http': '^0.9.0', typeorm: '^0.3.0' }));
    write(dir, join(rel, 'src/main.ts'), '');
    write(dir, join(rel, 'tsconfig.json'), '{ "compilerOptions": { "outDir": "dist" } }');
    const project = detectProject(join(dir, rel));
    if (project.kind !== 'backend')
    {
        throw new Error(`fixture is ${ project.kind }`);
    }
    return project;
}

describe('resolveTool', () =>
{
    it('walks up from a nested directory to the root node_modules', () =>
    {
        const dir = root();
        installTools(dir);
        write(dir, 'app/deep/file.txt', '');
        const found = resolveTool(join(dir, 'app', 'deep'), 'vite/bin/vite.js');
        expect(found).toBe(join(dir, 'node_modules', 'vite', 'bin', 'vite.js'));
    });

    it('returns null when the tool is nowhere on the path to the root', () =>
    {
        const dir = root();
        expect(resolveTool(dir, 'vite/bin/vite.js')).toBeNull();
    });
});

describe('planDev', () =>
{
    it('frontend: one long-running vite child in the project dir', () =>
    {
        const dir = root();
        installTools(dir);
        const plan = planDev(frontend(dir));
        expect(plan.steps).toHaveLength(1);
        expect(plan.steps[0]).toMatchObject({ label: 'web', longRunning: true, args: [] });
        expect(plan.steps[0]?.script).toContain('vite');
    });

    it('a missing vite is a PlanError naming the lookup, not a crash downstream', () =>
    {
        const dir = root();
        expect(() => planDev(frontend(dir))).toThrow(PlanError);
    });

    it('native backend: node --watch on the source entry, no script, no build', () =>
    {
        const dir = root();
        const plan = planDev(nativeBackend(dir));
        expect(plan.steps).toHaveLength(1);
        expect(plan.steps[0]).toMatchObject({ script: null, args: ['--watch', '--watch-preserve-output', 'src/main.ts'] });
    });

    it('built backend: tsc -w first, then node --watch gated on the first emit', () =>
    {
        const dir = root();
        installTools(dir);
        const plan = planDev(builtBackend(dir));
        expect(plan.steps).toHaveLength(2);
        expect(plan.steps[0]?.args).toEqual(['-w', '--pretty', '--preserveWatchOutput', '-p', 'tsconfig.json']);
        expect(plan.steps[1]).toMatchObject({
            script: null,
            args: ['--watch', '--watch-preserve-output', 'dist/main.js'],
            waitForFile: join(dir, 'dist', 'main.js')
        });
    });

    it('fullstack: server steps first, web last - one conductor, ordered', () =>
    {
        const dir = root();
        installTools(dir);
        const app = frontend(dir, 'application');
        const server = builtBackend(dir, 'server');
        const project: FullstackProject = { kind: 'fullstack', dir, app, server };
        const labels = planDev(project).steps.map((step) => step.label);
        expect(labels).toEqual(['api build', 'api', 'web']);
    });
});

describe('planCheck', () =>
{
    it('frontend with azeroth-tsc and an eslint config runs both gates', () =>
    {
        const dir = root();
        installTools(dir);
        write(dir, 'eslint.config.js', 'export default []');
        const plan = planCheck(frontend(dir));
        expect(plan.steps.map((step) => step.label)).toEqual(['web typecheck', 'web lint']);
        expect(plan.steps[0]?.script).toContain('tsc-cli');
    });

    it('a missing azeroth-tsc is an honest note, never a silent skip', () =>
    {
        const dir = root();
        const plan = planCheck(frontend(dir));
        expect(plan.steps).toHaveLength(0);
        expect(plan.notes.join(' ')).toContain('azeroth-tsc');
    });

    it('backend typecheck is tsc --noEmit, not azeroth-tsc', () =>
    {
        const dir = root();
        installTools(dir);
        const plan = planCheck(nativeBackend(dir));
        expect(plan.steps[0]?.args).toEqual(['--noEmit', '-p', 'tsconfig.json']);
    });

    it('fullstack checks the server half first', () =>
    {
        const dir = root();
        installTools(dir);
        const project: FullstackProject = { kind: 'fullstack', dir, app: frontend(dir, 'application'), server: nativeBackend(dir, 'server') };
        const labels = planCheck(project).steps.map((step) => step.label);
        expect(labels[0]).toBe('api typecheck');
        expect(labels[labels.length - 1]).toContain('web');
    });
});

describe('planBuild', () =>
{
    it('a native backend has NO build - the note says why', () =>
    {
        const dir = root();
        const plan = planBuild(nativeBackend(dir));
        expect(plan.steps).toHaveLength(0);
        expect(plan.notes.join(' ')).toContain('no build step');
    });

    it('a built backend is tsc -p tsconfig.json', () =>
    {
        const dir = root();
        installTools(dir);
        const plan = planBuild(builtBackend(dir));
        expect(plan.steps).toHaveLength(1);
        expect(plan.steps[0]?.args).toEqual(['-p', 'tsconfig.json']);
    });

    it('fullstack builds the server before the client', () =>
    {
        const dir = root();
        installTools(dir);
        const project: FullstackProject = { kind: 'fullstack', dir, app: frontend(dir, 'application'), server: builtBackend(dir, 'server') };
        const labels = planBuild(project).steps.map((step) => step.label);
        expect(labels).toEqual(['api', 'web']);
    });
});

describe('formatStep - what --print shows', () =>
{
    it('is a copy-pasteable cd && node line, with the wait gate spelled out', () =>
    {
        const dir = root();
        installTools(dir);
        const plan = planDev(builtBackend(dir));
        const nodeStep = plan.steps[1];
        expect(nodeStep).toBeDefined();
        if (nodeStep !== undefined)
        {
            const line = formatStep(nodeStep);
            expect(line).toContain(`cd ${ dir }`);
            expect(line).toContain('node --watch --watch-preserve-output dist/main.js');
            expect(line).toContain('starts after');
        }
    });
});
