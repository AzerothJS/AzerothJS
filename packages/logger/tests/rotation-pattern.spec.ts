// @vitest-environment node
//
// Folder-mode retention builds its match pattern by interpolating the configured `name` straight
// into a RegExp, and that pattern decides which files `#prune` passes to `unlinkSync`. An
// unescaped name is therefore a pattern, not a literal: `[a-c]` matches `a-`, `b-` and `c-`, so
// the sink deletes files that belong to other writers sharing the directory.
//
// This is NOT remotely exploitable - `name` is developer configuration, never request data - and
// nobody types `[a-c]`. It is fixed because escaping an interpolated value is free and correct,
// and because the realistic spelling is subtler: a service named `api.v2` yields `^api.v2-`,
// whose `.` quietly matches any character in that position. A name should select the sink's own
// files and nothing else, whatever characters it happens to contain.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileStream } from '../src/node.ts';

const dirs: string[] = [];

afterEach(() =>
{
    for (const dir of dirs.splice(0))
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function directoryWith(files: string[]): string
{
    const dir = mkdtempSync(path.join(tmpdir(), 'azeroth-log-'));
    dirs.push(dir);
    for (const file of files)
    {
        writeFileSync(path.join(dir, file), '{}\n');
    }
    return dir;
}

/** Writes one line and lets the sink settle so rotation/pruning has run. */
async function writeAndClose(stream: { write(chunk: string): void; close?: () => void }): Promise<void>
{
    stream.write('{"event":"x"}\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    stream.close?.();
    await new Promise((resolve) => setTimeout(resolve, 150));
}

describe('retention treats the configured name as a literal', () =>
{
    it('never prunes a file belonging to another writer in the same folder', async () =>
    {
        const dir = directoryWith(['a-2026-07-01.ndjson', 'b-2026-07-02.ndjson', 'c-2026-07-03.ndjson']);

        await writeAndClose(fileStream(dir, { name: '[a-c]', maxFiles: 1 }));

        const remaining = readdirSync(dir);
        expect(remaining).toContain('a-2026-07-01.ndjson');
        expect(remaining).toContain('b-2026-07-02.ndjson');
        expect(remaining).toContain('c-2026-07-03.ndjson');
    });

    it('does not let a dot in the name match a neighbour', async () =>
    {
        // `api.v2` is an ordinary service name; unescaped it yields `^api.v2-`, and the `.`
        // matches any character - so `apiXv2-...` becomes a deletion candidate.
        const dir = directoryWith(['apiXv2-2026-07-01.ndjson', 'apiYv2-2026-07-02.ndjson']);

        await writeAndClose(fileStream(dir, { name: 'api.v2', maxFiles: 1 }));

        const remaining = readdirSync(dir);
        expect(remaining).toContain('apiXv2-2026-07-01.ndjson');
        expect(remaining).toContain('apiYv2-2026-07-02.ndjson');
    });

    it('still prunes its OWN older files past the limit', async () =>
    {
        const dir = directoryWith(['keep-2026-07-01.ndjson', 'keep-2026-07-02.ndjson', 'keep-2026-07-03.ndjson']);

        await writeAndClose(fileStream(dir, { name: 'keep', maxFiles: 1 }));

        // Retention must still work: the sink's own older files go, or the fix broke pruning.
        const own = readdirSync(dir).filter((entry) => entry.startsWith('keep-'));
        expect(own.length).toBeLessThan(4);
    });
});
