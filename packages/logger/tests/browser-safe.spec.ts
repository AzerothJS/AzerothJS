// @vitest-environment node
//
// Locks the browser-safety contract: the main `@azerothjs/logger` entry must load in a
// browser bundle (createLogger for structured console output), so nothing in its module
// graph may statically import a Node builtin. The file sinks (node:fs/node:path) and the
// terminal prompts (node:readline) live at `@azerothjs/logger/node` instead. This guards
// against the regression where the barrel re-exported those and dragged node:path into
// client code (a Vite "Module node:path has been externalized" crash).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import * as barrel from '../src/index.ts';
import * as nodeEntry from '../src/node.ts';

describe('browser-safe barrel', () =>
{
    it('the main entry exposes the browser-safe surface and NOT the node-only pieces', () =>
    {
        for (const name of ['createLogger', 'teeSink', 'consoleSink', 'prettySink', 'ndjsonSink', 'printBanner', 'colorTier'])
        {
            expect(name in barrel, `the barrel should export ${ name }`).toBe(true);
        }
        for (const name of ['fileSink', 'fileStream', 'select', 'textInput', 'intro', 'outro'])
        {
            expect(name in barrel, `the barrel must NOT export the node-only ${ name }`).toBe(false);
        }
    });

    it('the ./node entry exposes the node-only pieces', () =>
    {
        for (const name of ['fileStream', 'fileSink', 'select', 'textInput', 'intro', 'outro'])
        {
            expect(name in nodeEntry, `the ./node entry should export ${ name }`).toBe(true);
        }
    });

    it('no browser-facing source module statically imports a Node builtin', () =>
    {
        const src = join(import.meta.dirname, '..', 'src');
        // Every module reachable from the barrel's graph. file.ts and prompt.ts are NOT here:
        // they carry the node: imports and are reachable only through the ./node entry.
        for (const file of ['index.ts', 'logger.ts', 'sinks.ts', 'banner.ts', 'color.ts', 'serialize.ts', 'record.ts', 'prompt-face.ts'])
        {
            let text: string;
            try
            {
                text = readFileSync(join(src, file), 'utf8');
            }
            catch
            {
                continue; // optional module - skip if it does not exist
            }
            expect(/from ['"]node:/.test(text), `${ file } is in the browser barrel's graph and must not import a node: builtin`).toBe(false);
        }
    });
});
