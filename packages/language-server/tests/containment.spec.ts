// @vitest-environment node
//
// A `.azeroth` file inside a cloned repository is untrusted input. The module resolvers took an
// import specifier out of one and handed `path.resolve(dirname(importer), specifier)` straight to
// the filesystem, with no containment: `import x from '../../../../secret.azeroth'` was resolved,
// read, compiled, and its string literals surfaced in a hover tooltip. An absolute specifier was
// admitted outright, because the "is this relative" test accepted a leading '/'.
//
// The same repo does this correctly one package over - `@azerothjs/http`'s static handler checks
// prefix containment on the resolved path AND on what the filesystem really resolved, so an
// in-tree symlink cannot point out of the tree. This is that check, applied to the editor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { containedPath, containedSibling } from '../src/language-service/containment.ts';
import { uriToPath } from '../src/language-service/uri.ts';

let base: string;
let root: string;
let importer: string;

beforeAll(() =>
{
    base = mkdtempSync(path.join(tmpdir(), 'azeroth-containment-'));
    root = path.join(base, 'project');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    importer = path.join(root, 'src', 'App.azeroth');
    writeFileSync(importer, 'component A() { <div>x</div> }');
    writeFileSync(path.join(root, 'src', 'Sibling.azeroth'), 'component B() { <div>y</div> }');
    writeFileSync(path.join(base, 'Secret.azeroth'), 'export const KEY = "sk-live-DEADBEEF";');
});

afterAll(() =>
{
    rmSync(base, { recursive: true, force: true });
});

describe('containedSibling', () =>
{
    it('resolves a real sibling inside the project', () =>
    {
        expect(containedSibling(root, importer, './Sibling.azeroth')).toBe(path.join(root, 'src', 'Sibling.azeroth').replace(/\\/g, '/'));
    });

    it.each([
        '../../Secret.azeroth',
        '../../../Secret.azeroth',
        '../../../../../../../../etc/passwd.azeroth'
    ])('refuses the traversal %s', (specifier) =>
    {
        expect(containedSibling(root, importer, specifier)).toBeNull();
    });

    it('refuses an absolute specifier', () =>
    {
        expect(containedSibling(root, importer, path.join(base, 'Secret.azeroth'))).toBeNull();
    });

    it('allows a path that does not exist yet, as long as it is inside', () =>
    {
        // Nothing to disclose, and the editor must still resolve a file the user is about to add.
        expect(containedSibling(root, importer, './NotYet.azeroth')).not.toBeNull();
    });
});

describe('uriToPath resolves dot-segments the encoding hid', () =>
{
    it('collapses an ENCODED traversal, which only becomes one after decoding', () =>
    {
        // `%2e%2e` passes any pre-decode `..` check untouched; this is the only point where it
        // is visible as a traversal, and the result goes straight to the filesystem.
        expect(uriToPath('file:///project/%2e%2e/%2e%2e/etc/passwd')).toBe('/etc/passwd');
        expect(uriToPath('file:///project/src/%2E%2E/App.azeroth')).toBe('/project/App.azeroth');
    });

    it('collapses a plain traversal too', () =>
    {
        expect(uriToPath('file:///a/b/../c/App.azeroth')).toBe('/a/c/App.azeroth');
        expect(uriToPath('file:///a/./b/App.azeroth')).toBe('/a/b/App.azeroth');
    });

    it('never climbs above the root', () =>
    {
        expect(uriToPath('file:///../../../etc/passwd')).toBe('/etc/passwd');
    });

    it('leaves an ordinary path alone', () =>
    {
        expect(uriToPath('file:///project/src/App.azeroth')).toBe('/project/src/App.azeroth');
        expect(uriToPath('/already/a/path.azeroth')).toBe('/already/a/path.azeroth');
    });

    it('still handles a Windows drive URI', () =>
    {
        expect(uriToPath('file:///c%3A/app/App.azeroth')).toBe('c:/app/App.azeroth');
    });
});

describe('containedPath', () =>
{
    it('accepts the root itself and rejects a sibling directory with a shared prefix', () =>
    {
        expect(containedPath(root, root)).not.toBeNull();
        // `/project-evil` must not pass a naive `startsWith('/project')` test.
        expect(containedPath(root, `${ root }-evil/x.azeroth`)).toBeNull();
    });

    it('refuses a symlink that points out of the tree', () =>
    {
        const link = path.join(root, 'src', 'escape.azeroth');
        try
        {
            symlinkSync(path.join(base, 'Secret.azeroth'), link);
        }
        catch
        {
            return; // symlink creation needs privileges on some Windows configurations
        }

        // The LOGICAL path is inside the project; only the real path reveals the escape.
        expect(containedPath(root, link.replace(/\\/g, '/'))).toBeNull();
    });
});
