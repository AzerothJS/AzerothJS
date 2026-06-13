import { describe, it, expect } from 'vitest';
import { azeroth } from '@azerothjs/compiler';

// Vite types `transform` as an ObjectHook; at runtime it's the plain
// async function the plugin defines, so we can call it directly.
type TransformFn = (code: string, id: string) => Promise<{ code: string; map?: { sources?: string[] } } | null>;

describe('azeroth() Vite plugin', () =>
{
    const plugin = azeroth();
    const transform = plugin.transform as unknown as TransformFn;

    it('ignores non-.azeroth files', async () =>
    {
        expect(await transform('const x = 1;', 'foo.ts')).toBeNull();
    });

    it('compiles a .azeroth module to h() JS, stripping TS', async () =>
    {
        const src = [
            'const n: number = 2;',
            'export default function C() { return <h1 class="t">Hi {n}</h1>; }'
        ].join('\n');

        const result = await transform(src, 'C.azeroth');
        expect(result).not.toBeNull();

        const code = result!.code;
        // (oxc may normalise quotes, so match either.)
        expect(code).toMatch(/h\(["']h1["']/);
        expect(code).toMatch(/import \{ h \}/);
        // The transformer stripped the `: number` type annotation.
        expect(code).not.toContain(': number');
    });

    it('produces a source map chained back to the .azeroth file', async () =>
    {
        const result = await transform(
            'export default function C() { return <h1>Hi {n()}</h1>; }',
            'C.azeroth'
        );
        expect(result!.map).toBeTruthy();
        expect(result!.map!.sources?.some(s => s.includes('C.azeroth'))).toBe(true);
    });

    it('exposes the expected plugin shape', () =>
    {
        expect(plugin.name).toBe('azerothjs');
        expect(plugin.enforce).toBe('pre');
    });

    it('emits lint warnings through the plugin context with positions', async () =>
    {
        const linted = azeroth();
        const warnings: string[] = [];
        const ctx = { warn: (msg: string): number => warnings.push(msg) };

        await (linted.transform as unknown as (this: typeof ctx, code: string, id: string) => Promise<unknown>)
            .call(ctx, 'const x = <button onClick={save()}>go</button>;', 'L.azeroth');

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('azeroth/handler-call');
    });

    it('injects the dev overlay during serve only', () =>
    {
        interface Hooks
        {
            configResolved: (config: { command: string }) => void;
            transformIndexHtml: () => { children: string; attrs: { type: string } }[] | undefined;
        }

        const serve = azeroth() as unknown as Hooks;
        serve.configResolved({ command: 'serve' });
        const tags = serve.transformIndexHtml();
        expect(tags).toHaveLength(1);
        expect(tags![0].attrs.type).toBe('module');
        expect(tags![0].children).toContain('installOverlay');

        const build = azeroth() as unknown as Hooks;
        build.configResolved({ command: 'build' });
        expect(build.transformIndexHtml()).toBeUndefined();

        const disabled = azeroth({ overlay: false }) as unknown as Hooks;
        disabled.configResolved({ command: 'serve' });
        expect(disabled.transformIndexHtml()).toBeUndefined();
    });
});
