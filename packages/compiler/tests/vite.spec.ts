// @vitest-environment node
//
// Coverage for the azeroth() Vite plugin's diagnostic severity routing: error-severity
// diagnostics FAIL the build (this.error), warning-severity diagnostics surface as warnings
// (this.warn) and let the build proceed, and non-.azeroth files pass through untouched. The
// transform is invoked directly with a mock plugin context (the real Rollup/Vite context's
// error() throws; warn() reports) - the error path short-circuits before any vite import.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { azeroth } from '@azerothjs/compiler';
import { azerothDepScanPlugin } from '../src/vite.ts';

type TransformFn = (this: unknown, code: string, id: string) => Promise<unknown>;

function transformOf(): TransformFn
{
    return azeroth().transform as unknown as TransformFn;
}

describe('azeroth() plugin - diagnostic severity routing', () =>
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
        const source = 'component C { state n = 0; <button onClick={ n++ }>x</button> }';
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

describe('azeroth() plugin - type-check gate (on by default)', () =>
{
    // `onClick={count}` is a TYPE-ONLY error: count is a number, not a function. The syntactic
    // guard cannot catch it (a bare identifier read is not assignment/++/call), so only the real
    // type-check gate rejects it.
    const TYPE_UNSAFE = 'component C { state count = 0; <button onClick={ count }>x</button> }';
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

describe('azeroth() plugin - emitDeclarations mirror', () =>
{
    // With emitDeclarations on, the plugin writes a TypeScript projection of each `.azeroth` file into
    // a hidden `.azeroth/types/` mirror under the project root (never beside the source), so `.ts`
    // imports resolve + type-check without an editor plugin. OFF by default (opt-in).
    const ctx = { warn: vi.fn(), error: (m: unknown): never =>
    {
        throw new Error(String(m));
    } };
    const source = 'export default component C { state count = 0; <button onClick={ () => count++ }>{ count }</button> }';

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
            // Each name form carries a declaration map pointing back at the REAL `.azeroth` source,
            // so an editor's go-to-definition lands on the component, not inside the mirror.
            expect(text).toContain('sourceMappingURL=Widget.d.ts.map');
            expect(readFileSync(explicit, 'utf8')).toContain('sourceMappingURL=Widget.azeroth.d.ts.map');
            const map = JSON.parse(readFileSync(plain + '.map', 'utf8')) as { sources: string[]; mappings: string };
            expect(map.sources).toEqual(['../../Widget.azeroth']);
            expect(map.mappings.length).toBeGreaterThan(0);
            // The source directory stays clean - nothing written beside Widget.azeroth.
            expect(existsSync(join(dir, 'Widget.d.ts'))).toBe(false);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writes nothing outside the mirror for a module resolved outside the root', async () =>
    {
        const base = mkdtempSync(join(tmpdir(), 'az-dts-'));
        try
        {
            // A `.azeroth` module outside the Vite root (a monorepo sibling, a linked workspace, a
            // hoisted node_modules copy) makes `relative(root, file)` start with `..` segments, which
            // join() normalises away - eating `.azeroth/types` and then climbing PAST the root. This is
            // where the escaped write landed, and it overwrote whatever file already had that name.
            const root = join(base, 'p', 'q', 'root');
            mkdirSync(root, { recursive: true });
            const outside = join(base, 'Shared.azeroth');
            writeFileSync(outside, source);
            const victim = join(base, 'p', 'q', 'Shared.d.ts');
            writeFileSync(victim, 'export const mine = 1;\n');

            const plugin = azeroth({ emitDeclarations: true, typeCheck: false });
            (plugin.configResolved as (r: { root?: string }) => void)({ root });
            await (plugin.transform as unknown as TransformFn).call(ctx, source, outside);

            expect(readFileSync(victim, 'utf8')).toBe('export const mine = 1;\n');
            // No mirror is created either: the module has no path inside it.
            expect(existsSync(join(root, '.azeroth'))).toBe(false);
        }
        finally
        {
            rmSync(base, { recursive: true, force: true });
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

describe('azeroth() plugin - vite logger ownership', () =>
{
    type ConfigFn = (config: Record<string, unknown>, env: { command: string }) => void;
    const configOf = (): ConfigFn => azeroth().config as unknown as ConfigFn;

    it('injects the customLogger for dev serves only', () =>
    {
        const serve: Record<string, unknown> = {};
        configOf()(serve, { command: 'serve' });
        expect(serve.customLogger).toBeDefined();

        const build: Record<string, unknown> = {};
        configOf()(build, { command: 'build' });
        expect(build.customLogger).toBeUndefined();
    });

    it('never clobbers a user-configured logger', () =>
    {
        const mine = { info: vi.fn() };
        const config: Record<string, unknown> = { customLogger: mine };
        configOf()(config, { command: 'serve' });
        expect(config.customLogger).toBe(mine);
    });
});

describe('azeroth() plugin - clientLogs -> server.forwardConsole', () =>
{
    type ConfigFn = (config: Record<string, unknown>, env: { command: string }) => void;
    const configOf = (options?: Parameters<typeof azeroth>[0]): ConfigFn => azeroth(options).config as unknown as ConfigFn;

    it('turns vite forwarding on for dev serves with the errors default', () =>
    {
        const config: Record<string, unknown> = {};
        configOf()(config, { command: 'serve' });
        expect((config.server as { forwardConsole?: unknown }).forwardConsole).toEqual({
            unhandledErrors: true,
            logLevels: ['error', 'warn']
        });

        const build: Record<string, unknown> = {};
        configOf()(build, { command: 'build' });
        expect(build.server).toBeUndefined();
    });

    it("clientLogs: 'all' adds console.log/info; false disables even the agent default", () =>
    {
        const all: Record<string, unknown> = {};
        configOf({ clientLogs: 'all' })(all, { command: 'serve' });
        expect((all.server as { forwardConsole?: { logLevels?: string[] } }).forwardConsole?.logLevels).toEqual(['error', 'warn', 'log', 'info']);

        const off: Record<string, unknown> = {};
        configOf({ clientLogs: false })(off, { command: 'serve' });
        expect((off.server as { forwardConsole?: unknown }).forwardConsole).toBe(false);
    });

    it('a user-configured forwardConsole wins', () =>
    {
        const config: Record<string, unknown> = { server: { forwardConsole: { unhandledErrors: false, logLevels: ['error'] } } };
        configOf()(config, { command: 'serve' });
        expect((config.server as { forwardConsole?: { logLevels?: string[] } }).forwardConsole?.logLevels).toEqual(['error']);
    });
});

// Vite's dependency scanner only crawls modules it can read (JS extensions, html-likes,
// optimizeDeps.extensions entries) and runs OUTSIDE the plugin pipeline - only
// optimizeDeps.rolldownOptions.plugins participate. Without both wirings the `.azeroth`
// entry is externalized at scan, nothing is pre-bundled, and a runtime re-optimization
// can invalidate an in-flight dynamic import.
describe('azeroth() plugin - dependency scanner wiring', () =>
{
    interface OptimizeDeps { extensions?: string[]; rolldownOptions?: { plugins?: unknown } }
    type ConfigFn = (config: Record<string, unknown>, env: { command: string }) => void;
    const configOf = (options?: Parameters<typeof azeroth>[0]): ConfigFn => azeroth(options).config as unknown as ConfigFn;

    it('a dev serve gains the extension and the scan plugin; a build stays untouched', () =>
    {
        const serve: Record<string, unknown> = {};
        configOf()(serve, { command: 'serve' });
        const optimize = serve.optimizeDeps as OptimizeDeps;
        expect(optimize.extensions).toEqual(['.azeroth']);
        expect((optimize.rolldownOptions?.plugins as Array<{ name: string }>).map((p) => p.name)).toEqual(['azerothjs:dep-scan']);

        const build: Record<string, unknown> = {};
        configOf()(build, { command: 'build' });
        expect(build.optimizeDeps).toBeUndefined();
    });

    it('user extensions and plugins are preserved, never clobbered', () =>
    {
        const mine = { name: 'my-scan-shim' };
        const config: Record<string, unknown> = { optimizeDeps: { extensions: ['.marko'], rolldownOptions: { plugins: [mine] } } };
        configOf()(config, { command: 'serve' });
        const optimize = config.optimizeDeps as OptimizeDeps;
        expect(optimize.extensions).toEqual(['.marko', '.azeroth']);
        // Nested, not spread: vite flattens the array itself, and the user's value may
        // be a promise. The user's entry stays first so their shim wins on overlap.
        const plugins = optimize.rolldownOptions?.plugins as [unknown, { name: string }];
        expect(plugins[0]).toEqual([mine]);
        expect(plugins[1].name).toBe('azerothjs:dep-scan');
    });

    it('an already-registered extension is not duplicated, and a custom extension flows through', () =>
    {
        const config: Record<string, unknown> = { optimizeDeps: { extensions: ['.azeroth'] } };
        configOf()(config, { command: 'serve' });
        expect((config.optimizeDeps as OptimizeDeps).extensions).toEqual(['.azeroth']);

        const custom: Record<string, unknown> = {};
        configOf({ extension: '.az' })(custom, { command: 'serve' });
        const optimize = custom.optimizeDeps as OptimizeDeps;
        expect(optimize.extensions).toEqual(['.az']);
        const [shim] = optimize.rolldownOptions?.plugins as [{ load: { filter: { id: RegExp } } }];
        expect(shim.load.filter.id.test('C:/app/src/main.az')).toBe(true);
        expect(shim.load.filter.id.test('C:/app/src/main.azeroth')).toBe(false);
    });
});

describe('azerothDepScanPlugin', () =>
{
    const shim = azerothDepScanPlugin('.azeroth', true);

    it('matches .azeroth paths in both separator styles and nothing else', () =>
    {
        expect(shim.load.filter.id.test('/app/src/main.azeroth')).toBe(true);
        expect(shim.load.filter.id.test('C:\\app\\src\\main.azeroth')).toBe(true);
        expect(shim.load.filter.id.test('/app/src/main.ts')).toBe(false);
    });

    it('hands the scanner the lowered module as TS, injected runtime import included', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-scan-'));
        try
        {
            const file = join(dir, 'Widget.azeroth');
            writeFileSync(file, 'import { helper } from "./lib.ts";\n\nexport default component Widget()\n{\n    <p>{ helper() }</p>\n}\n');
            const result = shim.load.handler(file);
            expect(result.moduleType).toBe('ts');
            expect(result.code).toContain("from 'azerothjs/internal'");
            expect(result.code).toContain('./lib.ts');
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a broken file and a missing file both degrade to an empty module instead of failing the scan', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-scan-'));
        try
        {
            const broken = join(dir, 'Broken.azeroth');
            writeFileSync(broken, 'export default component Broken()\n{\n    <div>\n}\n');
            expect(shim.load.handler(broken)).toEqual({ code: '', moduleType: 'js' });
            expect(shim.load.handler(join(dir, 'Missing.azeroth'))).toEqual({ code: '', moduleType: 'js' });
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the wired shim compiles with the same options the transform will use - ssr:false included', () =>
    {
        // The scanner must see the imports of the module vite will SERVE, so the shim and the
        // transform hand generateModule the same options. The dep SPECIFIER set is provably
        // option-independent today; aligning the arguments keeps that true by construction
        // rather than by theorem when codegen evolves.
        const config: Record<string, unknown> = {};
        (azeroth({ ssr: false }).config as unknown as (c: Record<string, unknown>, e: { command: string }) => void)(config, { command: 'serve' });
        const optimize = config.optimizeDeps as { rolldownOptions?: { plugins?: unknown } };
        const [wired] = optimize.rolldownOptions?.plugins as [ReturnType<typeof azerothDepScanPlugin>];

        const dir = mkdtempSync(join(tmpdir(), 'az-scan-'));
        try
        {
            const file = join(dir, 'Widget.azeroth');
            writeFileSync(file, 'export default component Widget()\n{\n    state n = 0;\n    <p>{ n }</p>\n}\n');
            const result = wired.load.handler(file);
            expect(result.moduleType).toBe('ts');
            // Client-only emission (no SSR string-mode branches), same single runtime specifier.
            expect(result.code).toContain("from 'azerothjs/internal'");
            expect(result.code).not.toContain('isStringMode');
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
