/**
 * MODULE: cli/run - plan execution
 *
 * Two executors, one honest contract: they run EXACTLY the plan's steps.
 * `runToCompletion` (check/build) runs steps sequentially with inherited stdio -
 * tool output is never re-parsed or re-formatted, because re-formatting is how
 * wrappers start lying - and fails fast on the first non-zero exit.
 * `runDev` starts every step as a supervised child and owns the frame around them:
 * fixed-width colored badges, the line discipline in lines.ts (blank lines swallowed,
 * each tool's session chatter rewritten to house style, real content byte-intact),
 * capability propagation so children keep their colors and pretty faces under the
 * pipe, a compile-report gate for the tsc-then-node sequencing, and one composed
 * ready frame when every half has reported its URL. `--raw` turns the discipline
 * off (verbatim lines, no env additions) for debugging the tools themselves;
 * NO_COLOR / FORCE_COLOR / AZEROTH_LOG set by the user always win over the
 * conductor's propagation (see terminal.childPresentationEnv).
 *
 * Output goes to stdout/stderr directly, NOT through @azerothjs/logger: this text is
 * the CLI's user interface (copy-pasteable plans, pipe-stable tables), not telemetry.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { formatStep, type Plan, type Step } from './plan.ts';
import { classifyStep, serverUrl, transformLine, tscReport, viteUrl } from './lines.ts';
import { badge, cross, dim, mark, print, printError, readyFrame, stdoutPaint, stepHeading, success, childPresentationEnv, write } from './terminal.ts';

function argvOf(step: Step): string[]
{
    return step.script === null ? [...step.args] : [step.script, ...step.args];
}

/** "42 s" under a minute, "12m 4s" past it - a farewell reads in human units. */
function formatUptime(ms: number): string
{
    const seconds = Math.round(ms / 1000);
    if (seconds < 60)
    {
        return `${ seconds } s`;
    }
    return `${ Math.floor(seconds / 60) }m ${ seconds % 60 }s`;
}

/** Prints the plan's notes (dim, one line each). */
export function printNotes(plan: Plan): void
{
    for (const note of plan.notes)
    {
        print(dim(`  ${ note }`));
    }
}

/**
 * Sequential executor for check/build: prints each step's heading, runs it with
 * inherited stdio (tool output is never re-formatted), and fails fast.
 *
 * @returns The process exit code to use: 0 when every step passed, otherwise the
 * first failing child's code (or 1 when it died without one).
 */
export function runToCompletion(plan: Plan): number
{
    printNotes(plan);
    for (const step of plan.steps)
    {
        print(stepHeading(step.label));
        const result = spawnSync(process.execPath, argvOf(step), { cwd: step.cwd, stdio: 'inherit', shell: false });
        if (result.error !== undefined)
        {
            printError(`${ cross() } ${ step.label } failed to start: ${ result.error.message }`);
            return 1;
        }
        if (result.status !== 0)
        {
            printError(`${ cross() } ${ step.label } exited with code ${ result.status ?? 'null' }`);
            return result.status ?? 1;
        }
    }
    if (plan.steps.length > 0)
    {
        print(success(plan.command === 'check' ? 'all checks passed' : 'build complete'));
    }
    return 0;
}

/**
 * Forwards a child stream line by line: `onLine` returns the rendered line (badge
 * added here) or null to swallow it. Signal detection happens inside `onLine` too,
 * on the raw bytes - rendering and detection must see the same line exactly once.
 */
function prefixStream(stream: NodeJS.ReadableStream, prefix: string, onLine: (line: string) => string | null): void
{
    let buffered = '';
    stream.setEncoding('utf8');
    const emit = (line: string): void =>
    {
        const rendered = onLine(line);
        if (rendered !== null)
        {
            write(`${ prefix } ${ rendered }\n`);
        }
    };
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
            emit(buffered.slice(0, newline).replace(/\r$/, ''));
            buffered = buffered.slice(newline + 1);
        }
    });
    stream.on('end', () =>
    {
        if (buffered !== '')
        {
            emit(buffered);
        }
    });
}

/** How `runDev` presents the session; `raw` = verbatim lines, no env propagation. */
export interface DevOptions
{
    raw?: boolean;
}

/**
 * The dev supervisor. Resolves only on shutdown; the process exit code is the first
 * failed child's, or 0 on a signal-initiated teardown.
 */
