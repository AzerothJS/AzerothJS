// invalidateDiskCache(): a watched-file CONTENT change to an existing file must
// be re-read even when that file is CLOSED. Disk mtimes are memoized per
// project-version epoch, so without a version bump TypeScript serves stale types
// - this guards that the cheap content-change path (no full workspace rescan)
// still invalidates correctly. The closed dependency here is a `.ts` file an open
// `.azeroth` component imports, so a type change on disk flips the component's
// diagnostics only once the cache is invalidated.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;
let helperPath: string;
let ls: AzerothLanguageService;
let appUri: string;

const APP = [
    'import { greet } from \'./helper\';',
    'const n: number = greet();',
    'export default () => <div>{n}</div>;'
].join('\n');

beforeAll(() =>
{
    dir = fs.mkdtempSync(path.join(tmpdir(), 'azeroth-disk-'));
    helperPath = path.join(dir, 'helper.ts');
    // greet returns number, so `const n: number = greet()` type-checks cleanly.
    fs.writeFileSync(helperPath, 'export const greet = (): number => 1;\n');

    ls = new AzerothLanguageService(dir);
    appUri = pathToUri(path.join(dir, 'App.azeroth'));
    ls.didOpen(appUri, APP);
});

afterAll(() =>
{
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Count of type-assignability errors in the open component. */
function typeErrors(): number
{
    return ls.getDiagnostics(appUri).filter(d => /not assignable/i.test(d.message)).length;
}

describe('invalidateDiskCache', () =>
{
    it('reads a closed dependency cleanly at first', () =>
    {
        expect(typeErrors()).toBe(0);
    });

    it('does NOT see a closed-file change until the cache is invalidated', () =>
    {
        // greet now returns string -> `const n: number = greet()` is a type error.
        fs.writeFileSync(helperPath, 'export const greet = (): string => \'hi\';\n');
        // Force a strictly-newer mtime so the change is unambiguous once re-stat'd
        // (two writes in the same millisecond would otherwise share a version).
        const future = new Date(4070908800000); // 2099-01-01
        fs.utimesSync(helperPath, future, future);

        // Without a version bump the memoized mtime still points at the old read,
        // so the component is unchanged: stale, by design.
        expect(typeErrors()).toBe(0);
    });

    it('picks up the closed-file change after invalidateDiskCache()', () =>
    {
        ls.invalidateDiskCache();
        expect(typeErrors()).toBe(1);
    });
});
