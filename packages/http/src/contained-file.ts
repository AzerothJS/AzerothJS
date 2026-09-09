/**
 * The one containment rule for serving a file from under a directory.
 *
 * Three servers in the framework map a client-spelled path onto a file and must never
 * serve one outside their root: the static file handler, the kit's prerendered-page seed
 * lookup and its image endpoint. Each carried its own copy of the rule and the copies
 * drifted - one skipped the real-path check and followed a junction out of the dist,
 * one joined its index outside the checked string, one had no `.well-known` exemption.
 * This is the rule, once, with every caller reading the same decision.
 *
 * The decision is taken in this order, and a refusal at any step is `null`:
 *
 *   1. a NUL anywhere in the spelled path;
 *   2. the dotfile rule on the SPELLED path, split on both separators;
 *   3. logical containment: the resolved path lies under the root as a string;
 *   4. a stat; a directory takes the `index` join, then the dotfile rule and the
 *      containment check again on the joined path BELOW the root, and a second stat;
 *   5. anything but a regular file;
 *   6. real containment: the target's real path lies under the root's real path, so an
 *      in-root symlink or junction pointing outside cannot leak what it points at;
 *   7. the dotfile rule on the REAL path below the REAL root - a Windows 8.3 short name
 *      (`ENV~1` for `.env`) and a symlink are other spellings of a hidden file.
 *
 * Steps 4 and 7 inspect the path BELOW the root, never the absolute path: a root that itself
 * lives under a dot directory (`.cache`, a package store, a home `.local`) must serve.
 */

import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** How a directory and a hidden name are treated; the containment itself is not optional. */
export interface ContainedFileOptions
{
    /**
     * Served when the path resolves to a directory. May be a multi-segment RELATIVE path
     * (a page mount puts the whole served path here); it is joined inside and re-checked
     * segment by segment. Omit to refuse a directory.
     */
    index?: string;

    /**
     * Serve a segment beginning with `.`. Default `false`: `/.env`, `/.git/config` and every
     * hidden name are refused, on the spelled path and on the resolved one. `.well-known` is
     * ALWAYS served (RFC 8615 reserves it as a public path).
     */
    dotfiles?: boolean;

    /**
     * The root's real path when the caller resolved it once already (a long-lived handler
     * does, at boot); otherwise it is resolved per call. A root that does not resolve is
     * used as spelled.
     */
    realRoot?: string;
}

/** The file the rule admitted: its logical path and the stat that proved it a file. */
export interface ContainedFile
{
    path: string;
    stats: Stats;
}

/**
 * @internal Does the path below a root contain a hidden segment (one starting with `.`)?
 * `.well-known` is exempt - RFC 8615 reserves it as a public, servable path. `.` and `..`
 * are moot here (containment already handles them) but count as hidden too.
 */
export function hasDotSegment(relative: string): boolean
{
    for (const segment of relative.split(/[/\\]/))
    {
        if (segment.startsWith('.') && segment !== '.well-known')
        {
            return true;
        }
    }
    return false;
}

/**
 * @internal The directory as a containment prefix. A volume root (`/`, `C:\`) already ends
 * in the separator; appending another would double it and no resolved path could ever match.
 */
export function asPrefix(dir: string): string
{
    return dir.endsWith(sep) ? dir : dir + sep;
}

/** @internal Is `path` the directory itself or somewhere under it? */
function under(path: string, dir: string): boolean
{
    return path === dir || path.startsWith(asPrefix(dir));
}

/**
 * The file `relative` names under `rootDir`, or `null` when the rule refuses it. `rootDir`
 * is resolved here (a relative root binds to the working directory at the call).
 */
export async function containedFile(
    rootDir: string,
    relative: string,
    options: ContainedFileOptions = {}
): Promise<ContainedFile | null>
{
    const root = resolve(rootDir);
    const hidden = options.dotfiles !== true;
    if (relative.includes('\0') || (hidden && hasDotSegment(relative)))
    {
        return null;
    }

    // Everything a router decoded (including smuggled separators) is literal here, so one
    // prefix check on the resolved string covers every traversal spelling.
    let target = resolve(root, relative);
    if (!under(target, root))
    {
        return null;
    }

    let info = await stat(target).catch(() => null);
    if (info?.isDirectory() === true)
    {
        if (options.index === undefined)
        {
            return null;
        }
        // The index is a path of its own and is checked as one: the SAME rules, on the joined
        // string below the root, before the filesystem is asked about it.
        target = join(target, options.index);
        if (!under(target, root) || (hidden && hasDotSegment(target.slice(root.length))))
        {
            return null;
        }
        info = await stat(target).catch(() => null);
    }
    if (info === null || !info.isFile())
    {
        return null;
    }

    // The string checks only prove the LOGICAL path is under the root; a symlink component can
    // still point outside. The real path must stay contained - real against real, since the
    // filesystem may spell the root itself through an alias.
    const realRoot = options.realRoot ?? await realpath(root).catch(() => root);
    const realTarget = await realpath(target).catch(() => null);
    if (realTarget === null || !under(realTarget, realRoot))
    {
        return null;
    }

    // The dotfile rule belongs to the path the filesystem RESOLVED, not the one the client
    // spelled: Windows hands out 8.3 aliases that stat and open honor, and a symlink is another
    // spelling of the same file. Below the real root only - the root's own segments are the
    // deployment's business, not the request's.
    if (hidden && hasDotSegment(realTarget.slice(realRoot.length)))
    {
        return null;
    }

    return { path: target, stats: info };
}
