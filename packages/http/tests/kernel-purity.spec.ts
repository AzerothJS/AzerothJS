// @vitest-environment node
//
// The kernel-purity weld: the "." entry of @azerothjs/http must stay a pure
// fetch-standard kernel - importable on Cloudflare Workers, Deno Deploy, and Vercel
// Edge. Statically walks the module graph reachable from src/index.ts and asserts no
// `node:*` import exists ANYWHERE in it, with exactly one documented exception:
// request-root.ts's node:async_hooks (AsyncLocalStorage), the deliberately-portable
// choice implemented by Bun, Deno, and workerd. Everything genuinely Node-only
// (sockets, fs, zlib) must live behind the ./node subpath - adding a node: import to
// a kernel module fails HERE, not in a user's edge deploy.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** The single sanctioned node: import in the kernel graph. */
const ALLOWED: ReadonlyArray<{ file: string; specifier: string }> = [
    { file: 'request-root.ts', specifier: 'node:async_hooks' }
];

function importsOf(file: string): string[]
{
    const source = readFileSync(join(SRC, file), 'utf8');
    return [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
}

/** Resolves a relative specifier against the importing file's directory (SRC-relative paths). */
function resolveSpecifier(fromFile: string, specifier: string): string
{
    const parts = fromFile.split('/').slice(0, -1);
    for (const segment of specifier.split('/'))
    {
        if (segment === '.')
        {
            continue;
        }
        if (segment === '..')
        {
            parts.pop();
        }
        else
        {
            parts.push(segment);
        }
    }
    return parts.join('/');
}

/** Walks the SRC-relative module graph from `entry`; returns files seen + node: violations. */
function walkGraph(entry: string): { seen: Set<string>; violations: string[] }
{
    const seen = new Set<string>();
    const queue = [entry];
    const violations: string[] = [];
    while (queue.length > 0)
    {
        const file = queue.pop() as string;
        if (seen.has(file))
        {
            continue;
        }
        seen.add(file);
        for (const specifier of importsOf(file))
        {
            if (specifier.startsWith('node:'))
            {
                const sanctioned = ALLOWED.some((a) => a.file === file && a.specifier === specifier);
                if (!sanctioned)
                {
                    violations.push(`${ file } imports ${ specifier }`);
                }
            }
            else if (specifier.startsWith('.'))
            {
                queue.push(resolveSpecifier(file, specifier));
            }
        }
    }
    return { seen, violations };
}

describe('the fetch-standard kernel', () =>
{
    it('the "." module graph carries no node:* import beyond the AsyncLocalStorage seam', () =>
    {
        const { seen, violations } = walkGraph('index.ts');
        expect(violations).toEqual([]);
        expect(seen.size).toBeGreaterThan(10); // the walk genuinely covered the kernel
        // The node-only modules must NOT be reachable from the kernel entry at all.
        for (const nodeOnly of ['adapter-node.ts', 'static.ts', 'compress.ts'])
        {
            expect(seen.has(nodeOnly), `${ nodeOnly } must stay behind ./node`).toBe(false);
        }
    });

    it('the ./api contract layer is kernel-pure too (contracts mount on edge runtimes)', () =>
    {
        const { violations } = walkGraph('api/index.ts');
        expect(violations).toEqual([]);
    });

    it('the ./api/shared entry never reaches server code', () =>
    {
        const { seen, violations } = walkGraph('api/shared-entry.ts');
        expect(violations).toEqual([]);
        for (const serverOnly of ['api/feature.ts', 'api/register.ts', 'api/openapi.ts', 'api/explorer.ts'])
        {
            expect(seen.has(serverOnly), `${ serverOnly } must never enter a browser bundle`).toBe(false);
        }
    });

    it('an App is a bare WinterCG fetch function by binding handle', async () =>
    {
        // `toFetchHandler(app)` was `app.handle.bind(app)` and nothing else, so it is gone.
        const { App, json } = await import('../src/index.ts');
        const app = new App();
        app.get('/hello', () => json({ hi: true }));
        const fetchFn = app.handle.bind(app);
        const response = await fetchFn(new Request('http://edge.local/hello'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ hi: true });
    });
});
