/**
 * MODULE: scripts/clean
 *
 * PURPOSE:
 * Cross-platform build-output cleaner. Removes the given directories (default:
 * `dist`) relative to the current working directory using only Node's `fs` API,
 * so it behaves identically on Windows, macOS, and Linux - no `rm -rf`, `del`,
 * `rmdir`, or other shell-specific command.
 *
 * WHY IT EXISTS:
 * Every workspace package wires this as its `clean` script and runs it from
 * `prebuild`, so each `build` starts from an empty output directory and no stale
 * artifact can survive a rename, move, or delete. It is the single source of truth
 * for "how do we clean output"; package scripts only declare WHICH directory.
 *
 * INPUT CONTRACT:
 * - process.argv[2..]: zero or more directory paths, relative to process.cwd().
 *   With no arguments it defaults to `dist`.
 *
 * OUTPUT CONTRACT:
 * - Removes each target directory if present and logs what it removed. Sets a
 *   non-zero exit code (without throwing) if a target resolves outside the working
 *   directory.
 *
 * DEVELOPER WARNING:
 * The safety guard refuses any path equal to or outside process.cwd(), so a stray
 * argument (for example `..`) cannot escalate into the source tree. Do not remove
 * that guard.
 *
 * @example
 *   node scripts/clean.mjs            // removes ./dist
 *   node scripts/clean.mjs dist lib   // removes ./dist and ./lib
 */

import { rmSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

const root = process.cwd();
const dirs = process.argv.slice(2);
const targets = dirs.length > 0 ? dirs : ['dist'];

for (const dir of targets)
{
    const abs = resolve(root, dir);

    if (abs === root || !abs.startsWith(root + sep))
    {
        console.error(`clean: refusing to remove ${ abs } (outside ${ root })`);
        process.exitCode = 1;
        continue;
    }

    if (existsSync(abs))
    {
        rmSync(abs, { recursive: true, force: true });
        console.log(`clean: removed ${ relative(root, abs) }`);
    }
}
