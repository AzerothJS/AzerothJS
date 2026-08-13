// @vitest-environment happy-dom
//
// Regressions for defects an adversarial round found in COMPILED output that the hand-written
// h()/renderToString tests were structurally unable to see.
//
// The rule these encode: assert on BEHAVIOUR, not on how the emitted string is spelled. Both of
// this session's shipped blockers had a `toContain('...')` sentinel guarding them, and both
// sentinels stayed green while the code was broken, because a spelling assertion cannot tell a
// working binding from a well-spelled one.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { render, renderToString } from 'azerothjs';

/** Compiles `.azeroth` source and returns its default export, executed against the runtime. */
function compile(source: string): (props?: Record<string, unknown>) => unknown
{
    const generated = generateModule(source, 'T.azeroth', {});
    const code = typeof generated === 'string' ? generated : generated.code;
    const body = code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const name = (/^function\s+(\w+)/m.exec(body) as RegExpExecArray)[1] as string;
    const keys = Object.keys(runtime);
    const values = runtime as unknown as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the compiler's own output IS the point
    const factory = new Function(...keys, `${ body }\nreturn ${ name };`) as (...args: unknown[]) => (props?: Record<string, unknown>) => unknown;
    return factory(...keys.map((k) => values[k]));
}

function mount(source: string): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(() => compile(source)() as HTMLElement, container);
    return container.firstElementChild as HTMLElement;
}

describe('compiled ARIA booleans agree with the writers that know the rule', () =>
{
    // An ARIA state is a STRING. `aria-expanded={false}` means "collapsed" and must serialize as
    // "false"; dropping it means "not a disclosure control at all". The optimizer folded constant
    // attributes with HTML-boolean semantics BEFORE either writer ran, so a literal `={false}`
    // vanished from the template and `={true}` became a bare `aria-expanded` - which an
    // accessibility tree reads as neither true nor false. Only a COMPILED test can see this: the
    // template clone is a fourth writer (the HTML parser reading the folded template string) that
    // the hand-written h()/renderToString spec never touches.
    const cases: ReadonlyArray<readonly [string, string]> = [
        ['aria-expanded={false}', 'false'],
        ['aria-expanded={true}', 'true'],
        ['aria-hidden={true}', 'true'],
        ['aria-pressed={false}', 'false']
    ];

    for (const [spelling, expected] of cases)
    {
        const attr = spelling.slice(0, spelling.indexOf('='));

        it(`writes ${ spelling } as "${ expected }" in the compiled DOM path`, () =>
        {
            const el = mount(`export default component C() { <button ${ spelling }>x</button> }`);
            expect(el.getAttribute(attr)).toBe(expected);
        });

        it(`writes ${ spelling } as "${ expected }" in the compiled SSR path`, () =>
        {
            const Component = compile(`export default component C() { <button ${ spelling }>x</button> }`);
            const html = renderToString(() => Component() as HTMLElement);
            expect(html).toContain(`${ attr }="${ expected }"`);
        });
    }

    it('still folds a string-valued aria attribute into the template', () =>
    {
        // The fix must be narrow: only BOOLEANS carry the wrong semantics. A constant string has
        // no reason to become a runtime binding, and making it one would cost every static label.
        const generated = generateModule('export default component C() { <button aria-label={"Menu"}>x</button> }', 'T.azeroth', {});
        const code = typeof generated === 'string' ? generated : generated.code;
        expect(code).toContain('aria-label="Menu"');
    });
});

describe('compiled bind:value write-back, executed', () =>
{
    // The guard that discriminates a <select multiple> must not fire on an <input>. `multiple` is
    // a REAL reflected property on <input type="email"> and <input type="file">, where
    // `selectedOptions` does not exist - keying on it threw on every keystroke and left the
    // binding dead. The previous guard for this was a `toContain` on the emitted string, which
    // could not have caught it.
    it('drives state from a multiple-capable input without throwing', () =>
    {
        const el = mount('export default component C() { state e = ""; <input type="email" multiple bind:value={e} /> }') as HTMLInputElement;
        el.value = 'a@b.com';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        expect(el.value).toBe('a@b.com');
    });

    it('selects the FIRST option per value when values are duplicated', () =>
    {
        // Duplicate <option> values are legal HTML and ordinary in <For>-rendered rows. The array
        // write-back reduces a selection to a SET OF VALUES, losing which options were selected, so
        // re-applying it with `selected = wanted.has(value)` selected EVERY option carrying a
        // wanted value. One click selected rows the user never touched, and a later click could not
        // deselect them because the match check agreed with the fanned-out state. First-occurrence
        // is what the scalar path (`select.value = x`) has always done.
        // No type annotation: codegen carries one through as a generic type argument, which this
        // deliberately crude `new Function` harness does not strip.
        const el = mount('export default component C() { state picks = ["de"];'
            + ' <select multiple bind:value={picks}>'
            + '<option value="us">us</option><option value="de">de</option>'
            + '<option value="jp">jp</option><option value="de">de again</option>'
            + '</select> }') as HTMLSelectElement;

        expect([...el.options].map((o) => o.selected)).toEqual([false, true, false, false]);
    });

    it('does not introduce a free identifier the reactive rewrite can capture', () =>
    {
        // The write-back is spliced into USER scope and then run through the reactive rewrite, so
        // `Array.prototype.map` became `Array().prototype.map` in a component holding `state Array`
        // - and a module-scope `import { Array }` would silently redirect it. Executing a component
        // that shadows the name is the only assertion that proves the emitted text is hygienic.
        //
        // It has to be a MULTIPLE select: that is the only shape whose write-back takes the map
        // branch. On a plain <input> the poisoned expression sits in the untaken arm of the
        // conditional and never runs, so the test would pass against the broken emit.
        const el = mount('export default component C() { state Array = [];'
            + ' <select multiple bind:value={Array}>'
            + '<option value="us">us</option><option value="de">de</option>'
            + '</select> }') as HTMLSelectElement;

        (el.options[1] as HTMLOptionElement).selected = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        expect([...el.options].map((o) => o.selected)).toEqual([false, true]);
    });
});

describe('markers never survive to emitted code', () =>
{
    // `projectMarkup` emits `__azRow(...)` row markers for a raw-mode <For>, and only the
    // statement lowering strips them. A keyword-free MODULE-scope helper failed the lowering's
    // word test, skipped the strip, and shipped a bare `__azRow(` - a ReferenceError the moment
    // the module loaded, with no diagnostic anywhere. The emitted text is the only witness.
    it('strips __azRow from a keyword-free module-scope markup helper', () =>
    {
        const generated = generateModule(
            'const renderRow = (items) => <For each={items} key={(r) => r.id} let={ row }><li>{row.name}</li></For>;\n'
            + 'export default component C() { state items = [{ id: 1, name: "a" }]; <div>{renderRow(items)}</div> }',
            'T.azeroth', {});
        const code = typeof generated === 'string' ? generated : generated.code;
        expect(code).not.toContain('__azRow');
        // ...and the row still lowers to a getter call, so stripping did not cost the sugar.
        expect(code).toContain('row().name');
    });
});