export async function runDev(plan: Plan, options: DevOptions = {}): Promise<number>
{
    const raw = options.raw === true;
    if (raw)
    {
        // The live frame's banner already carries the shape; notes are --print/raw
        // material. Verbatim mode keeps them - verbatim means everything.
        printNotes(plan);
    }
    const paint = stdoutPaint();
    const startedAt = Date.now();
    const childEnv = raw ? process.env : { ...process.env, ...childPresentationEnv() };
    const badgeWidth = Math.max(0, ...plan.steps.map((step) => step.label.length));

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

    // The farewell prints ONLY on a signal-initiated stop (the developer's Ctrl+C) -
    // a child dying is a failure moment, not a goodbye, and gets the red treatment.
    const farewell = (): void =>
    {
        if (!raw && !session.shuttingDown)
        {
            write(`\n  ${ dim(`${ mark() } stopped after ${ formatUptime(Date.now() - startedAt) }`) }\n`);
        }
    };
    process.on('SIGINT', () =>
    {
        farewell(); shutdown(0);
    });
    process.on('SIGTERM', () =>
    {
        farewell(); shutdown(0);
    });

    // The ready frame: every URL-producing child (a server's `listening` log, vite's
    // Local line) reports once; when all have - or 10s after the first - the conductor
    // composes the one block the developer is waiting for. Children that never report
    // (an app not logging its address) degrade the frame to the halves that did.
    const expected = plan.steps.filter((step) =>
    {
        const kind = classifyStep(step);
        return kind === 'node-watch' || kind === 'vite';
    }).map((step) => step.label);
    const found = new Map<string, string>();
    const frame = { printed: false, timer: null as NodeJS.Timeout | null };
    const printFrame = (): void =>
    {
        if (frame.printed || raw || session.shuttingDown)
        {
            return;
        }
        frame.printed = true;
        if (frame.timer !== null)
        {
            clearTimeout(frame.timer);
        }
        const entries = expected.filter((name) => found.has(name)).map((name) => [name, found.get(name) ?? ''] as const);
        if (entries.length > 0)
        {
            write(readyFrame(entries, Date.now() - startedAt));
        }
    };
    const reportUrl = (label: string, url: string): void =>
    {
        if (found.has(label))
        {
            return; // restarts re-log the address; the frame reports the first boot
        }
        found.set(label, url);
        if (found.size === expected.length)
        {
            printFrame();
        }
        else if (frame.timer === null)
        {
            frame.timer = setTimeout(printFrame, 10_000);
            frame.timer.unref();
        }
    };

    // tsc-watch steps gate their node --watch sibling (same cwd) on the FIRST compile
    // report: the report prints after the emit burst, so the server starts exactly once
    // - no settle heuristics, no restart storm, no doubled `listening` line.
    const compileGates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    for (const step of plan.steps)
    {
        if (classifyStep(step) === 'tsc-watch')
        {
            let release!: () => void;
            const promise = new Promise<void>((resolvePromise) =>
            {
                release = resolvePromise;
            });
            compileGates.set(step.cwd, { promise, resolve: release });
        }
    }

    // One hue per app half: 'api' and 'api build' share a family, so a half's build
    // stream reads as the dimmed sibling of its server stream, not a third actor.
    const families: string[] = [];
    const familyOf = (label: string): number =>
    {
        const family = label.split(' ')[0] ?? label;
        const known = families.indexOf(family);
        if (known !== -1)
        {
            return known;
        }
        families.push(family);
        return families.length - 1;
    };

    print();
    for (const step of plan.steps)
    {
        const prefix = badge(step.label, familyOf(step.label), badgeWidth);
        if (step.waitForFile !== null)
        {
            const gate = compileGates.get(step.cwd);
            if (gate !== undefined)
            {
                write(`${ prefix } ${ dim('waiting for the first compile') }\n`);
                await Promise.race([gate.promise, done]);
            }
            while (!existsSync(step.waitForFile))
            {
                if (session.shuttingDown)
                {
                    return session.exitCode;
                }
                await sleep(150);
            }
        }
        if (session.shuttingDown)
        {
            return session.exitCode;
        }

        const kind = classifyStep(step);
        if (raw)
        {
            // The live frame drops the full-command echo (azeroth dev --print is the
            // transparency surface); raw mode keeps it - verbatim means verbatim.
            print(dim(`→ ${ formatStep(step) }`));
        }

        const child = spawn(process.execPath, argvOf(step), {
            cwd: step.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            env: childEnv
        });
        children.push(child);
        const onLine = (line: string): string | null =>
        {
            if (kind === 'tsc-watch' && tscReport(line) !== null)
            {
                compileGates.get(step.cwd)?.resolve();
            }
            if (kind === 'node-watch')
            {
                const url = serverUrl(line);
                if (url !== null)
                {
                    reportUrl(step.label, url);
                }
            }
            if (kind === 'vite')
            {
                const url = viteUrl(line);
                if (url !== null)
                {
                    reportUrl(step.label, url);
                }
            }
            return raw ? line : transformLine(kind, line, paint);
        };
        prefixStream(child.stdout, prefix, onLine);
        prefixStream(child.stderr, prefix, onLine);
        child.on('error', (error) =>
        {
            if (raw)
            {
                printError(`[${ step.label }] failed to start: ${ error.message }`);
            }
            else
            {
                write(`\n${ prefix } ${ paint.red(`${ cross() } failed to start`) } ${ dim(`- ${ error.message }`) }\n`);
            }
            shutdown(1);
        });
        child.on('exit', (code) =>
        {
            if (!session.shuttingDown)
            {
                if (raw)
                {
                    printError(`[${ step.label }] exited with code ${ code ?? 'null' } - stopping the dev session`);
                }
                else
                {
                    write(`\n${ prefix } ${ paint.red(`${ cross() } exited with code ${ code ?? 'null' }`) } ${ dim('- stopping the dev session') }\n`);
                }
                shutdown(code ?? 1);
            }
        });
    }

    await done;
    return session.exitCode;
}
