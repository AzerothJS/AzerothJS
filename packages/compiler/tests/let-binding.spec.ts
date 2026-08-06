// @vitest-environment node
//
// Binding attributes (`let=` / `index=`): markup children of a builtin become the
// runtime's value callback, with declared names joining the bare-read rewrite so a
// declared name reads like state. The runtime contract is unchanged - these tests pin
// the EMISSION shape, not new runtime behavior.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import { diagnoseModule } from '../src/diagnostics.ts';
import { generateVirtualCode } from '../src/project.ts';
import { typeCheckModuleTS } from '../src/typecheck-ts.ts';

function gen(src: string): string
{
    return generateModule(src).code;
}

const SHOW = `
export default component Panel()
{
    state report = null as { n: number } | null;
    state done = false;

    <div>
        <Show when={ done ? report : null } let={ report }>
            <p>{ report.n }</p>
        </Show>
    </div>
}
`;

describe('let binding emission', () =>
{
    it('Show let= emits an arity-1 children callback with the declared name', () =>
    {
        const code = gen(SHOW);

        // The children value is the runtime's value callback...
        expect(code).toMatch(/\(report\) =>/);
        // ...and the declared name reads like state: bare `report.n` emits a getter call.
        expect(code).toContain('report().n');
        // The attribute is consumed, never passed as a prop.
        expect(code).not.toMatch(/get let\(|['"]let['"]/);
    });

    it('For let= + index= emits (item, index) params in the runtime order', () =>
    {
        const code = gen(`
export default component List()
{
    state items = [] as { id: number; name: string }[];

    <ul>
        <For each={ items } key={ (t) => t.id } let={ item } index={ i }>
            <li>{ item.name } { i }</li>
        </For>
    </ul>
}
`);

        expect(code).toMatch(/\(item, i\) =>/);
        expect(code).toContain('item().name');
        // The index reads bare too - the same unwrap the callback form already has.
        expect(code).toContain('i()');
    });

    it('For with index= alone still occupies the value slot', () =>
    {
        const code = gen(`
export default component Numbered()
{
    state items = [] as string[];

    <ol>
        <For each={ items } key={ (t) => t } index={ i }>
            <li>{ i }</li>
        </For>
    </ol>
}
`);

        expect(code).toMatch(/\(_, i\) =>/);
    });

    it('Match let= binds the narrowed name', () =>
    {
        const code = gen(`
export default component Status()
{
    state user = null as { name: string } | null;

    <Switch>
        <Match when={ user } let={ u }>
            <p>{ u.name }</p>
        </Match>
    </Switch>
}
`);

        expect(code).toMatch(/\(u\) =>/);
        expect(code).toContain('u().name');
    });

    it('a user component keeps `let` as an ordinary prop', () =>
    {
        const code = gen(`
import Card from './card.azeroth';

export default component Host()
{
    <Card let={ 5 } />
}
`);

        // Vocabulary gates by tag: no builtin contract, so `let` is a plain prop.
        expect(code).toMatch(/get let\(\)/);
    });
});

describe('let binding projection', () =>
{
    it('projects the binding through the typed adapter, not as a prop', () =>
    {
        const { code } = generateVirtualCode(SHOW, 'panel.azeroth');

        expect(code).toContain('__azNarrow(');
        expect(code).toMatch(/\(report\) =>/);
        // The attribute never reaches the props object, where it would trip
        // excess-property checks against ShowProps.
        expect(code).not.toMatch(/let:\s/);
    });

    it('the declared name type-checks with the narrowed inferred type', () =>
    {
        expect(typeCheckModuleTS(SHOW)).toEqual([]);
    });

    it('inference is real: a wrong read through the name is caught', () =>
    {
        // The proof must fit the checker's design: only attribute-anchored diagnostics
        // with ENFORCED codes surface (2339 is dropped everywhere; host attrs are
        // loosely typed at the h layer). A COMPONENT prop position checks for real, so a
        // number-into-string mismatch through the bound name can only exist if the
        // binding parameter carries the narrowed inferred type - the callback form's
        // any-widening would have let it pass.
        const diagnostics = typeCheckModuleTS(`
component Typed(props: { n: string })
{
    <b>{ props.n }</b>
}

export default component Panel()
{
    state report = null as { n: number } | null;
    state done = false;

    <div>
        <Show when={ done ? report : null } let={ report }>
            <Typed n={ report.n } />
        </Show>
    </div>
}
`);

        expect(diagnostics.length).toBeGreaterThan(0);
        expect(diagnostics.some((d) => d.message.includes('number'))).toBe(true);
    });

    it('For let/index infer item and number', () =>
    {
        const diagnostics = typeCheckModuleTS(`
export default component List()
{
    state items = [] as { id: number; name: string }[];

    <ul>
        <For each={ items } key={ (t) => t.id } let={ item } index={ i }>
            <li>{ item.name } { i.toFixed(0) }</li>
        </For>
    </ul>
}
`);

        expect(diagnostics).toEqual([]);
    });
});

describe('let binding diagnostics', () =>
{
    const codes = (src: string): string[] => diagnoseModule(src).map((d) => d.code);

    const inShow = (attrs: string): string => `
export default component P()
{
    state x = null as { n: number } | null;

    <div>
        <Show when={ x } ${ attrs }>
            <p>y</p>
        </Show>
    </div>
}
`;

    it('accepts a bare identifier', () =>
    {
        expect(codes(inShow('let={ x }'))).toEqual([]);
    });

    it('rejects an expression value', () =>
    {
        expect(codes(inShow('let={ x.n }'))).toContain('azeroth/binding-value');
    });

    it('rejects a reserved word', () =>
    {
        expect(codes(inShow('let={ class }'))).toContain('azeroth/binding-value');
    });

    it('rejects a valueless binding attr', () =>
    {
        expect(codes(inShow('let'))).toContain('azeroth/binding-value');
    });

    it('rejects let and index declaring the same name', () =>
    {
        const src = `
export default component P()
{
    state items = [] as string[];

    <ul>
        <For each={ items } key={ (t) => t } let={ item } index={ item }>
            <li>{ item }</li>
        </For>
    </ul>
}
`;
        expect(codes(src)).toContain('azeroth/binding-duplicate-name');
    });

    it('rejects a render-callback child - the form does not exist', () =>
    {
        const src = `
export default component P()
{
    state x = null as { n: number } | null;

    <div>
        <Show when={ x }>
        { (v: () => { n: number }) => <p>{ v().n }</p> }
        </Show>
    </div>
}
`;
        const removal = diagnoseModule(src).find((d) => d.code === 'azeroth/callback-children-removed');
        expect(removal?.severity).toBe('error');
        expect(removal?.message).toContain('let={ name }');
    });

    it('a zero-arg thunk child stays legal - it binds nothing', () =>
    {
        const thunk = diagnoseModule(`
export default component P()
{
    state open = false;

    <Show when={ open }>
    { () => <p>lazy</p> }
    </Show>
}
`);
        expect(thunk.some((d) => d.code === 'azeroth/callback-children-removed')).toBe(false);
    });
});

describe('let binding row optimization', () =>
{
    it('a For let= row with a host-element body rides the clone path', () =>
    {
        const code = gen(`
export default component L()
{
    state items = [] as { id: number; name: string }[];

    <ul>
        <For each={ items } key={ (t) => t.id } let={ item } index={ i }>
            <li class="row">{ item.name } { i }</li>
        </For>
    </ul>
}
`);

        // The mode-dispatched clone row, not a per-row h() tree: template clone plus
        // hole wiring, with the string-mode h() fallback intact.
        expect(code).toMatch(/\(item, i\) => \{ if \(isStringMode\(\) \|\| isHydrating\(\)\)/);
        expect(code).toContain('_tmpl$');
        expect(code).toContain('bindHole');
        expect(code).toContain('item().name');
    });

    it('a component-rooted let= row stays on the markup path', () =>
    {
        const code = gen(`
import Card from './card.azeroth';

export default component L()
{
    state items = [] as { id: number }[];

    <ul>
        <For each={ items } key={ (t) => t.id } let={ item }>
            <Card item={ item } />
        </For>
    </ul>
}
`);

        // Mirrors tryLowerRenderClone's bailout: no host element to clone.
        expect(code).toMatch(/\(item\) =>/);
        expect(code).toContain('item()');
    });
});

describe('let binding adversarial audit', () =>
{
    it('nested Show > For > Match bindings compile and type-check clean', () =>
    {
        const src = `
export default component Nested()
{
    state groups = null as { name: string; rows: { id: number; kind: string | null }[] }[] | null;

    <div>
        <Show when={ groups } let={ groups }>
            <For each={ groups } key={ (g) => g.name } let={ group } index={ gi }>
                <section title={ group.name + gi.toFixed(0) }>
                    <Switch>
                        <For each={ group.rows } key={ (r) => r.id } let={ row }>
                            <Match when={ row.kind } let={ kind }>
                                <p title={ kind }>{ row.id }</p>
                            </Match>
                        </For>
                    </Switch>
                </section>
            </For>
        </Show>
    </div>
}
`;
        expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        expect(typeCheckModuleTS(src)).toEqual([]);
        expect(() => generateModule(src)).not.toThrow();
    });

    it('an inner let may shadow an outer let; both compile and the inner wins locally', () =>
    {
        const src = `
export default component Shadow()
{
    state pages = [] as { rows: { id: number }[] }[];

    <div>
        <For each={ pages } key={ (p) => p.rows.length } let={ item }>
            <ul title={ String(item.rows.length) }>
                <For each={ item.rows } key={ (r) => r.id } let={ item }>
                    <li>{ item.id }</li>
                </For>
            </ul>
        </For>
    </div>
}
`;
        expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        expect(typeCheckModuleTS(src)).toEqual([]);
        // Nested arrows both named `item`: plain JS shadowing, inner reads the row.
        const code = gen(src);
        expect(code).toContain('item().id');
    });

    it('a let name colliding with a module-level const still shadows cleanly', () =>
    {
        const src = `
const item = 'module-level';

export default component Collide()
{
    state items = [] as { id: number }[];

    <div title={ item }>
        <For each={ items } key={ (r) => r.id } let={ item }>
            <li>{ item.id }</li>
        </For>
    </div>
}
`;
        expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        expect(typeCheckModuleTS(src)).toEqual([]);
    });

    it('destructuring in let= is rejected with the binding-value diagnostic', () =>
    {
        const src = `
export default component D()
{
    state items = [] as { id: number }[];

    <For each={ items } key={ (r) => r.id } let={ { id } }>
        <li>{ id }</li>
    </For>
}
`;
        expect(diagnoseModule(src).map((d) => d.code)).toContain('azeroth/binding-value');
    });

    it('emission is stable: identical input produces identical output', () =>
    {
        const src = `
export default component Stable()
{
    state items = [] as { id: number; label: string }[];

    <ul>
        <For each={ items } key={ (r) => r.id } let={ row } index={ i }>
            <li>{ i }. { row.label }</li>
        </For>
    </ul>
}
`;
        expect(gen(src)).toBe(gen(src));
    });
});
