// @vitest-environment node
//
// A compiled `cleanup` block does not run during a server render, wherever it sits in the
// component. `dispose` and a cleanup inside a derived value still run when the render ends.
import { describe, it, expect, beforeEach } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { renderToString } from 'azerothjs';

/** Compiles `.azeroth` source and returns its default export, executed against the runtime. */
function compile(source: string): (props?: Record<string, unknown>) => unknown
{
    const generated = generateModule(source, 'T.azeroth', {});
    const code = typeof generated === 'string' ? generated : generated.code;
    const body = code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function\s+(\w+)/m, 'const __default = function $1')
        .replace(/^export\s+function/gm, 'function');
    const keys = Object.keys(runtime);
    const values = runtime as unknown as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the compiler's own output IS the point
    const factory = new Function(...keys, `${ body }\nreturn __default;`) as (...args: unknown[]) => (props?: Record<string, unknown>) => unknown;
    return factory(...keys.map((k) => values[k]));
}

function serverRender(source: string, props: Record<string, unknown> = {}): string
{
    const Component = compile(source);
    // Hydration markers are dropped so a row asserts the markup the component wrote.
    return renderToString(() => Component(props) as HTMLElement).replace(/<!--.*?-->/g, '');
}

const TOUCH = 'window.clearTimeout(1);';

describe('a compiled cleanup block during a server render', () =>
{
    it('runs in an environment with no window', () =>
    {
        expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    });

    const shapes: ReadonlyArray<readonly [string, string, string]> = [
        ['at the top of the body', `export default component A() { cleanup { ${ TOUCH } } <p>a</p> }`, '<p>a</p>'],
        ['inside an if', `export default component A(props) { if (props.poll) { cleanup { ${ TOUCH } } } <p>a</p> }`, '<p>a</p>'],
        ['inside a local helper', `export default component A() { function useTimer() { cleanup { ${ TOUCH } } } useTimer(); <p>a</p> }`, '<p>a</p>'],
        ['inside batch', `export default component A() { batch { cleanup { ${ TOUCH } } } <p>a</p> }`, '<p>a</p>'],
        [
            'in a component rendered by a For row',
            `component Row(props) { cleanup { ${ TOUCH } } <b>{ props.n }</b> }\n`
                + 'export default component A() { state xs = [1, 2]; <ul><For each={xs} key={(i) => i} let={x}><li><Row n={x} /></li></For></ul> }',
            '<ul><li><b>1</b></li><li><b>2</b></li></ul>'
        ],
        [
            'in a component rendered by a Show branch',
            `component Row() { cleanup { ${ TOUCH } } <b>r</b> }\n`
                + 'export default component A() { state on = true; <div><Show when={on}><Row /></Show></div> }',
            '<div><b>r</b></div>'
        ]
    ];

    for (const [where, source, html] of shapes)
    {
        it(`renders a cleanup that reads window ${ where }`, () =>
        {
            expect(serverRender(source, { poll: true })).toBe(html);
        });
    }

    it('still runs a dispose block when the render ends', () =>
    {
        expect(() => serverRender(`export default component A() { dispose { ${ TOUCH } } <p>a</p> }`)).toThrow(/window is not defined/);
    });
});

describe('a compiled cleanup block inside a derived value during a server render', () =>
{
    const slot = globalThis as unknown as { __ran: string[] };

    beforeEach(() =>
    {
        slot.__ran = [];
    });

    it('runs when the render disposes the derived value', () =>
    {
        const html = serverRender('export default component A()\n'
            + '{\n'
            + '    derived label = (() => { cleanup { globalThis.__ran.push("d"); } return "x"; })();\n'
            + '    <p>{ label }</p>\n'
            + '}\n');

        expect(html).toBe('<p>x</p>');
        expect(slot.__ran).toEqual(['d']);
    });
});
