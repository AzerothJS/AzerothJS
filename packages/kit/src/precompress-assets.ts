/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, type BigIntStats } from 'node:fs';
import { lstat, readdir, rename, rm, utimes } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';

// Client build assets only. A static page can itself have a route under /assets.
const extensions = new Set(['.css', '.js', '.mjs', '.json', '.map', '.txt', '.xml', '.svg', '.wasm']);

/** Publish each complete encoding by rename so a failed build cannot expose a truncated stream. */
async function writeVariant(file: string, source: BigIntStats, coding: 'br' | 'gz'): Promise<void>
{
    const destination = `${ file }.${ coding }`;
    const temporary = `${ destination }.${ randomUUID() }.tmp`;
    try
    {
        const encoder = coding === 'gz'
            ? createGzip({ level: 9 })
            : createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
        await pipeline(createReadStream(file), encoder, createWriteStream(temporary, { flags: 'wx' }));
        // Keep the variant's own modification time for revalidation. If the source
        // came from a host whose clock is ahead, round up for the filesystem's precision.
        if ((await lstat(temporary, { bigint: true })).mtimeNs < source.mtimeNs)
        {
            const timestamp = Number(source.mtimeMs + 1n) / 1000;
            await utimes(temporary, timestamp, timestamp);
        }
        const current = await lstat(file, { bigint: true });
        if (current.dev !== source.dev || current.ino !== source.ino || current.size !== source.size
            || current.mtimeNs !== source.mtimeNs || current.ctimeNs !== source.ctimeNs)
        {
            throw new Error(`kit prerender: asset changed during compression: ${ file }`);
        }
        await rename(temporary, destination);
    }
    finally
    {
        await rm(temporary, { force: true });
    }
}

async function compressDirectory(directory: string): Promise<void>
{
    for (const entry of await readdir(directory, { withFileTypes: true }))
    {
        const file = join(directory, entry.name);
        if (entry.isDirectory())
        {
            await compressDirectory(file);
        }
        else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase()))
        {
            const source = await lstat(file, { bigint: true });
            if (source.isFile())
            {
                await writeVariant(file, source, 'br');
                await writeVariant(file, source, 'gz');
            }
        }
    }
}

/** @internal Generate the variants served by the immutable /assets mount after prerendering. */
export async function precompressAssets(clientDir: string): Promise<void>
{
    const directory = join(clientDir, 'assets');
    // Some apps emit no assets. A linked assets directory belongs to a different build tree.
    if (lstatSync(directory, { throwIfNoEntry: false })?.isDirectory())
    {
        await compressDirectory(directory);
    }
}
