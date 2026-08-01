// @vitest-environment node
//
// The pool is module-level: without eviction it holds one full TS program per tsconfig root
// encountered, for the life of the process, so linting a repository with many package
// directories grows without bound. The language server's service map and the tsserver plugin's
// compiled-file cache guard against the same growth shape.
//
// Eviction is observable here without measuring memory, because the pool returns the SAME object
// for a cached root: identity changing across two calls with no source edit in between means the
// entry was dropped and rebuilt. That is the only externally visible consequence of the bound,
// and it is what these tests pin - including the part that makes it LRU rather than FIFO, which
// is the part a naive implementation gets wrong.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { projectFor } from '../src/project-pool.ts';

/** Matches MAX_PROJECTS in the pool. */
const BOUND = 8;

let base: string;

/** A distinct tsconfig root, so each one keys its own project. */
function rootAt(name: string): string
{
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }');
    writeFileSync(path.join(dir, 'App.azeroth'), 'component A() { <div>x</div> }');
    return path.join(dir, 'App.azeroth');
}

beforeAll(() =>
{
    base = mkdtempSync(path.join(tmpdir(), 'azeroth-pool-'));
});

afterAll(() =>
{
    rmSync(base, { recursive: true, force: true });
});

describe('the project pool is bounded', () =>
{
    it('reuses the project for a root it already holds', () =>
    {
        const file = rootAt('reuse');

        expect(projectFor(file)).toBe(projectFor(file));
    });

    it('drops the least recently used root once the bound is passed', () =>
    {
        const victim = rootAt('victim');
        const first = projectFor(victim);

        // Fill past the bound without ever touching `victim` again.
        for (let i = 0; i < BOUND; i++)
        {
            projectFor(rootAt(`filler-${ i }`));
        }

        expect(projectFor(victim)).not.toBe(first);
    });

    it('keeps a root alive when it is used, which is what makes it LRU and not FIFO', () =>
    {
        const kept = rootAt('kept');
        const first = projectFor(kept);

        // Same pressure as above, but `kept` is touched each round, so it must never be the
        // least-recently-used entry and must never be evicted.
        for (let i = 0; i < BOUND; i++)
        {
            projectFor(rootAt(`churn-${ i }`));
            projectFor(kept);
        }

        expect(projectFor(kept)).toBe(first);
    });
});
