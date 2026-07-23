/**
 * MODULE: cli/run - plan execution
 *
 * Two executors, one honest contract: they run EXACTLY the plan's steps.
 * `runToCompletion` (check/build) runs steps sequentially with inherited stdio -
 * tool output is never re-parsed or re-formatted, because re-formatting is how
 * wrappers start lying - and fails fast on the first non-zero exit.
 * `runDev` starts every step as a supervised child: line-buffered output under a
 * colored [label] prefix, a waitForFile gate for the tsc-first-emit sequencing,
 * SIGINT/SIGTERM tear the whole session down, and the first child to exit takes
 * the session with it (the watchers themselves are the restart logic - node --watch
 * and tsc -w survive errors without exiting).
 *
 * Children are piped, which makes them non-TTY - so vite skips its screen-clearing
 * and the server's own logger banner self-suppresses (it prints only on a TTY). The
 * conductor's single banner is unified by construction, not by patching children.
 *
 * Output goes to stdout/stderr directly, NOT through @azerothjs/logger: this text is
 * the CLI's user interface (copy-pasteable plans, pipe-stable tables), not telemetry.
 * The logger's non-TTY face is NDJSON records - exactly what `azeroth info > report`
 * and CI pipes must never receive. The logger appears where its purpose matches: the
 * banner (printBanner), and the child servers' own runtime logging, relayed untouched.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { formatStep, type Plan, type Step } from './plan.ts';
import { dim, label, print, printError, write } from './terminal.ts';

function argvOf(step: Step): string[]
{
    return step.script === null ? [...step.args] : [step.script, ...step.args];
}

/** Prints the plan's notes (dim, one line each). */
export function printNotes(plan: Plan): void
{
    for (const note of plan.notes)
    {
        print(dim(`  ${ note }`));
    }
}

/** Sequential executor for check/build: heading, inherit stdio, fail fast. */
export function runToCompletion(plan: Plan): number
{
    printNotes(plan);
    for (const step of plan.steps)
    {
        print(dim(`→ ${ formatStep(step) }`));
        const result = spawnSync(process.execPath, argvOf(step), { cwd: step.cwd, stdio: 'inherit', shell: false });
        if (result.error !== undefined)
        {
            printError(`[${ step.label }] failed to start: ${ result.error.message }`);
            return 1;
        }
        if (result.status !== 0)
        {
            printError(`[${ step.label }] exited with code ${ result.status ?? 'null' }`);
            return result.status ?? 1;
        }
    }
    return 0;
}

/** Forwards a child stream to stdout line by line under a colored prefix. */
function prefixStream(stream: NodeJS.ReadableStream, prefix: string): void
{
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) =>
    {
        buffered += chunk;
        for (;;)
        {
            const newline = buffered.indexOf('\n');
            if (newline === -1)
            {
                break;
            }
            const line = buffered.slice(0, newline).replace(/\r$/, '');
            buffered = buffered.slice(newline + 1);
            write(`${ prefix } ${ line }\n`);
        }
    });
    stream.on('end', () =>
    {
        if (buffered !== '')
        {
            write(`${ prefix } ${ buffered }\n`);
        }
    });
}

/**
 * The dev supervisor. Resolves only on shutdown; the process exit code is the first
 * failed child's, or 0 on a signal-initiated teardown.
 */
export async function runDev(plan: Plan): Promise<number>
{
    printNotes(plan);
    const children: ChildProcess[] = [];
    // Mutated from signal handlers and child-exit callbacks while the start loop is
    // suspended on await - object properties keep control-flow analysis honest about that.
    const session = { shuttingDown: false, exitCode: 0 };
    let settle: (() => void) | null = null;
    const done = new Promise<void>((resolvePromise) =>
    {
        settle = resolvePromise;
    });

    const shutdown = (code: number): void =>
    {
        if (session.shuttingDown)
        {
            return;
        }
        session.shuttingDown = true;
        session.exitCode = code;
        for (const child of children)
        {
            child.kill();
        }
        settle?.();
    };

    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));

    let colorIndex = 0;
    for (const step of plan.steps)
    {
        if (step.waitForFile !== null && !existsSync(step.waitForFile))
        {
            print(dim(`  [${ step.label }] waiting for first compile: ${ step.waitForFile }`));
            while (!existsSync(step.waitForFile))
            {
                if (session.shuttingDown)
                {
                    return session.exitCode;
                }
                await sleep(150);
            }
            // The gate file lands mid-emit-burst (tsc writes dozens of siblings after it);
            // starting node --watch immediately triggers a restart storm that can lose the
            // port-release race. A short settle lets the burst finish first.
            await sleep(500);
        }
        if (session.shuttingDown)
        {
            return session.exitCode;
        }

        const prefix = label(`[${ step.label }]`, colorIndex);
        colorIndex += 1;
        print(dim(`→ ${ formatStep(step) }`));

        const child = spawn(process.execPath, argvOf(step), {
            cwd: step.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            env: process.env
        });
        children.push(child);
        prefixStream(child.stdout, prefix);
        prefixStream(child.stderr, prefix);
        child.on('error', (error) =>
        {
            printError(`[${ step.label }] failed to start: ${ error.message }`);
            shutdown(1);
        });
        child.on('exit', (code) =>
        {
            if (!session.shuttingDown)
            {
                printError(`[${ step.label }] exited with code ${ code ?? 'null' } - stopping the dev session`);
                shutdown(code ?? 1);
            }
        });
    }

    await done;
    return session.exitCode;
}
