// @vitest-environment node
//
// Command planning: the exact child invocations each shape produces, tool resolution by
// walking up to the project's own node_modules, and the transparency contract - a plan
// IS what runs, so these assertions pin what `--print` shows the user.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { SSR_SOURCE_ENTRY } from '@azerothjs/kit/dev/entry';
import { detectProject, type BackendProject, type FrontendProject, type FullstackProject } from '../src/detect.ts';
import { planDev, planCheck, planBuild, resolveTool, formatStep, PlanError, KIT_SSR_ENTRY, type Plan } from '../src/plan.ts';
import { runDev } from '../src/run.ts';
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

/**
 * A real fullstack root, detected the way the CLI detects one - so the capability field
 * comes from the manifest on disk rather than from a hand-written literal.
 */
function fullstackRoot(dir: string, manifest: Record<string, unknown>): FullstackProject
{
    write(dir, 'package.json', packageJson({}, manifest));
    frontend(dir, 'application');
    nativeBackend(dir, 'server');
    const project = detectProject(dir);
    if (project.kind !== 'fullstack')
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
        const project: FullstackProject = { kind: 'fullstack', dir, app, server, azeroth: 'absent' };
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
        expect(plan.notes.map((note) => note.text).join(' ')).toContain('azeroth-tsc');
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
        const project: FullstackProject = { kind: 'fullstack', dir, app: frontend(dir, 'application'), server: nativeBackend(dir, 'server'), azeroth: 'absent' };
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
        expect(plan.notes.map((note) => note.text).join(' ')).toContain('no build step');
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
        const project: FullstackProject = { kind: 'fullstack', dir, app: frontend(dir, 'application'), server: builtBackend(dir, 'server'), azeroth: 'absent' };
        const labels = planBuild(project).steps.map((step) => step.label);
        expect(labels).toEqual(['api', 'web']);
    });

    it('a kit app (src/entry.server.ts + @azerothjs/kit) builds client, SSR bundle, then prerenders', () =>
    {
        const dir = root();
        installTools(dir);
        write(dir, 'node_modules/@azerothjs/kit/dist/prerender-cli.js', '');
        write(dir, 'src/entry.server.ts', '');
        const plan = planBuild(frontend(dir));
        expect(plan.steps.map((step) => step.label)).toEqual(['web', 'web ssr', 'web prerender']);
        expect(plan.steps[1]?.args).toEqual(['build', '--ssr', 'src/entry.server.ts', '--outDir', 'dist-server']);
        expect(plan.steps[2]?.script).toContain('prerender-cli');
    });

    it('an SSR entry WITHOUT the kit installed is an honest note, never a silent skip', () =>
    {
        const dir = root();
        installTools(dir);
        write(dir, 'src/entry.server.ts', '');
        const plan = planBuild(frontend(dir));
        expect(plan.steps.map((step) => step.label)).toEqual(['web']);
        expect(plan.notes.map((note) => note.text).join(' ')).toContain('@azerothjs/kit');
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

describe('the one-process dev capability', () =>
{
    it('a root declaring "azeroth": { "dev": "server" } plans ONE step and warns that the web step is dropped', () =>
    {
        const dir = root();
        installTools(dir);
        const project = fullstackRoot(dir, { azeroth: { dev: 'server' } });
        expect(project.azeroth).toBe('server');
        const plan = planDev(project);
        expect(plan.steps.map((step) => step.label)).toEqual(['api']);
        const warnings = plan.notes.filter((note) => note.level === 'warn');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.text).toContain('the server half serves the pages');
    });

    it('vite merely in the dependencies is not a declaration - both steps stay', () =>
    {
        const dir = root();
        installTools(dir);
        const project = fullstackRoot(dir, { dependencies: { vite: '^8.1.5' } });
        expect(project.azeroth).toBe('absent');
        expect(planDev(project).steps.map((step) => step.label)).toEqual(['api', 'web']);
        expect(planDev(project).notes.some((note) => note.level === 'warn')).toBe(false);
    });

    it('a root resolved through --app/--server cannot opt in, and the plan says so', () =>
    {
        const dir = root();
        installTools(dir);
        fullstackRoot(dir, { azeroth: { dev: 'server' } });
        const project = detectProject(dir, { app: 'application', server: 'server' });
        expect(project.kind === 'fullstack' ? project.azeroth : '').toBe('no-manifest');
        if (project.kind === 'fullstack')
        {
            const plan = planDev(project);
            expect(plan.steps.map((step) => step.label)).toEqual(['api', 'web']);
            expect(plan.notes.map((note) => note.text).join(' ')).toContain('--app/--server');
        }
    });

    it('a declared capability with vite resolvable from NOWHERE above the server half is a PlanError', () =>
    {
        const dir = root();
        // No installTools here: the one-step plan still has to prove vite is present, because
        // the dev session inside the server half will try to load it.
        const project = fullstackRoot(dir, { azeroth: { dev: 'server' } });
        expect(() => planDev(project)).toThrow(PlanError);
        expect(() => planDev(project)).toThrow(/vite \(the dev session loads the copy/);
    });

    it('the SSR entry name the plan builds is the one @azerothjs/kit/dev/entry owns', () =>
    {
        expect(KIT_SSR_ENTRY).toBe(SSR_SOURCE_ENTRY);
    });
});

/** Polls until the condition holds, so an assertion never races a child's last line. */
async function until(condition: () => boolean): Promise<void>
{
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline)
    {
        await new Promise<void>((settle) =>
        {
            setTimeout(settle, 10);
        });
    }
}

describe('runDev renders a warn note in the live frame', () =>
{
    it('prints it above the frame, before the first badge line, and leaves info notes to --print', async () =>
    {
        const dir = root();
        const plan: Plan = {
            command: 'dev',
            steps: [{
                label: 'api',
                cwd: dir,
                script: null,
                args: ['-e', 'console.log("the child spoke")'],
                longRunning: true,
                waitForFile: null
            }],
            notes: [
                { level: 'warn', text: 'the web step is dropped: one origin' },
                { level: 'info', text: 'an info note is print-only material' }
            ]
        };
        const chunks: string[] = [];
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean =>
        {
            chunks.push(String(chunk));
            return true;
        });
        try
        {
            await runDev(plan);
            await until(() => chunks.some((chunk) => chunk.includes('the child spoke')));
        }
        finally
        {
            stdout.mockRestore();
        }

        const note = chunks.findIndex((chunk) => chunk.includes('the web step is dropped'));
        const opened = chunks.indexOf('\n');
        const badged = chunks.findIndex((chunk) => chunk.includes('the child spoke'));
        expect(note).toBeGreaterThanOrEqual(0);
        expect(chunks[note]).toContain('!');
        expect(opened).toBeGreaterThan(note);
        expect(badged).toBeGreaterThan(opened);
        expect(chunks.some((chunk) => chunk.includes('an info note'))).toBe(false);
    });
});
