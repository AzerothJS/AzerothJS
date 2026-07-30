/**
 * MODULE: language-service/containment - the editor's trust boundary
 *
 * A `.azeroth` file inside a repository someone cloned is untrusted input, exactly like a request
 * path. The module resolvers used to hand `path.resolve(dirname(importer), specifier)` straight to
 * `ts.sys.readFile`, so `import x from '../../../../secrets.azeroth'` read - and compiled, and
 * surfaced in a hover - a file outside the project. This is the check that was missing, shaped
 * after the one `@azerothjs/http`'s static handler already applies to a request path: containment
 * on the RESOLVED string, then containment again on what the filesystem actually resolved, so an
 * in-tree symlink cannot point out of the tree.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Forward slashes, no trailing separator - the form TypeScript uses internally. */
function normalize(value: string): string
{
    const slashed = value.replace(/\\/g, '/');
    return slashed.length > 1 && slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
}

/**
 * Whether `candidate` is `root` or sits underneath it. Compared case-insensitively on Windows,
 * where `C:/Project` and `c:/project` are the same directory and a case-flipped spelling would
 * otherwise walk straight past a case-sensitive prefix test.
 */
function isUnder(candidate: string, root: string): boolean
{
    const a = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    const b = process.platform === 'win32' ? root.toLowerCase() : root;
    return a === b || a.startsWith(`${ b }/`);
}

/**
 * The resolved path if it stays inside `root`, else null.
 *
 * The string check proves the LOGICAL path is contained; `realpath` then proves the REAL one is,
 * which is what stops an in-root symlink from serving a file outside. A path that does not exist
 * yet has no real path to check, so the string result stands - it cannot be read anyway.
 *
 * @param root - The project root the editor is allowed to read from.
 * @param candidate - An already-resolved absolute path.
 */
export function containedPath(root: string, candidate: string): string | null
{
    const normalizedRoot = normalize(root);
    const resolved = normalize(candidate);

    if (normalizedRoot === '' || !isUnder(resolved, normalizedRoot))
    {
        return null;
    }

    let real: string;
    try
    {
        real = normalize(realpathSync(resolved));
    }
    catch
    {
        return resolved; // does not exist: nothing to disclose
    }

    let realRoot: string;
    try
    {
        realRoot = normalize(realpathSync(normalizedRoot));
    }
    catch
    {
        realRoot = normalizedRoot;
    }

    return isUnder(real, realRoot) ? resolved : null;
}

/**
 * Resolves `specifier` against the importer's directory and returns it only if it stays inside
 * `root`. The one call both resolvers make.
 *
 * @param root - The project root.
 * @param containingFile - The importing file.
 * @param specifier - The import specifier, attacker-controlled.
 */
export function containedSibling(root: string, containingFile: string, specifier: string): string | null
{
    return containedPath(root, path.resolve(path.dirname(containingFile), specifier));
}
