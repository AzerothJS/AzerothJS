// @vitest-environment node
//
// Coverage for the azeroth() Vite plugin's diagnostic severity routing: error-severity
// diagnostics FAIL the build (this.error), warning-severity diagnostics surface as warnings
// (this.warn) and let the build proceed, and non-.azeroth files pass through untouched. The
// transform is invoked directly with a mock plugin context (the real Rollup/Vite context's
// error() throws; warn() reports) - the error path short-circuits before any vite import.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { azeroth } from '@azerothjs/compiler';

type TransformFn = (this: unknown, code: string, id: string) => Promise<unknown>;

function transformOf(): TransformFn
{
    return azeroth().transform as unknown as TransformFn;
}

describe('azeroth() plugin — diagnostic severity routing', () =>
{
    it('FAILS the build for an error-severity diagnostic (a handler that runs at setup)', async () =>
    {
        // typeCheck off isolates the semantic-diagnostic gate; with it on, the same handler is
        // caught one step earlier as a type error (covered in the type-check gate suite below).
        const transform = azeroth({ typeCheck: false }).transform as unknown as TransformFn;
        const ctx =
        {
            warn: vi.fn(),
            error: (message: unknown): never =>
            {
                throw new Error(typeof message === 'string' ? message : String(message));
            }
        };
        const source = 'component C { state n = 0; <button onClick={n++}>x</button> }';
        await expect(transform.call(ctx, source, '/X.azeroth')).rejects.toThrow(/runs at setup/);
        // An error is not also reported as a warning.
        expect(ctx.warn).not.toHaveBeenCalled();
    });

    it('reports a warning-severity diagnostic without failing the build', async () =>
    {
        const transform = transformOf();
        const warnings: string[] = [];
        const ctx =
        {
            warn: (message: string): void =>
            {
                warnings.push(message);
            },
            error: (message: unknown): never =>
            {
                throw new Error(String(message));
            }
        };
        const source = 'component C { derived d = 1 + 2; <p>{d}</p> }';
        await expect(transform.call(ctx, source, '/X.azeroth')).resolves.toBeTruthy();
        expect(warnings.some((w) => w.includes('azeroth/constant-derived'))).toBe(true);
    });

    it('passes non-.azeroth files through untouched', async () =>
    {
        const transform = transformOf();
        const ctx = { warn: vi.fn(), error: vi.fn() };
        const result = await transform.call(ctx, 'const x = 1;', '/x.ts');
        expect(result).toBeNull();
    });
});

describe('azeroth() plugin — type-check gate (on by default)', () =>
{
    // `onClick={count}` is a TYPE-ONLY error: count is a number, not a function. The syntactic
    // guard cannot catch it (a bare identifier read is not assignment/++/call), so only the real
    // type-check gate rejects it.
    const TYPE_UNSAFE = 'component C { state count = 0; <button onClick={count}>x</button> }';
    const throwingCtx = (): { warn: ReturnType<typeof vi.fn>; error: (m: unknown) => never } => (
        {
            warn: vi.fn(),
            error: (message: unknown): never =>
            {
                throw new Error(String(message));
            }
        });

    it('FAILS the build for a non-function handler by default', async () =>
    {
        const transform = azeroth().transform as unknown as TransformFn;
        await expect(transform.call(throwingCtx(), TYPE_UNSAFE, '/X.azeroth')).rejects.toThrow(/azeroth\/handler-type/);
    });

    it('compiles the same type-unsafe handler when typeCheck is explicitly off', async () =>
    {
        const transform = azeroth({ typeCheck: false }).transform as unknown as TransformFn;
        await expect(transform.call(throwingCtx(), TYPE_UNSAFE, '/X.azeroth')).resolves.toBeTruthy();
    });

    it('compiles a well-typed handler', async () =>
    {
        const transform = azeroth().transform as unknown as TransformFn;
        const source = 'component C { state count = 0; <button onClick={() => count++}>x</button> }';
        await expect(transform.call(throwingCtx(), source, '/X.azeroth')).resolves.toBeTruthy();
    });
});

describe('azeroth() plugin — emitDeclarations mirror', () =>
{
    // With emitDeclarations on, the plugin writes a TypeScript projection of each `.azeroth` file into
    // a hidden `.azeroth/types/` mirror under the project root (never beside the source), so `.ts`
    // imports resolve + type-check without an editor plugin. OFF by default (opt-in).
    const ctx = { warn: vi.fn(), error: (m: unknown): never =>
    {
        throw new Error(String(m));
    } };
    const source = 'export default component C { state count = 0; <button onClick={() => count++}>{count}</button> }';

    it('writes the projection into .azeroth/types/ (both name forms), never beside the source', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-dts-'));
        try
        {
            const plugin = azeroth({ emitDeclarations: true, typeCheck: false });
            (plugin.configResolved as (r: { root?: string }) => void)({ root: dir });
            await (plugin.transform as unknown as TransformFn).call(ctx, source, join(dir, 'Widget.azeroth'));
            // `Widget.d.ts` resolves `import W from './Widget'`; `Widget.azeroth.d.ts` resolves the
            // explicit `./Widget.azeroth` - both under the hidden mirror, not in the source tree.
            const plain = join(dir, '.azeroth', 'types', 'Widget.d.ts');
            const explicit = join(dir, '.azeroth', 'types', 'Widget.azeroth.d.ts');
            expect(existsSync(plain)).toBe(true);
            expect(existsSync(explicit)).toBe(true);
            const text = readFileSync(plain, 'utf8');
            expect(text).toContain('C');
            expect(text).toContain('export default');
            expect(readFileSync(explicit, 'utf8')).toBe(text);
            // The source directory stays clean - nothing written beside Widget.azeroth.
            expect(existsSync(join(dir, 'Widget.d.ts'))).toBe(false);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does NOT write a mirror by default (opt-in only)', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-dts-'));
        try
        {
            const plugin = azeroth({ typeCheck: false });
            (plugin.configResolved as (r: { root?: string }) => void)({ root: dir });
            await (plugin.transform as unknown as TransformFn).call(ctx, source, join(dir, 'Widget.azeroth'));
            expect(existsSync(join(dir, '.azeroth'))).toBe(false);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
