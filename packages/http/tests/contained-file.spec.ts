// @vitest-environment node
//
// The one containment rule, exercised directly. Three servers (static files, the kit's
// prerendered-page seed, the image endpoint) each carried a copy of it and the copies drifted:
// one followed a junction out of the dist, one joined its index outside the checked string, one
// served a hidden name through its 8.3 alias. Every arm here is a way a copy went wrong.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { containedFile } from '@azerothjs/http/node';

const made: string[] = [];
afterAll(async () =>
{
    for (const dir of made)
    {
        await rm(dir, { recursive: true, force: true });
    }
});

/**
 * A root with a public file, a hidden file, a hidden directory, a nested page, a `.well-known`
 * entry, and - one level ABOVE it - a secret that no spelling may reach.
 */
async function fixture(): Promise<{ base: string; root: string }>
{
    const base = await mkdtemp(path.join(tmpdir(), 'azeroth-contained-'));
    made.push(base);
    const root = path.join(base, 'root');
    await mkdir(path.join(root, 'docs', 'intro'), { recursive: true });
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.well-known'));
    await writeFile(path.join(base, 'secret.txt'), 'DB_PASSWORD=hunter2');
    await writeFile(path.join(root, 'public.txt'), 'nothing secret');
    await writeFile(path.join(root, '.env'), 'DB_PASSWORD=hunter2');
    await writeFile(path.join(root, '.git', 'config'), '[remote "origin"]');
    await writeFile(path.join(root, '.well-known', 'security.txt'), 'Contact: mailto:security@example');
    await writeFile(path.join(root, 'docs', 'intro', 'index.html'), '<h1>intro</h1>');
    return { base, root };
}

/** A directory junction (no privilege needed on Windows; a plain symlink elsewhere). */
const link = (target: string, at: string): Promise<void> => symlink(target, at, 'junction');

describe('containedFile refuses every spelling that leaves the root', () =>
{
    it('serves a plain file and refuses a NUL, a traversal and an absolute re-root', async () =>
    {
        const { base, root } = await fixture();
        expect((await containedFile(root, 'public.txt'))?.path).toBe(path.join(root, 'public.txt'));
        expect(await containedFile(root, 'public.txt\0')).toBeNull();
        expect(await containedFile(root, '../secret.txt')).toBeNull();
        expect(await containedFile(root, path.join(base, 'secret.txt'))).toBeNull();
    });

    it('a junction INSIDE the root that points outside it serves nothing through it', async () =>
    {
        const { base, root } = await fixture();
        const outside = path.join(base, 'outside');
        await mkdir(outside);
        await writeFile(path.join(outside, 'leak.txt'), 'DB_PASSWORD=hunter2');
        await link(outside, path.join(root, 'link'));
        // The logical path sits under the root; only the real path tells the truth.
        expect(await containedFile(root, 'link/leak.txt')).toBeNull();
        // Control: the same lookup on a directory that is really inside serves.
        expect((await containedFile(root, 'docs/intro/index.html'))?.path).toBe(path.join(root, 'docs', 'intro', 'index.html'));
    });

    it('a root that is ITSELF a junction still serves: real is compared against real', async () =>
    {
        const { base, root } = await fixture();
        const alias = path.join(base, 'alias');
        await link(root, alias);
        const found = await containedFile(alias, 'public.txt');
        expect(found?.path).toBe(path.join(alias, 'public.txt'));
        expect(found?.stats.isFile()).toBe(true);
        // And the real-root check still holds through the alias: an escape stays an escape.
        expect(await containedFile(alias, '../secret.txt')).toBeNull();
    });

    it('a hidden segment is refused on the spelled path, on either separator', async () =>
    {
        const { root } = await fixture();
        expect(await containedFile(root, '.env')).toBeNull();
        expect(await containedFile(root, '.git/config')).toBeNull();
        expect(await containedFile(root, '.git\\config')).toBeNull();
        expect(await containedFile(root, 'docs/../.git/config')).toBeNull();
        // `.well-known` is the one public hidden name (RFC 8615).
        expect((await containedFile(root, '.well-known/security.txt'))?.path).toBe(path.join(root, '.well-known', 'security.txt'));
        // Opting in serves them, alias and all.
        expect((await containedFile(root, '.env', { dotfiles: true }))?.path).toBe(path.join(root, '.env'));
    });

    it('a Windows 8.3 short name is not a way around the hidden rule', async (context) =>
    {
        const { root } = await fixture();
        // 8.3 alias generation is a per-volume Windows setting: where it is off there is no
        // alias to attack, and nothing here to assert.
        if (await realpath(path.join(root, 'ENV~1')).catch(() => null) === null)
        {
            context.skip();
        }
        for (const spelling of ['ENV~1', 'env~1', 'GIT~1/config'])
        {
            expect(await containedFile(root, spelling), spelling).toBeNull();
        }
        expect((await containedFile(root, 'ENV~1', { dotfiles: true }))?.path).toBe(path.join(root, 'ENV~1'));
    });

    it('the index is a path of its own: joined below the root and checked like one', async () =>
    {
        const { root } = await fixture();
        // A directory with no index is refused, not served.
        expect(await containedFile(root, 'docs/intro')).toBeNull();
        // A multi-segment relative index is what a page mount hands in, and it serves.
        expect((await containedFile(root, '', { index: 'docs/intro/index.html' }))?.path).toBe(path.join(root, 'docs', 'intro', 'index.html'));
        expect((await containedFile(root, 'docs/intro', { index: 'index.html' }))?.path).toBe(path.join(root, 'docs', 'intro', 'index.html'));
        // An index that escapes, or that is hidden, is refused even though the DIRECTORY was inside.
        expect(await containedFile(root, '', { index: '../secret.txt' })).toBeNull();
        expect(await containedFile(root, '', { index: '.env' })).toBeNull();
        expect(await containedFile(root, 'docs', { index: '../../secret.txt' })).toBeNull();
    });

    it('a root that lives under a dot directory serves: the hidden rule reads the path BELOW the root', async () =>
    {
        const base = await mkdtemp(path.join(tmpdir(), 'azeroth-contained-'));
        made.push(base);
        const root = path.join(base, '.cache', 'site');
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, 'public.txt'), 'served from under .cache');
        await writeFile(path.join(root, '.env'), 'DB_PASSWORD=hunter2');
        expect((await containedFile(root, 'public.txt'))?.path).toBe(path.join(root, 'public.txt'));
        // A real root handed in by a long-lived caller decides the same way.
        expect((await containedFile(root, 'public.txt', { realRoot: await realpath(root) }))?.path).toBe(path.join(root, 'public.txt'));
        // The rule still applies below it.
        expect(await containedFile(root, '.env')).toBeNull();
    });
});
