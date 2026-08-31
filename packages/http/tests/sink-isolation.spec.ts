// @vitest-environment node
//
// A REPORTING SINK MUST NOT BE ABLE TO KILL THE SERVER.
//
// These seams are consumer code the framework calls to TELL it something, so its failure has
// nowhere to go and must not propagate. Two shapes have to be contained, and guarding only the
// first is the trap that shipped: a SYNCHRONOUS throw inside a floating promise becomes an
// uncaughtException and exits the process, while an `async` sink declared `void` rejects in a
// way a try/catch around the CALL never sees - the call itself returned fine.
//
// Measured before the fix: a throwing observer on a declared stream route exited(1), and an
// async-rejecting one exited(1) through a seam whose synchronous throw was ALREADY guarded.
//
// WHICH ROWS DISCRIMINATE: the declared-stream rows do - reverting either guard makes the child
// die with `register.ts -> sse.ts` on its stack. The kernel-stream rows do NOT isolate one
// guard, because the App wraps the user's sink before request-root ever sees it, so removing the
// lower guard alone changes nothing. They are kept as end-to-end assertions that the seam
// survives at all, not as a pin on any single line - stated here so nobody reads a green
// kernel-stream row as proof that request-root's own isolation is intact.
//
// THIS RUNS IN A CHILD PROCESS ON PURPOSE. An in-process arm cannot observe a process exit: an
// earlier version of this test asserted on `unhandledRejection` inside the runner, passed
// against the deliberately reverted fix, and was therefore no evidence at all. The exit code is
// the only honest detector.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sink-kills-server.mjs');

function runArm(seam: string, mode: string): { code: number; output: string }
{
    try
    {
        const output = execFileSync(process.execPath, [FIXTURE, seam, mode], {
            encoding: 'utf8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        return { code: 0, output };
    }
    catch (error)
    {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failure.status ?? -1, output: `${ failure.stdout ?? '' }${ failure.stderr ?? '' }` };
    }
}

describe('a failing reporting sink leaves the server standing', () =>
{
    // Both seams, both failure shapes. The declared-stream seam used to exit on BOTH; the
    // kernel seam contained the throw and exited on the rejection.
    it.each([
        ['declared-stream', 'sync'],
        ['declared-stream', 'async'],
        ['kernel-stream', 'sync'],
        ['kernel-stream', 'async'],
        // The adapter's own two seams, found by a sweep for this same defect class. Both sit
        // OUTSIDE any promise chain: `before` is called bare in the 'request' listener, and a
        // WebHandler that throws synchronously never makes the promise the adapter's .catch
        // guards. Both killed the process on both shapes, and both take an unrelated in-flight
        // request down with them. These rows DO discriminate - reverting either guard fails
        // all four.
        ['before-seam', 'sync'],
        ['before-seam', 'async'],
        ['handler-seam', 'sync'],
        ['handler-seam', 'async']
    ])('%s seam survives a sink that fails with %s', (seam, mode) =>
    {
        const { code, output } = runArm(seam, mode);
        expect(output).toContain('SURVIVED');
        expect(code).toBe(0);
    }, 40_000);

    it.each([
        ['declared-stream'],
        ['kernel-stream'],
        ['before-seam'],
        ['handler-seam']
    ])('CONTROL: %s seam with a sink that returns normally', (seam) =>
    {
        // Proves the harness reports 0 for a healthy run, so a 0 above means something.
        const { code, output } = runArm(seam, 'control');
        expect(output).toContain('SURVIVED');
        expect(code).toBe(0);
    }, 40_000);
});
