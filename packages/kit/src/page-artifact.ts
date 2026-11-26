/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { containedFile } from '@azerothjs/http/node';

const codings = /(?:\.(?:br|gz))+$/i;
const pageIndex = /^index(?:\.[^./\\]+)?\.html$/;

/** @internal Check the logical and canonical filenames supplied by the static server at selection. */
export async function isPageArtifact(
    clientDir: string, file: string, realFile: string, ownsPageFile: (url: string) => boolean
): Promise<boolean>
{
    const root = await realpath(clientDir).catch(() => null);
    if (root === null)
    {
        return true;
    }
    const logical = relative(clientDir, file);
    const physical = relative(root, realFile);
    // The immutable mount has its own root. A filesystem alias still has to satisfy the
    // public client directory's containment and dotfile rules.
    if (logical !== physical && (await containedFile(clientDir, logical, { realRoot: root }))?.realPath !== realFile)
    {
        return true;
    }
    const ownsDirectory = (directory: string): boolean =>
        ownsPageFile('/' + relative(root, directory).split(sep).map(encodeURIComponent).join('/'));
    const owned = (name: string): boolean => pageIndex.test(basename(name).replace(codings, '')) && ownsDirectory(dirname(name));
    if (owned(realFile))
    {
        return true;
    }

    // An explicitly named page encoding can exist without its original, even if the stored
    // bytes live under another filename. Resolve its directory in the same namespace as routes.
    if (logical !== physical && codings.test(file) && pageIndex.test(basename(file).replace(codings, '')))
    {
        const directory = await realpath(dirname(file)).catch(() => null);
        if (directory === null || (join(directory, basename(file)) !== realFile && ownsDirectory(directory)))
        {
            return true;
        }
    }
    // A stored copy and its source may each use an alias. Check the identity file beside
    // both spellings, when present, including a source whose own name resolves to a page.
    const realIdentity = realFile.replace(codings, '');
    for (const name of new Set([logical, physical]))
    {
        const identity = name.replace(codings, '');
        if (identity !== name)
        {
            const source = await containedFile(clientDir, identity, { realRoot: root });
            if (source !== null && source.realPath !== realIdentity && owned(source.realPath))
            {
                return true;
            }
        }
    }
    return false;
}
