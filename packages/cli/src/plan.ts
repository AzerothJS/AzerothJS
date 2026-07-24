/**
 * MODULE: cli/plan - command planning
 *
 * Every orchestrating command computes a Plan - the exact child invocations it would
 * run - before anything executes. `--print` prints the plan and exits; the runner
 * executes it unchanged. One honest data structure keeps the CLI transparent: there is
 * nothing the CLI does that its plan does not show.
 *
 * Children are always `node <absolute script path>` (or node running its own --watch) -
 * never a cmd shim, never shell:true - so the Windows argument-quoting class of bug
 * (DEP0190) is unrepresentable by construction. Tools are resolved from the PROJECT's
 * own node_modules by walking up the directory tree: the CLI orchestrates the versions
 * the user installed, it ships none of its own.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { BackendProject, FrontendProject, FullstackProject, Project } from './detect.ts';

/** One child invocation: node runs `script` (or its own args when script is null). */
export interface Step
{
    /** Output prefix and heading label ([web], [api], [api build]). */
    label: string;

    /** Working directory the child runs in (absolute). */
    cwd: string;

    /** Absolute path of the JS entry node executes; null when node runs its own args (--watch). */
    script: string | null;

    /** Arguments after the script (or after node itself when script is null). */
    args: string[];

    /** Watcher that runs until killed (dev) vs a step that must exit 0 (check/build). */
    longRunning: boolean;

    /** The runner delays this step until the file exists (tsc -w first-emit gate); absolute. */
    waitForFile: string | null;
}

/** What one command will run: the ordered steps plus the human notes explaining any gaps. */
export interface Plan
{
    command: 'dev' | 'check' | 'build';
    steps: Step[];

    /** Human notes printed before execution - skipped gates, "no build step needed", etc. */
    notes: string[];
}

/** A plan could not be assembled (a required tool is not installed). Exit code 1 territory. */
export class PlanError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'PlanError';
    }
}

const VITE = 'vite/bin/vite.js';
const TSC = 'typescript/bin/tsc';
const ESLINT = 'eslint/bin/eslint.js';
const AZEROTH_TSC = '@azerothjs/language-server/dist/tsc-cli.js';
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts'];

/**
 * Resolves a script under some node_modules by walking up from `fromDir` - the same
 * lookup node itself performs, minus the exports-map gatekeeping that blocks
 * `require.resolve` on bin files most packages do not export.
 */
export function resolveTool(fromDir: string, relPath: string): string | null
{
    let dir = resolve(fromDir);
    for (;;)
    {
        const candidate = join(dir, 'node_modules', relPath);
        if (existsSync(candidate))
        {
            return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir)
        {
            return null;
        }
        dir = parent;
    }
}

function need(fromDir: string, relPath: string, what: string): string
{
    const found = resolveTool(fromDir, relPath);
    if (found === null)
    {
        throw new PlanError(`${ what } is not installed - looked for node_modules/${ relPath } from ${ fromDir } upward`);
    }
    return found;
}

function step(partial: Omit<Step, 'waitForFile'> & { waitForFile?: string }): Step
{
    return { waitForFile: null, ...partial };
}

function devServerSteps(server: BackendProject, label: string): Step[]
{
    if (server.build === 'native')
    {
        return [step({ label, cwd: server.dir, script: null, args: ['--watch', server.entry], longRunning: true })];
    }
    const tsc = need(server.dir, TSC, 'typescript (the server uses decorators, so tsc must emit before node can run it)');
    const builtEntry = server.builtEntry ?? 'dist/main.js';
    return [
        step({ label: `${ label } build`, cwd: server.dir, script: tsc, args: ['-w', '--preserveWatchOutput', '-p', 'tsconfig.json'], longRunning: true }),
        step({
            label,
            cwd: server.dir,
            script: null,
            args: ['--watch', builtEntry],
            longRunning: true,
            waitForFile: join(server.dir, builtEntry)
        })
    ];
}

function devWebStep(app: FrontendProject, label: string): Step
{
    const vite = need(app.dir, VITE, 'vite');
    return step({ label, cwd: app.dir, script: vite, args: [], longRunning: true });
}

/**
 * The dev conductor's plan: watchers for every half the shape has, in start order
 * (a built backend's tsc first, its node --watch gated on the first emit, vite last).
 *
 * @throws PlanError when a required tool (vite, tsc) is not installed in the project.
 */
export function planDev(project: FrontendProject | BackendProject | FullstackProject): Plan
{
    switch (project.kind)
    {
        case 'frontend':
            return { command: 'dev', steps: [devWebStep(project, 'web')], notes: ['frontend project: this is vite, verbatim'] };
        case 'backend':
            return {
                command: 'dev',
                steps: devServerSteps(project, 'api'),
                notes: project.build === 'native'
                    ? ['native backend: node runs the TypeScript source directly']
                    : ['built backend (decorators): tsc watches, node --watch follows the emitted output']
            };
        case 'fullstack':
            return {
                command: 'dev',
                steps: [...devServerSteps(project.server, 'api'), devWebStep(project.app, 'web')],
                notes: []
            };
    }
}

