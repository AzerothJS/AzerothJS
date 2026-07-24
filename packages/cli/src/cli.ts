#!/usr/bin/env node
/**
 * MODULE: cli/cli - the `azeroth` bin
 *
 * A thin dispatcher: parse argv, detect the project's shape, hand the command its plan.
 * Exit codes are the contract - 0 success, 1 a gate or child failed, 2 usage or
 * detection error. `--print` on any orchestrating command prints the exact child
 * invocations and exits without running anything: there is nothing to eject because
 * nothing is hidden.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parseArgs } from 'node:util';

import { printBanner } from '@azerothjs/logger';

import { detectProject, type Project } from './detect.ts';
import { PlanError, formatStep, isRunnable, planBuild, planCheck, planDev, type Plan } from './plan.ts';
import { printNotes, runDev, runToCompletion } from './run.ts';
import { runDoctor } from './doctor.ts';
import { renderInfo } from './info.ts';
import { bold, brand, dim, fail, mark, print, statusMark, verdictGlyph } from './terminal.ts';

const VERSION = ((): string =>
{
    try
    {
        return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    }
    catch
    {
        return 'unknown';
    }
})();

/** The help screen in the house language: brand header, brand command names, dim flags. */
function usage(): string
{
    const commands: ReadonlyArray<readonly [string, string]> = [
        ['dev', 'Run the app in watch mode - the fullstack conductor'],
        ['check', "Every quality gate the project's shape demands (both halves, server first)"],
        ['build', 'Deployable artifacts in dependency order (a native backend has none - by design)'],
        ['doctor', 'Diagnose the environment against the known failure catalog'],
        ['info', 'A paste-able environment block for bug reports']
    ];
    const flags: ReadonlyArray<readonly [string, string]> = [
        ['--print', 'Print the exact child invocations and exit (dev/check/build)'],
        ['--app <dir>', 'Explicit frontend half of a fullstack root'],
        ['--server <dir>', 'Explicit backend half of a fullstack root'],
        ['-v, --version', 'Print the CLI version'],
        ['-h, --help', 'This text']
    ];
    let out = `\n${ brand(`${ mark() } ${ bold('azeroth') }`) } ${ dim(`v${ VERSION }`) }  ${ dim('the AzerothJS command line') }\n`;
    out += `\n  ${ dim('Usage:') } azeroth ${ brand('<command>') } ${ dim('[flags]') }\n`;
    out += `\n  ${ bold('Commands') }\n`;
    for (const [name, description] of commands)
    {
        out += `    ${ brand(name.padEnd(8)) } ${ description }\n`;
    }
    out += `\n  ${ bold('Flags') }\n`;
    for (const [flag, description] of flags)
    {
        out += `    ${ flag.padEnd(16) } ${ dim(description) }\n`;
    }
    out += `\n  ${ dim('Shape is detected from what already exists (package.json, a vite config) -') }\n`;
    out += `  ${ dim('there is no config file to maintain.') }\n`;
    return out;
}

function detectOrExit(cwd: string, app: string | null, server: string | null): Project
{
    const project = detectProject(cwd, { app, server });
    if (project.kind === 'none')
    {
        fail(project.reason);
        process.exit(2);
    }
    return project;
}

function planOrExit(project: Project, make: (runnable: Parameters<typeof planDev>[0]) => Plan): Plan
{
    if (!isRunnable(project))
    {
        fail(project.kind === 'library'
            ? 'nothing to run - this is a library package; its own npm scripts are the interface'
            : 'not a runnable project');
        process.exit(2);
    }
    try
    {
        return make(project);
    }
    catch (error)
    {
        if (error instanceof PlanError)
        {
            fail(error.message);
            process.exit(1);
        }
        throw error;
    }
}

function printPlan(plan: Plan): void
{
    printNotes(plan);
    for (const step of plan.steps)
    {
        print(formatStep(step));
    }
}

function shapeEntries(project: Project): Array<readonly [string, string]>
{
    if (project.kind === 'fullstack')
    {
        return [
            ['project', 'fullstack'],
            ['web', relative(project.dir, project.app.dir) || '.'],
            ['api', `${ relative(project.dir, project.server.dir) || '.' } (${ project.server.build })`]
        ];
    }
    if (project.kind === 'backend')
    {
        return [['project', `backend (${ project.build })`]];
    }
    return [['project', project.kind]];
}

async function main(): Promise<number>
{
    let parsed;
    try
    {
        parsed = parseArgs({
            args: process.argv.slice(2),
            options: {
                print: { type: 'boolean', default: false },
                app: { type: 'string' },
                server: { type: 'string' },
                version: { type: 'boolean', short: 'v', default: false },
                help: { type: 'boolean', short: 'h', default: false }
            },
            allowPositionals: true
        });
    }
    catch (error)
    {
        fail(error instanceof Error ? error.message : String(error));
        print(usage());
        return 2;
    }
    const { values, positionals } = parsed;

    if (values.version)
    {
        print(VERSION);
        return 0;
    }
    const command = positionals[0];
    if (values.help || command === undefined || command === 'help')
    {
        print(usage());
        return command === undefined && !values.help ? 2 : 0;
    }

    const cwd = process.cwd();
    const app = values.app ?? null;
    const server = values.server ?? null;

    switch (command)
    {
        case 'dev':
        {
            const project = detectOrExit(cwd, app, server);
            const plan = planOrExit(project, planDev);
            if (values.print)
            {
                printPlan(plan);
                return 0;
            }
            printBanner({ name: 'AzerothJS', subtitle: 'dev', version: VERSION, entries: shapeEntries(project) });
            return runDev(plan);
        }
        case 'check':
        case 'build':
        {
            const project = detectOrExit(cwd, app, server);
            const plan = planOrExit(project, command === 'check' ? planCheck : planBuild);
            if (values.print)
            {
                printPlan(plan);
                return 0;
            }
            return runToCompletion(plan);
        }
        case 'doctor':
        {
            const project = detectProject(cwd, { app, server });
            const results = runDoctor(project);
            for (const result of results)
            {
                print(`${ statusMark(result.status) } ${ result.name.padEnd(22) } ${ result.detail }`);
            }
            const count = (status: string): number => results.filter((result) => result.status === status).length;
            const plural = (n: number, word: string): string => `${ n } ${ word }${ n === 1 ? '' : 's' }`;
            print(`${ verdictGlyph() } ${ count('ok') } ok · ${ plural(count('warn'), 'warning') } · ${ plural(count('fail'), 'failure') }`);
            return results.some((result) => result.status === 'fail') ? 1 : 0;
        }
        case 'info':
        {
            print(renderInfo(detectProject(cwd, { app, server }), VERSION));
            return 0;
        }
        default:
        {
            fail(`unknown command '${ command }'`);
            print(usage());
            return 2;
        }
    }
}

process.exitCode = await main();
