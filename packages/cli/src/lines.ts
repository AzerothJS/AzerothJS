/**
 * MODULE: cli/lines - the dev conductor's line discipline
 *
 * Pure functions between a child's raw output and the frame the developer sees.
 * Three jobs, all honest: classify what kind of child a step spawns, rewrite the
 * chatter each tool repeats every session into the house style (never touching
 * real content - diagnostics, HMR notices, and app logs pass through byte-intact),
 * and extract the ready signals (compile reports, server URLs) the conductor
 * composes into its ready frame. Rewriting is allowed ONLY for lines whose entire
 * information content survives the rewrite - an error count stays an error count.
 */

import { supportsUnicode, type Palette } from '@azerothjs/logger';

import type { Step } from './plan.ts';

/** What a dev step spawns - decides which rewrite rules its output gets. */
export type StepKind = 'tsc-watch' | 'node-watch' | 'vite' | 'other';

/**
 * Removes terminal control sequences so matching sees the same bytes in every
 * terminal: CSI sequences (styling, cursor movement) and the bare RIS reset
 * (ESC c) node --watch prints before its restart notice.
 */
export function stripAnsi(text: string): string
{
    // eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
    return text.replace(/\u001b(?:\[[0-9;?]*[A-Za-z]|c)/g, '');
}

/** Classifies a plan step by what it actually invokes (script path + args, not label). */
export function classifyStep(step: Pick<Step, 'script' | 'args'>): StepKind
{
    if (step.script === null)
    {
        return step.args[0] === '--watch' ? 'node-watch' : 'other';
    }
    const script = step.script.replace(/\\/g, '/');
    if (script.includes('typescript/bin/tsc'))
    {
        return step.args.includes('-w') || step.args.includes('--watch') ? 'tsc-watch' : 'other';
    }
    if (script.includes('vite/bin/vite'))
    {
        return 'vite';
    }
    return 'other';
}

/** The compile-report error count, when the line is tsc's "Found N errors. Watching..." */
export function tscReport(line: string): number | null
{
    const match = stripAnsi(line).match(/Found (\d+) errors?\. Watching for file changes\./);
    return match === null ? null : Number.parseInt(match[1] ?? '0', 10);
}

/**
 * The URL from a server's `listening` line - either logger face, any casing, with
 * or without a `url=` label (the pretty face drops that tautological key). The rule
 * is deliberately loose: a line that says listening and carries an http(s) URL IS
 * the signal; apps that log their address any other way simply produce no signal
 * (the frame degrades, see run).
 */
export function serverUrl(line: string): string | null
{
    const plain = stripAnsi(line);
    if (!/\blistening\b/i.test(plain))
    {
        return null;
    }
    // Stop at whitespace OR a quote so the NDJSON face's "url":"..." stays clean.
    const url = plain.match(/https?:\/\/[^\s"]+/);
    return url === null ? null : url[0];
}

/** The URL from vite's "Local: http://..." ready line. */
export function viteUrl(line: string): string | null
{
    const match = stripAnsi(line).match(/Local:\s+(http\S+)/);
    return match === null ? null : match[1] ?? null;
}

const glyph = {
    check: (): string => supportsUnicode() ? '✓' : '+',
    cross: (): string => supportsUnicode() ? '✖' : 'x',
    cycle: (): string => supportsUnicode() ? '↻' : '~'
};

/**
 * Rewrites one child line for display, or swallows it (null). Blank lines vanish
 * for every kind; each tool's session chatter becomes one house-style line; every
 * other line - diagnostics, HMR, request logs - passes through untouched.
 */
export function transformLine(kind: StepKind, line: string, paint: Palette): string | null
{
    const plain = stripAnsi(line).trim();
    if (plain === '')
    {
        return null;
    }
    switch (kind)
    {
        case 'tsc-watch': return transformTsc(plain, line, paint);
        case 'node-watch': return transformNodeWatch(plain, line, paint);
        case 'vite': return transformVite(plain, line);
        case 'other': return line;
    }
}

function transformTsc(plain: string, line: string, paint: Palette): string | null
{
    if (plain.includes('Starting compilation in watch mode'))
    {
        return paint.dim('compiling...');
    }
    if (plain.includes('File change detected. Starting incremental compilation'))
    {
        return paint.dim('recompiling...');
    }
    const report = plain.match(/Found (\d+) errors?\. Watching for file changes\./);
    if (report !== null)
    {
        const count = Number.parseInt(report[1] ?? '0', 10);
        if (count === 0)
        {
            return `${ paint.green(glyph.check()) } ${ paint.dim('compiled clean') }`;
        }
        return `${ paint.red(glyph.cross()) } ${ paint.red(`${ count } error${ count === 1 ? '' : 's' }`) } ${ paint.dim('- watching') }`;
    }
    return line;
}

function transformNodeWatch(plain: string, line: string, paint: Palette): string | null
{
    if (/^Restarting '/.test(plain))
    {
        return paint.dim(`${ glyph.cycle() } restarting`);
    }
    if (/^Completed running '/.test(plain))
    {
        return paint.dim('process exited - waiting for changes');
    }
    if (/^Failed running '/.test(plain))
    {
        return `${ paint.red(glyph.cross()) } ${ paint.red('crashed') } ${ paint.dim('- waiting for changes') }`;
    }
    return line;
}

/**
 * Vite's identity block is suppressed, not styled: the version/ready line and the
 * Local/Network URLs reappear in the conductor's own ready frame, and the
 * "press h + enter" hint would be a lie - the conductor does not forward stdin.
 */
function transformVite(plain: string, line: string): string | null
{
    if (/^VITE v[\d.]/.test(plain))
    {
        return null;
    }
    if (/^(?:➜\s*)?(?:Local|Network):/.test(plain))
    {
        return null;
    }
    if (/press h \+ enter/.test(plain))
    {
        return null;
    }
    return line;
}
