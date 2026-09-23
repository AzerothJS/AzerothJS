// @vitest-environment happy-dom
//
// The function-child shapes beside `let=` that stay legal, compiled and driven through render and
// hydrate. Each arm pins the text after every write, and that the module compiles without an error.
import { describe, it, expect, vi } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import { diagnoseModule } from '../src/diagnostics.ts';
import { lintSource } from '../src/lint.ts';
import * as runtime from 'azerothjs/internal';
import { render, hydrate, renderToString } from 'azerothjs';

const hook: { set?: (v: { page: number } | null) => void } = {};

const STEPS = [() => hook.set?.({ page: 8 }), () => hook.set?.(null), () => hook.set?.({ page: 9 })];

function moduleSource(markup: string): string
{
    return `export default component C() {
    state current = { page: 7 };
    const data = () => current;
    hook.set = (v) => { current = v; };
    <div>${ markup }</div>
}`;
}

function compile(markup: string): () => HTMLElement
{
    const body = generateModule(moduleSource(markup), 'T.azeroth').code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function');
    const keys = Object.keys(runtime);
    const values = runtime as unknown as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the compiler's own output IS the point
    const factory = new Function(...keys, 'hook', `${ body }\nreturn C;`) as (...args: unknown[]) => () => HTMLElement;
    return factory(...keys.map((k) => values[k]), hook);
}

/** Mounts the markup, runs each write, and joins the text after mount and after every write. */
function sequence(markup: string, mode: 'render' | 'hydrate'): string
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try
    {
        const C = compile(markup);
        if (mode === 'render')
        {
            render(() => C(), container);
        }
        else
        {
            container.innerHTML = renderToString(() => C());
            hook.set?.({ page: 7 });
            hydrate(() => C(), container);
        }
        const seq = [container.textContent];
        for (const step of STEPS)
        {
            step();
            seq.push(container.textContent);
        }
        expect([...warn.mock.calls, ...error.mock.calls]).toEqual([]);
        return seq.join(' > ');
    }
    finally
    {
        warn.mockRestore();
        error.mockRestore();
        container.remove();
    }
}

function errors(markup: string): string[]
{
    return diagnoseModule(moduleSource(markup)).filter((d) => d.severity === 'error').map((d) => d.code);
}

describe('a function child beside let= that is not the branch itself', () =>
{
    const cases: Array<[string, string, string]> = [
        ['a same-line padded thunk on Show', '<Show when={ current } let={ shown }> { () => shown.page } </Show>', ' 7  >  8  >  >  9 '],
        ['a same-line padded thunk on Match', '<Switch><Match when={ current } let={ got }> { () => got.page } </Match></Switch>', ' 7  >  8  >  >  9 '],
        ['a thunk after an element', '<Show when={ current } let={ shown }><b>x</b>{ () => shown.page }</Show>', 'x7 > x8 >  > x9'],
        ['a comment-led thunk', '<Show when={ current } let={ shown }>{ /* c */ () => <span>{ shown.page }</span> }</Show>', '7 > 8 >  > 9']
    ];

    for (const [label, markup, seq] of cases)
    {
        it(`${ label } compiles clean, renders and updates`, () =>
        {
            expect(errors(markup)).toEqual([]);
            expect(sequence(markup, 'render')).toBe(seq);
            expect(sequence(markup, 'hydrate')).toBe(seq);
        });
    }
});

describe('the narrowing advice, followed', () =>
{
    it('the Show written as the unwrap advice says compiles clean, renders and updates', () =>
    {
        const advice = lintSource(moduleSource('<Show when={ data() }>{ () => data()!.page }</Show>'))
            .filter((w) => w.code === 'azeroth/unsafe-narrow-in-show')
            .map((w) => w.message);
        expect(advice).toHaveLength(1);
        expect(advice[0]).toContain('Unwrap the lone');
        expect(advice[0]).toContain('<Show when={ data() } let={ value }>');

        const markup = '<Show when={ data() } let={ value }>{ value.page }</Show>';
        expect(errors(markup)).toEqual([]);
        expect(sequence(markup, 'render')).toBe('7 > 8 >  > 9');
        expect(sequence(markup, 'hydrate')).toBe('7 > 8 >  > 9');
    });
});
