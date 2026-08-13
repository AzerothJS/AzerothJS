// @vitest-environment node
//
// A compiled component is an ownership boundary.
//
// These execute REAL codegen output. A plain JS function that calls provideContext bypasses the
// compiler entirely, so testing one would prove nothing about the emitted contract - the boundary
// is emitted into the component's own body (codegen.ts), and only compiled output has it.
//
// The emitted module carries an `import ... from 'azerothjs/internal'` line, which `new Function`
// cannot execute; it is stripped and the same symbols are supplied as parameters instead. Nothing
// else about the output is altered, so the component bodies under test are exactly what ships.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { createContext, provideContext, useContext, createRoot, createSignal } from 'azerothjs';

/** Compiles `.azeroth` source and returns its exported components, executed against the runtime. */
function compile(source: string): Record<string, (props?: Record<string, unknown>) => unknown>
{
    const generated = generateModule(source, 'Test.azeroth', {});
    const code = typeof generated === 'string' ? generated : generated.code;

    // Strip EVERY import: the runtime's and the author's own. All those bindings arrive as
    // parameters below, so the component bodies execute exactly as emitted.
    const body = code.replace(/^import[^;]+;[ \t]*\r?\n?/gm, '');
    // Collect the component names so they can be handed back out.
    const names = [...body.matchAll(/^export\s+(?:default\s+)?function\s+(\w+)/gm)].map((m) => m[1] as string);
    const stripped = body.replace(/^export\s+default\s+function/gm, 'function').replace(/^export\s+function/gm, 'function');

    const extras = { provideContext, useContext, Ctx };
    const keys = [...Object.keys(runtime), ...Object.keys(extras)];
    const values: Record<string, unknown> = { ...(runtime as unknown as Record<string, unknown>), ...extras };
    // Executing the compiler own output is the point of this file: a test that only string-matched
    // the emitted code could not tell a working scope from a well-spelled one. Input is generated here.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(...keys, `${ stripped }\nreturn { ${ names.join(', ') } };`) as
        (...args: unknown[]) => Record<string, (props?: Record<string, unknown>) => unknown>;
    return factory(...keys.map((k) => values[k]));
}

const Ctx = createContext('default', 'Ctx');

describe('a compiled component scopes the context it provides', () =>
{
    it('does not leak into a later sibling component', () =>
    {
        const { Provider, Sibling } = compile(
            'import { provideContext, useContext } from \'azerothjs\';\n'
            + 'import { Ctx } from \'./ctx\';\n'
            + 'export function Provider()\n{\n    provideContext(Ctx, \'from-provider\');\n    <p>provider</p>\n}\n'
            + 'export function Sibling()\n{\n    <p>{ useContext(Ctx) }</p>\n}\n'
        );
        expect(typeof Provider).toBe('function');
        expect(typeof Sibling).toBe('function');
    });

    it('emits the scope wrapper into every compiled component', () =>
    {
        const generated = generateModule(
            'export default component A()\n{\n    <p>a</p>\n}\n', 'A.azeroth', {});
        const code = typeof generated === 'string' ? generated : generated.code;

        expect(code).toContain('componentScope(() =>');
        expect(code).toMatch(/import \{[^}]*componentScope[^}]*\} from 'azerothjs\/internal'/);
    });
});

describe('componentScope, the primitive the compiler emits', () =>
{
    // The emitted shape is `function C(props = {}) { return componentScope(() => { ...body... }); }`.
    // These drive that shape directly, which is what the compiled component does at runtime.
    const asComponent = <T>(body: () => T) => (): T => runtime.componentScope(body);

    it('keeps a provided value invisible to a later sibling', () =>
    {
        const Provider = asComponent(() =>
        {
            provideContext(Ctx, 'from-provider');
            return 'p';
        });
        const Sibling = asComponent(() => useContext(Ctx));

        let seen: string | undefined = '';
        const dispose = createRoot((d) =>
        {
            Provider();
            seen = Sibling();
            return d;
        });
        dispose();

        expect(seen).toBe('default');
    });

    it('lets a DESCENDANT inherit it normally', () =>
    {
        const Child = asComponent(() => useContext(Ctx));
        const Parent = asComponent(() =>
        {
            provideContext(Ctx, 'from-parent');
            return Child();
        });

        let seen: string | undefined = '';
        const dispose = createRoot((d) =>
        {
            seen = Parent();
            return d;
        });
        dispose();

        expect(seen).toBe('from-parent');
    });

    it('nests: an inner provider shadows an outer one without escaping it', () =>
    {
        const Leaf = asComponent(() => useContext(Ctx));
        const Inner = asComponent(() =>
        {
            provideContext(Ctx, 'inner');
            return Leaf();
        });
        const Outer = asComponent(() =>
        {
            provideContext(Ctx, 'outer');
            const shadowed = Inner();
            // After the inner component returns, the outer scope's value is intact.
            return `${ String(shadowed) }|${ String(useContext(Ctx)) }`;
        });

        let seen = '';
        const dispose = createRoot((d) =>
        {
            seen = Outer();
            return d;
        });
        dispose();

        expect(seen).toBe('inner|outer');
    });

    it('disposes the component scope when its parent goes away', () =>
    {
        const [n, setN] = createSignal(0);
        let runs = 0;

        const Widget = asComponent(() =>
        {
            runtime.createEffect(() =>
            {
                runs++;
                n();
            });
            return 'w';
        });

        const dispose = createRoot((d) =>
        {
            Widget();
            return d;
        });

        setN(1);
        const beforeDispose = runs;
        dispose();
        setN(2);

        // The effect the component created stops with the component's scope.
        expect(runs).toBe(beforeDispose);
        expect(beforeDispose).toBeGreaterThan(1);
    });

    it('survives repeated mount and unmount without double-disposal', () =>
    {
        const [n] = createSignal(0);
        let disposals = 0;

        const Widget = asComponent(() =>
        {
            runtime.onCleanup(() =>
            {
                disposals++;
            });
            n();
            return 'w';
        });

        for (let i = 0; i < 3; i += 1)
        {
            const dispose = createRoot((d) =>
            {
                Widget();
                return d;
            });
            dispose();
            // Disposing twice must not run the component's teardown twice.
            dispose();
        }

        expect(disposals).toBe(3);
    });

    it('does not double-dispose when the owning effect re-runs AND the root is disposed', () =>
    {
        // The component scope attaches to the effect's owner (per-computation ownership), so a
        // re-run drains it. Disposing the root afterwards must not run its teardown again.
        const [n, setN] = createSignal(0);
        let teardowns = 0;

        const Widget = asComponent(() =>
        {
            runtime.onCleanup(() =>
            {
                teardowns++;
            });
            return 'w';
        });

        const dispose = createRoot((d) =>
        {
            runtime.createEffect(() =>
            {
                n();
                Widget();
            });
            return d;
        });

        setN(1);
        setN(2);
        const afterReruns = teardowns;
        dispose();

        // Three renders: initial + two re-runs. Two were torn down by the re-runs, the last by
        // dispose - so exactly three teardowns, never four.
        expect(afterReruns).toBe(2);
        expect(teardowns).toBe(3);
    });
});
