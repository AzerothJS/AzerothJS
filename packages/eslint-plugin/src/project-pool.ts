// A pool of AzerothProjects, one per resolved workspace root (the directory of the nearest tsconfig).
//
// This is how type-aware ESLint rules work on `.azeroth` without building a SECOND TypeScript program:
// the language service's `AzerothProject` already hosts a `ts.LanguageService` whose program includes
// every `.azeroth` file's virtual twin (with full types, cross-file resolution, and the project's own
// `lib`/ambient declarations). The ESLint parser borrows THAT program. One project per root, reused
// across every file in a lint run, so the (one-time) program build is amortised - the same model the
// language server uses.

import ts from 'typescript';
import { posix, resolve } from 'node:path';
import { AzerothProject } from '@azerothjs/language-server/language-service';

const pool = new Map<string, AzerothProject>();

/** Resident project ceiling; each is its own TS program. See projectFor. */
const MAX_PROJECTS = 8;

/**
 * Absolute, forward-slashed form of a path. Resolving to absolute (against cwd) AND forward-slashing
 * means the document registered by the processor and the file looked up by the parser key to the SAME
 * project and virtual-twin name, whether ESLint handed us an absolute or a relative, `\\`- or `/`-path.
 */
export function normalize(filePath: string): string
{
    return resolve(filePath).replace(/\\/g, '/');
}

/** The directory of the nearest enclosing tsconfig.json, or the file's own directory as a fallback. */
function rootFor(filePath: string): string
{
    const dir = posix.dirname(normalize(filePath));
    const config = ts.findConfigFile(dir, (p) => ts.sys.fileExists(p), 'tsconfig.json');
    return normalize(config ? posix.dirname(config) : dir);
}

/**
 * The AzerothProject for `filePath`'s workspace, created lazily and cached for reuse.
 *
 * Bounded, least-recently-used first. Each project is a full TS program; the pool is
 * module-level and used to have no eviction at all, so linting a repository with many package
 * directories held one program per tsconfig root for the whole run.
 */
export function projectFor(filePath: string): AzerothProject
{
    const root = rootFor(filePath);
    const existing = pool.get(root);
    if (existing !== undefined)
    {
        // Re-insert so Map's insertion order is recency order, not first-seen order.
        pool.delete(root);
        pool.set(root, existing);
        return existing;
    }

    const project = new AzerothProject(root);
    pool.set(root, project);
    while (pool.size > MAX_PROJECTS)
    {
        const oldest = pool.keys().next();
        if (oldest.done === true)
        {
            break;
        }
        pool.delete(oldest.value);
    }
    return project;
}

/** Registers (or updates) a `.azeroth` document so its virtual twin joins the program. */
export function registerDocument(azerothPath: string, source: string): void
{
    projectFor(azerothPath).openDocument(normalize(azerothPath), source);
}