function checkSteps(dir: string, label: string, shape: 'frontend' | 'backend', notes: string[]): Step[]
{
    const steps: Step[] = [];
    if (shape === 'frontend')
    {
        const azTsc = resolveTool(dir, AZEROTH_TSC);
        if (azTsc !== null)
        {
            steps.push(step({ label: `${ label } typecheck`, cwd: dir, script: azTsc, args: [], longRunning: false }));
        }
        else
        {
            notes.push(`${ label }: azeroth-tsc not installed (add @azerothjs/language-server as a devDependency) - typecheck skipped`);
        }
    }
    else
    {
        const tsc = resolveTool(dir, TSC);
        if (tsc !== null)
        {
            steps.push(step({ label: `${ label } typecheck`, cwd: dir, script: tsc, args: ['--noEmit', '-p', 'tsconfig.json'], longRunning: false }));
        }
        else
        {
            notes.push(`${ label }: typescript not installed - typecheck skipped`);
        }
    }

    const hasEslintConfig = ESLINT_CONFIGS.some((name) => existsSync(join(dir, name)));
    const eslint = hasEslintConfig ? resolveTool(dir, ESLINT) : null;
    if (eslint !== null)
    {
        steps.push(step({ label: `${ label } lint`, cwd: dir, script: eslint, args: ['.'], longRunning: false }));
    }
    else if (hasEslintConfig)
    {
        notes.push(`${ label }: eslint.config.* exists but eslint is not installed - lint skipped`);
    }
    return steps;
}

/**
 * Every quality gate the project's shape demands - azeroth-tsc for a frontend,
 * `tsc --noEmit` for a backend, eslint wherever a config exists; a fullstack app
 * checks its server half first (fail-fast on the cheaper gate). A missing tool is
 * never a silent skip: it becomes a printed note.
 */
export function planCheck(project: FrontendProject | BackendProject | FullstackProject): Plan
{
    const notes: string[] = [];
    switch (project.kind)
    {
        case 'frontend':
            return { command: 'check', steps: checkSteps(project.dir, 'web', 'frontend', notes), notes };
        case 'backend':
            return { command: 'check', steps: checkSteps(project.dir, 'api', 'backend', notes), notes };
        case 'fullstack':
            return {
                command: 'check',
                steps: [
                    ...checkSteps(project.server.dir, 'api', 'backend', notes),
                    ...checkSteps(project.app.dir, 'web', 'frontend', notes)
                ],
                notes
            };
    }
}

/**
 * Deployable artifacts in dependency order (server before client). A NATIVE backend
 * deliberately produces zero steps - Node >= 24 runs the TypeScript source, and the
 * plan's note says so rather than inventing a build to look busy.
 *
 * @throws PlanError when a required tool is not installed in the project.
 */
export function planBuild(project: FrontendProject | BackendProject | FullstackProject): Plan
{
    switch (project.kind)
    {
        case 'frontend':
        {
            const vite = need(project.dir, VITE, 'vite');
            return {
                command: 'build',
                steps: [step({ label: 'web', cwd: project.dir, script: vite, args: ['build'], longRunning: false })],
                notes: []
            };
        }
        case 'backend':
            return buildServerPlan(project);
        case 'fullstack':
        {
            const server = buildServerPlan(project.server);
            const vite = need(project.app.dir, VITE, 'vite');
            return {
                command: 'build',
                steps: [
                    ...server.steps,
                    step({ label: 'web', cwd: project.app.dir, script: vite, args: ['build'], longRunning: false })
                ],
                notes: server.notes
            };
        }
    }
}

function buildServerPlan(server: BackendProject): Plan
{
    if (server.build === 'native')
    {
        return {
            command: 'build',
            steps: [],
            notes: ['api: no build step - Node >= 24 runs the TypeScript source natively; deploy src/ as-is']
        };
    }
    const tsc = need(server.dir, TSC, 'typescript');
    return {
        command: 'build',
        steps: [step({ label: 'api', cwd: server.dir, script: tsc, args: ['-p', 'tsconfig.json'], longRunning: false })],
        notes: []
    };
}

/** One copy-pasteable line per step - what --print shows and headings echo. */
export function formatStep(step: Step): string
{
    const argv = step.script === null ? ['node', ...step.args] : ['node', step.script, ...step.args];
    return `[${ step.label }] cd ${ step.cwd } && ${ argv.join(' ') }`
        + (step.waitForFile === null ? '' : `   (starts after ${ step.waitForFile } exists)`);
}

/** Guard shared by the runnable commands: narrows Project to the shapes plans accept. */
export function isRunnable(project: Project): project is FrontendProject | BackendProject | FullstackProject
{
    return project.kind === 'frontend' || project.kind === 'backend' || project.kind === 'fullstack';
}
