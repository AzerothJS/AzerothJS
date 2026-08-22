// @vitest-environment happy-dom
//
// The COMPLETE bind-target contract, tested from the grammar's rule rather than from the
// implementation. GRAMMAR: `bind:p={lvalue}` requires a writable REACTIVE lvalue - so the valid
// set is exactly a `state` name, a `form` field path, and an array-form row field; every other
// resolvable target is a compile-time error, and an unresolvable one is left alone. A "store
// path" is NOT in the set: an earlier version of this spec blessed it with a diagnostics-only
// pin, and the first executed probe crashed at mount - the store handle is a function, and no
// rewrite exists for paths through it. Cases the implementation happens to handle are NOT the
// spec; this matrix is, and a VALID pin that is never executed is how that lie survived.
//
// The EXECUTION half exists because the emitted write-back used to be correct only in the
// component's markup position: markup embedded in a hole or a statement was rewritten TWICE
// (`d` -> `d()()`), so the value never updated and the write-back threw. A spelling assertion
// cannot see that; mounting the compiled output and typing can.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import { diagnoseModule } from '../src/diagnostics.ts';
import * as runtime from 'azerothjs/internal';
import { render, renderToString } from 'azerothjs';

function codes(source: string): string[]
{
    return diagnoseModule(source).filter(d => d.severity === 'error').map(d => d.code);
}

function messageOf(source: string): string | undefined
{
    return diagnoseModule(source).find(d => d.code === 'azeroth/bind-target-not-reactive'
        || d.code === 'azeroth/bind-file-input')?.message;
}

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

function type(el: HTMLInputElement, text: string): void
{
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('bind contract - the valid set compiles clean and works when executed', () =>
{
    const VALID: ReadonlyArray<readonly [string, string]> = [
        ['state', 'export default component C() { state x = "a"; <input bind:value={x} /> }'],
        ['state in a hole', 'export default component C() { state d = "a"; state cond = true; <div>{ cond ? <input bind:value={d} /> : null }</div> }'],
        ['state in statement markup', 'export default component C() { state d = "a"; const row = <input bind:value={d} />; <div>{row}</div> }'],
        ['form field', 'export default component C() { form login = { email: "" }; <input bind:value={login.email} /> }'],
        ['field-array row field', 'export default component C() { form rows[] = { qty: "0" }; <For each={rows.rows()} key={(row) => row.key} let={ row }><input bind:value={row.qty} /></For> }'],
        ['component bind', 'import Panel from "./Panel.azeroth";\nexport default component C() { state x = "a"; <Panel bind:value={x} /> }'],
        ['bind:checked', 'export default component C() { state on = false; <input type="checkbox" bind:checked={on} /> }'],
        ['nested state shadowing an outer local', 'export default component C() { let draft = "seed"; state rows = [1]; <div>{ rows.map(() => { state draft = ""; return <input bind:value={draft} />; }) }</div> }'],
        ['form field with a spaced dot', 'export default component C() { form login = { email: "" }; <input bind:value={login . email} /> }'],
        ['the same array form iterated twice with one row name', 'export default component C() { form rows[] = { qty: "0" }; <div><For each={rows.rows()} key={(row) => row.key} let={ row }><input bind:value={row.qty} /></For><For each={rows.rows()} key={(row) => row.key} let={ row }><input bind:value={row.qty} /></For></div> }'],
        ['two array forms with IDENTICAL fields sharing a row name', 'export default component C() { form a[] = { q: "" }; form b[] = { q: "" }; <div><For each={a.rows()} key={(row) => row.key} let={ row }><input bind:value={row.q} /></For><For each={b.rows()} key={(row) => row.key} let={ row }><input bind:value={row.q} /></For></div> }'],
        ['a plain row binding a field no array form claims', 'export default component C() { form extra[] = { x: "" }; state items = ["a"]; <div><For each={items} key={(row) => row} let={row}><input bind:value={row.z} /></For><For each={extra.rows()} key={(row) => row.key} let={ row }><span>y</span></For></div> }']
    ];

    for (const [label, source] of VALID)
    {
        it(`accepts ${ label }`, () =>
        {
            expect(codes(source)).toEqual([]);
        });
    }

    it('drives state both ways from a hole, executed', () =>
    {
        // Both directions, because the historical failure modes split: the double rewrite made
        // the VALUE branch a dead read while the handler still compiled, and a plain local made
        // the handler work while the value effect never re-ran.
        const el = mount('export default component C() { state d = "seed"; state cond = true; <div>{ cond ? <input bind:value={d} /> : null }</div> }');
        const input = el.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('seed');
        type(input, 'typed');
        expect(input.value).toBe('typed');
    });

    it('drives state both ways from statement markup, executed', () =>
    {
        const el = mount('export default component C() { state d = "seed"; const row = <input bind:value={d} />; <div>{row}</div> }');
        const input = el.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('seed');
        type(input, 'typed');
        expect(input.value).toBe('typed');
    });

    it('links the DETACHED each= getter, RENDERED and typed through to values()', () =>
    {
        // `each={rows.rows}` (no call) is inside For's own contract (`T[] | (() => T[])`) and
        // renders identically to the called spelling - but it never linked, so both the
        // registration and the diagnostic degraded together: zero errors, raw row-record writes,
        // and the DOM echoed typed text that form values() never saw. Silent data loss masked by
        // its own echo; only rendering plus a values() read can catch it.
        const source = 'export default component C() { form rows[] = { qty: "4" }; rows.append();'
            + ' <div><For each={rows.rows} key={(row) => row.key} let={ row }><input bind:value={row.qty} /></For>'
            + '<p>{rows.values()[0].qty}</p></div> }';
        expect(codes(source)).toEqual([]);
        const html = renderToString(() => compile(source)() as never);
        expect(html).toContain('value="4"');
        expect(html).toMatch(/<p>(?:<!--[^>]*-->)*4/);
    });

    it('registers a statement-position For, RENDERED', () =>
    {
        // `const frag = <For .../>` compiles through the same emitter, but the row registry only
        // scanned markup-position items - holes rendered silently empty and binds were rejected
        // with a rename that could fix nothing (there was no second For to rename).
        const source = 'export default component C() { form rows[] = { qty: "3" }; rows.append();'
            + ' const frag = <For each={rows.rows()} key={(row) => row.key} let={ row }><input bind:value={row.qty} /></For>;'
            + ' <div>{frag}</div> }';
        expect(codes(source)).toEqual([]);
        const html = renderToString(() => compile(source)() as never);
        expect(html).toContain('value="3"');
    });

    it('links each= behind parentheses, RENDERED', () =>
    {
        // Wrappers on `each=` used to silently sever the row linkage the same wrappers on a
        // TARGET loudly reject. The diagnostic and the registration share arrayFormEachName, so
        // they can never disagree - which also means a diagnostics-only assertion here is
        // vacuous: severing the link silences BOTH. Only rendering proves the wiring.
        const source = 'export default component C() { form rows[] = { qty: "9" }; rows.append();'
            + ' <For each={(rows).rows()} key={(row) => row.key} let={ row }><input bind:value={row.qty} /></For> }';
        expect(codes(source)).toEqual([]);
        const html = renderToString(() => compile(source)() as never);
        expect(html).toContain('value="9"');
    });

    it('wires an array-form row bind inside an expression hole, RENDERED', () =>
    {
        // The row registry used to stop at element/fragment children, so a <For> inside a hole
        // compiled its row binds RAW - and the first fix for that emitted the form sugar in the
        // wrong SHAPE (record access on a getter param), converting the silent dead bind into a
        // mount crash. A presence check on `setValue` passed against both defects; only
        // rendering the compiled output proves the wiring, so that is what this asserts.
        const source = 'export default component C() { form rows[] = { qty: "7" }; rows.append(); state c = true;'
            + ' <div>{ c ? <For each={rows.rows()} key={(row) => row.key} let={ row }>'
            + '<input bind:value={row.qty} /></For> : null }</div> }';
        expect(codes(source)).toEqual([]);
        const html = renderToString(() => compile(source)() as never);
        expect(html).toContain('<input');
        expect(html).toContain('value="7"');
    });

    it('still accepts and drives the LITERAL fields of a spread form', () =>
    {
        // Openness must reject only what the compiler cannot wire. `remember` is written in the
        // literal, so it rewrites and works; `password` arrives via the spread and is rejected.
        const source = 'const base = { password: "" };\nexport default component C() { form login = { ...base, remember: "y" }; <input bind:value={login.remember} /> }';
        expect(codes(source)).toEqual([]);
        const el = mount(source);
        const input = el as HTMLInputElement;
        expect(input.value).toBe('y');
        type(input, 'n');
        expect(input.value).toBe('n');
    });

    it('composes an author onInput with the write-back inside a hole, executed', () =>
    {
        const calls: string[] = [];
        (globalThis as Record<string, unknown>).__announce = (): void =>
        {
            calls.push('x');
        };
        const el = mount('export default component C() { state d = "a"; state c = true; <div>{ c ? <input bind:value={d} onInput={__announce} /> : null }</div> }');
        const input = el.querySelector('input') as HTMLInputElement;
        type(input, 'b');
        expect(input.value).toBe('b');
        expect(calls.length).toBe(1);
        delete (globalThis as Record<string, unknown>).__announce;
    });
});

describe('bind contract - every resolvable invalid target is a precise error', () =>
{
    const INVALID: ReadonlyArray<readonly [string, string, string]> = [
        ['derived', 'export default component C() { state x = "a"; derived up = x().toUpperCase(); <input bind:value={up} /> }', '`derived` value'],
        ['deferred', 'export default component C() { state x = "a"; deferred slow = x(); <input bind:value={slow} /> }', '`deferred` value'],
        ['plain let', 'export default component C() { let x = "a"; <input bind:value={x} /> }', 'plain variable'],
        ['destructured let', 'export default component C() { let { x } = { x: "a" }; <input bind:value={x} /> }', 'plain variable'],
        ['module-scope let', 'let g = "a";\nexport default component C() { <input bind:value={g} /> }', 'module-scope variable'],
        ['import', 'import { g } from "./g.ts";\nexport default component C() { <input bind:value={g} /> }', 'an import'],
        ['props path', 'export default component C(props: { draft: string }) { <input bind:value={props.draft} /> }', 'prop'],
        ['destructured prop', 'export default component C({ draft }: { draft: string }) { <input bind:value={draft} /> }', 'prop'],
        ['bare form handle', 'export default component C() { form login = { email: "" }; <input bind:value={login} /> }', 'form` handle'],
        ['bare store handle', 'export default component C() { store box = { a: 1 }; <input bind:value={box} /> }', 'store` handle'],
        ['bare resource handle', 'export default component C() { resource r = () => fetch("/x"); <input bind:value={r} /> }', 'resource` handle'],
        ['bare stream handle', 'export default component C() { stream s = () => connect(); <input bind:value={s} /> }', 'stream` handle'],
        ['bare selector handle', 'export default component C() { state x = 1; selector sel = (k) => k === x(); <input bind:value={sel} /> }', 'selector` handle'],
        ['store path', 'export default component C() { store box = { a: { b: "x" } }; <input bind:value={box.a.b} /> }', 'store` handle'],
        ['destructured-prop path', 'export default component C({ user }: { user: { name: string } }) { <input bind:value={user.name} /> }', 'prop'],
        ['open-form field', 'const seed = { email: "" };\nexport default component C() { form login = seed; <input bind:value={login.email} /> }', 'not knowable at compile time'],
        ['spread-form unknown field', 'const base = { password: "" };\nexport default component C() { form login = { ...base, remember: true }; <input bind:value={login.password} /> }', 'not knowable at compile time'],
        ['empty-form field', 'export default component C() { form login = {}; <input bind:value={login.email} /> }', 'declares no fields'],
        ['deep unknown form field', 'export default component C() { form login = { email: "" }; <input bind:value={login.nosuch.deeper} /> }', 'not a field of `form login`'],
        ['parenthesized state', 'export default component C() { state x = "a"; <input bind:value={(x)} /> }', 'parenthes'],
        ['binary expression', 'export default component C() { state x = "a"; state y = "b"; <input bind:value={x + y} /> }', 'not an assignable expression'],
        ['call expression', 'export default component C() { state x = "a"; <input bind:value={x()} /> }', 'not an assignable expression'],
        ['template literal', 'export default component C() { <input bind:value={`t`} /> }', 'not an assignable expression'],
        ['optional chain', 'export default component C() { store box = { a: 1 }; const alias = box; <input bind:value={alias?.a} /> }', 'optional chain'],
        ['module-scope statement markup', 'let g = "a";\nconst row = <input bind:value={g} />;\nexport default component C() { <div>{row}</div> }', 'bind:'],
        ['function declaration local', 'export default component C() { function helper() { return 1; } <input bind:value={helper} /> }', 'plain variable'],
        ['spaced store dot', 'export default component C() { store theme = { dark: false }; <input bind:value={theme . dark} /> }', 'store` handle'],
        ['commented prop dot', 'export default component C({ user }: { user: { name: string } }) { <input bind:value={user /* c */ .name} /> }', 'prop'],
        ['newline dot on a form', 'export default component C() { form login = { email: "" }; <input bind:value={login\n.nosuch} /> }', 'not a field of `form login`'],
        ['open array-form row field', 'const makeRow = () => ({ qty: "0" });\nexport default component C() { form rows[] = makeRow(); <For each={rows.rows()} key={(row) => row.key} let={ row }><input bind:value={row.qty} /></For> }', 'not knowable at compile time'],
        ['dotted array-form handle', 'export default component C() { form rows[] = { qty: "0" }; <input bind:value={rows.qty} /> }', 'no fields of its own'],
        ['bare array-form handle', 'export default component C() { form rows[] = { qty: "0" }; <input bind:value={rows} /> }', 'no fields of its own'],
        ['this, dotted', 'export default component C() { <input bind:value={this.x} /> }', 'never one'],
        ['this, bare', 'export default component C() { <input bind:value={this} /> }', 'never one'],
        ['comma parens', 'export default component C() { state x = "a"; state y = "a"; <input bind:value={(x, y)} /> }', 'not an assignable expression'],
        ['paren-wrapped form field', 'export default component C() { form login = { email: "" }; <input bind:value={(login).email} /> }', 'plainly'],
        ['non-null form field', 'export default component C() { form login = { email: "" }; <input bind:value={login!.email} /> }', 'plainly'],
        ['bracket-access form field', 'export default component C() { form login = { email: "" }; <input bind:value={login["email"]} /> }', 'plainly'],
        ['paren-wrapped row field', 'export default component C() { form rows[] = { qty: "0" }; <For each={rows.rows()} key={(row) => row.key} let={ row }><input bind:value={(row).qty} /></For> }', 'plainly'],
        ['paren-wrapped this chain', 'export default component C() { <input bind:value={(this).x} /> }', 'never one'],
        ['paren-wrapped bare this', 'export default component C() { <input bind:value={(this)} /> }', 'never one'],
        ['template-literal bracket key', 'export default component C() { form login = { email: "" }; <input bind:value={login[`email`]} /> }', 'plainly'],
        ['non-identifier form key', 'export default component C() { form login = { "e-mail": "" }; <input bind:value={login["e-mail"]} /> }', 'not an identifier'],
        ['bare handle of a form with only non-identifier keys', 'export default component C() { form login = { "e-mail": "" }; <input bind:value={login} /> }', 'none of its field names'],
        ['bare array-form handle with mixed keys recommends the wirable one', 'export default component C() { form rows[] = { "e-mail": "", qty: "" }; <input bind:value={rows} /> }', 'row.qty'],
        ['empty target', 'export default component C() { <input bind:value={} /> }', 'empty'],
        ['comment-only target', 'export default component C() { <input bind:value={/* soon */} /> }', 'not a valid target expression'],
        ['leading-dot target', 'export default component C() { form login = { email: "" }; <input bind:value={.email} /> }', 'not a valid target expression'],
        ['deep form chain', 'export default component C() { form profile = { address: { city: "" } }; <input bind:value={profile.address.city} /> }', 'deeper than the field'],
        ['unknown row field', 'export default component C() { form rows[] = { qty: "0" }; <For each={rows.rows()} key={(row) => row.key} let={ row }><input bind:value={row.nosuch} /></For> }', 'not a row field'],
        ['unicode plain local', 'export default component C() { let café = "x"; <input bind:value={café} /> }', 'plain variable'],
        ['plain row whose field an array-form row claims', 'export default component C() { form extra[] = { x: "" }; state items = ["a"]; <div><For each={items} let={row}><input bind:value={row.x} /></For><For each={extra.rows()} key={(row) => row.key} let={ row }><span>y</span></For></div> }', 'Rename one'],
        ['row field dropped by a later registration', 'export default component C() { form a[] = { x: "" }; form b[] = { y: "" }; <div><For each={a.rows()} key={(row) => row.key} let={ row }><input bind:value={row.x} /></For><For each={b.rows()} key={(row) => row.key} let={ row }><input bind:value={row.y} /></For></div> }', 'Rename one'],
        ['resource path', 'export default component C() { resource r = () => fetch("/x"); <input bind:value={r.data} /> }', 'resource` handle'],
        ['unknown form field', 'export default component C() { form login = { email: "" }; <input bind:value={login.nosuch} /> }', 'not a field of `form login`'],
        ['For row', 'export default component C() { state items = ["a"]; <For each={items} let={item}><input bind:value={item} /></For> }', 'row binding'],
        ['For row through a hole', 'export default component C() { state items = ["a"]; state cond = true; <For each={items} let={item}><div>{ cond ? <input bind:value={item} /> : null }</div></For> }', 'row binding'],
        ['For index', 'export default component C() { state items = ["a"]; <For each={items} let={item} index={i}><input bind:value={i} /></For> }', 'row binding'],
        ['arrow param in a hole', 'export default component C() { state items = ["a"]; <ul>{ items.map((it) => <li><input bind:value={it} /></li>) }</ul> }', 'function parameter'],
        ['fn param in statement markup', 'export default component C() { const render = (item) => <input bind:value={item} />; <div>{render("a")}</div> }', 'function parameter'],
        ['param shadowing a state', 'export default component C() { state x = "a"; <div>{ ["b"].map((x) => <input bind:value={x} />) }</div> }', 'function parameter']
    ];

    for (const [label, source, fragment] of INVALID)
    {
        it(`rejects ${ label }`, () =>
        {
            expect(codes(source)).toContain('azeroth/bind-target-not-reactive');
            expect(messageOf(source)).toContain(fragment);
        });
    }

    it('rejects bind:value on a static file input with its own code', () =>
    {
        const source = 'export default component C() { state f = ""; <input type="file" bind:value={f} /> }';
        expect(codes(source)).toContain('azeroth/bind-file-input');
        expect(messageOf(source)).toContain('files');
    });

    it('reports EVERY offending bind, not the first per name', () =>
    {
        // The old rule deduplicated per NAME per component, so fixing the first finding
        // surfaced the next one build by build.
        const source = 'export default component C() { let a = "x"; let b = "y"; <div><input bind:value={a} /><input bind:value={b} /><textarea bind:value={a} /></div> }';
        const found = diagnoseModule(source).filter(d => d.code === 'azeroth/bind-target-not-reactive');
        expect(found.length).toBe(3);
    });
});

describe('bind contract - hole reads report an exact registry disagreement, nothing softer', () =>
{
    // What survives is decidable from two tables: this row lexically carries the field and the
    // name-keyed registry does not, or the reverse. Everything softer was retired after six
    // adversarial rounds - reporting a read because the registry merely CLAIMS the name refused a
    // helper called with the row, a statement-scoped local, and a row whose `each=` could not be
    // followed, every one of which compiles and renders correctly.
    it('reports a row whose field another row of the same name drops', () =>
    {
        expect(codes('export default component C() { form a[] = { x: "1" }; form b[] = { y: "2" };'
            + ' <div><For each={a.rows()} key={(row) => row.key} let={ row }><i>{row.x}</i></For>'
            + '<For each={b.rows()} key={(row) => row.key} let={ row }><b>{row.y}</b></For></div> }'))
            .toContain('azeroth/row-name-collision');
    });

    it('says nothing about a helper or a callback parameter sharing a row name', () =>
    {
        const form = 'form rows[] = { qty: "0" };';
        expect(codes(`export default component C() { ${ form } const label = (row) => row.qty;`
            + ' <For each={rows.rows()} key={(r) => r.key} let={ row }><i>{label(row)}</i></For> }'))
            .toEqual([]);
        expect(codes(`export default component C() { ${ form } state other = [{ qty: "P" }];`
            + ' <div><For each={rows.rows()} key={(r) => r.key} let={ row }><i>{row.qty}</i></For>'
            + '<b>{other.map((row) => row.qty).join(",")}</b></div> }')).toEqual([]);
    });

    it('leaves same-form holes and API reads alone', () =>
    {
        expect(codes('export default component C() { form rows[] = { qty: "0" }; <div>'
            + '<For each={rows.rows()} key={(row) => row.key} let={ row }><i>{row.qty}</i></For>'
            + '<For each={rows.rows()} key={(row) => row.key} let={ row }><b>{row.qty}</b></For></div> }'))
            .toEqual([]);
    });
});
describe('bind contract - what the rule cannot resolve stays silent', () =>
{
    const SILENT: ReadonlyArray<readonly [string, string]> = [
        ['an undeclared ambient name', 'export default component C() { <input bind:value={somethingAmbient} /> }'],
        ['a dotted path through a local alias', 'export default component C() { store box = { a: "x" }; const b = box; <input bind:value={b.a} /> }'],
        ['a dotted path with an imported head', 'import { theme } from "./theme.ts";\nexport default component C() { <input bind:value={theme.name} /> }'],
        ['an element-access lvalue', 'export default component C() { const arr = ["a"]; <input bind:value={arr[0]} /> }']
    ];

    for (const [label, source] of SILENT)
    {
        it(`leaves ${ label } alone`, () =>
        {
            expect(codes(source)).not.toContain('azeroth/bind-target-not-reactive');
        });
    }
});

describe('bind contract - which each= spellings LINK the row-field sugar', () =>
{
    const form = 'form rows[] = { qty: "0" };';
    const each = (decls: string, expr: string): string =>
        `export default component C() { ${ form } ${ decls } <For each={${ expr }} `
        + 'key={(r) => r.key} let={ row }><input bind:value={row.qty} /></For> }';
    const wires = (source: string): boolean =>
    {
        const generated = generateModule(source, 'T.azeroth', {});
        return (typeof generated === 'string' ? generated : generated.code).includes('setValue');
    };

    // RESELECTING spellings keep every element of the receiver, so each row is still the same
    // { key, form } record and its fields wire exactly as on the whole list. Filtering completed
    // rows or sorting for display is the ordinary reason to hold an array form at all; these used
    // to emit a DEAD write onto the record while the projection kept typing the field.
    const LINKS: ReadonlyArray<readonly [string, string]> = [
        ['rows.rows()', ''],
        ['rows.rows', ''],
        ['rows.rows().filter((r) => true)', ''],
        ['rows.rows().toSorted()', ''],
        ['rows.rows().toReversed()', ''],
        ['[...rows.rows()]', ''],
        ['rows.rows().filter((r) => true).slice(0, 3)', ''],
        ['rows.rows().toSpliced(1, 0)', ''],
        ['c ? rows.rows() : []', 'state c = true;'],
        ['c ? [] : rows.rows()', 'state c = true;'],
        ['rows.rows() ?? []', ''],
        ['rows.rows() || []', '']
    ];
    for (const [expr, decls] of LINKS)
    {
        it(`links and wires each={${ expr }}`, () =>
        {
            const source = each(decls, expr);
            expect(codes(source)).toEqual([]);
            expect(wires(source)).toBe(true);
        });
    }

    // A KNOWN, DOCUMENTED RESIDUE, pinned deliberately rather than left to drift.
    //
    // A spelling the compiler cannot follow does not link, so the row fields stay raw and read
    // nothing. An earlier version of this rule tried to REPORT that by asking whether the `each=`
    // mentioned the form, and six rounds of adversarial review showed the question cannot be
    // answered from syntax: `rows.values()` is a documented getter returning plain objects,
    // `rows.isValid() ? list : []` mentions the form only in a guard, and a helper parameter named
    // like the row is correct when it receives the row. Each of those was refused with an
    // unsuppressable build error on code that compiles and renders correctly, so the guess was
    // retired. The unlinked spellings are silent again - dead fields, never a false build failure.
    const RESIDUE = [
        'rows.rows().map((r) => r)',
        'rows.values()',
        'rows.rows().concat([])',
        'rows.rows().toSpliced(1, 0, { key: "g", form: null })'
    ];
    for (const expr of RESIDUE)
    {
        it(`does not link each={${ expr }}, and says nothing about it`, () =>
        {
            const source = each('', expr);
            expect(codes(source)).toEqual([]);
            expect(wires(source)).toBe(false);
        });
    }

    it('leaves an ordinary list alone whatever it is spelled like', () =>
    {
        // Every one of these named an array form somewhere and was refused by the retired guess,
        // though none of them iterates its rows.
        const shapes: ReadonlyArray<readonly [string, string]> = [
            ['state group = { rows: [{ key: 1 }] };', 'group.rows'],
            ['state other = [];', 'other.filter((x) => x.tag === "rows")'],
            ['state other = [];', 'other /* rows live elsewhere */'],
            ['state other = [{ key: 1 }];', 'other.filter((rows) => rows.key > 0)'],
            ['state other = []; state ok = true;', 'ok ? other : []'],
            ['state other = [];', 'paginate(other, { rows: 10 })']
        ];
        for (const [decls, expr] of shapes)
        {
            expect(codes(each(decls, expr))).toEqual([]);
        }
    });

    it('refuses the bare array-form HANDLE only through the runtime, not the compiler', () =>
    {
        // `each={rows}` passes the FieldArrayApi itself - neither an array nor a getter - and
        // <For> throws "expected an array, received object" at first render. It does not LINK
        // (so no sugar is emitted onto a list that never renders), and it is not a compile error:
        // deciding that needs the guess that was retired. The failure is loud either way.
        const source = each('', 'rows');
        expect(codes(source)).toEqual([]);
        expect(wires(source)).toBe(false);
    });
});

describe('bind contract - what the rule cannot resolve stays silent', () =>
{
    const SILENT: ReadonlyArray<readonly [string, string]> = [
        ['an undeclared ambient name', 'export default component C() { <input bind:value={somethingAmbient} /> }'],
        ['a dotted path through a local alias', 'export default component C() { store box = { a: "x" }; const b = box; <input bind:value={b.a} /> }'],
        ['a dotted path with an imported head', 'import { theme } from "./theme.ts";\nexport default component C() { <input bind:value={theme.name} /> }'],
        ['an element-access lvalue', 'export default component C() { const arr = ["a"]; <input bind:value={arr[0]} /> }']
    ];

    for (const [label, source] of SILENT)
    {
        it(`leaves ${ label } alone`, () =>
        {
            expect(codes(source)).not.toContain('azeroth/bind-target-not-reactive');
        });
    }
});

describe('bind contract - an each= that cannot link is loud, not silently dead', () =>
{
    const form = 'form rows[] = { name: "" };';
    const each = (expr: string): string =>
        `export default component C() { ${ form } <ul><For each={${ expr }} key={(row) => row.key} `
        + 'let={ row }><li><input bind:value={row.name} /></li></For></ul> }';

    // RESELECTING spellings keep every element of the receiver, so each row is still the same
    // { key, form } record and its fields wire exactly as on the whole list. Filtering completed
    // rows or sorting for display is the ordinary reason to hold an array form at all; these
    // used to emit a DEAD write onto the record while the projection kept typing the field.
    const LINKS = ['rows.rows()', 'rows.rows().filter((r) => true)', 'rows.rows().toSorted()', '[...rows.rows()]', 'rows.rows().filter((r) => true).slice(0, 3)'];
    for (const expr of LINKS)
    {
        it(`links and wires each={${ expr }}`, () =>
        {
            const source = each(expr);
            expect(codes(source)).toEqual([]);
            const generated = generateModule(source, 'T.azeroth', {});
            const code = typeof generated === 'string' ? generated : generated.code;
            expect(code).toContain('setValue');
        });
    }

    // The spellings the compiler cannot follow are covered by the residue pins above: they do
    // not link, and they are SILENT. Reporting them needed a guess about intent that six rounds of
    // review showed cannot be made from syntax.

    it('says nothing about a plain For that never mentions an array form', () =>
    {
        expect(codes('export default component C() { form rows[] = { name: "" }; state items = [1];'
            + ' <For each={items} key={(i) => i} let={ row }><li>{row.other}</li></For> }')).toEqual([]);
    });
});

describe('bind contract - a host bind claims its target key (uniqueness)', () =>
{
    const host = (markup: string): string =>
        `export default component C() { state v = "a"; ${ markup } }`;

    it('rejects bind:value alongside a value attribute, in either order, pointing at the second writer', () =>
    {
        for (const [markup, secondWriter] of [
            ['<input bind:value={v} value={"y"} />', 'value={"y"}'],
            ['<input value={"y"} bind:value={v} />', 'bind:value={v}']
        ] as const)
        {
            const source = host(markup);
            const findings = diagnoseModule(source);
            expect(findings.map((d) => d.code)).toEqual(['azeroth/duplicate-attr']);
            expect(findings[0]!.message).toContain('two writers');
            expect(source.slice(findings[0]!.start, findings[0]!.end)).toBe(secondWriter);
        }
    });

    it('collides the STATIC spelling too - the form that bakes into the cloned template', () =>
    {
        expect(diagnoseModule(host('<input bind:value={v} value="y" />')).map((d) => d.code))
            .toEqual(['azeroth/duplicate-attr']);
    });

    it('claims case-folded: VALUE and value are one parsed attribute', () =>
    {
        expect(diagnoseModule(host('<input bind:value={v} VALUE="y" />')).map((d) => d.code))
            .toEqual(['azeroth/duplicate-attr']);
        const plain = diagnoseModule(host('<input value="a" VALUE="b" />'));
        expect(plain.map((d) => d.code)).toEqual(['azeroth/duplicate-attr']);
        expect(plain[0]!.message).toContain('case-insensitively');
    });

    it('claims handler forms by EVENT TYPE: case-variant spellings of one event collide', () =>
    {
        const pair = diagnoseModule(host('<button onMousedown={() => 1} onMouseDown={() => 2}>x</button>'));
        expect(pair.map((d) => d.code)).toEqual(['azeroth/duplicate-attr']);
        expect(pair[0]!.message).toContain("'mousedown' event");
        expect(diagnoseModule(host('<input bind:value={v} onInput={() => 0} onINPUT={() => 0} />')).map((d) => d.code))
            .toEqual(['azeroth/duplicate-attr']);
    });

    it('rejects a static or bare bind: it never binds, on hosts and components alike', () =>
    {
        expect(diagnoseModule(host('<input bind:value="lit" />')).map((d) => d.code))
            .toEqual(['azeroth/bind-value']);
        expect(diagnoseModule(host('<input bind:value />')).map((d) => d.code))
            .toEqual(['azeroth/bind-value']);
        expect(diagnoseModule(host('<Widget bind:value="lit" />')).map((d) => d.code))
            .toContain('azeroth/bind-value');
        // The claim stays on the FULL name for a non-binding bind:, so the value attribute
        // does not spuriously collide with an already-rejected spelling.
        expect(diagnoseModule(host('<input bind:value="lit" value="y" />')).map((d) => d.code))
            .toEqual(['azeroth/bind-value']);
    });

    it('claims every bind target, not just value', () =>
    {
        expect(diagnoseModule(host('<input type="checkbox" bind:checked={v} checked />')).map((d) => d.code))
            .toEqual(['azeroth/duplicate-attr']);
    });

    it('keeps the compositions the grammar defines: write-back handler, class directives', () =>
    {
        expect(diagnoseModule(host('<input bind:value={v} onInput={() => undefined} />'))).toEqual([]);
        expect(diagnoseModule(host('<input type="checkbox" bind:checked={v} onChange={() => undefined} />'))).toEqual([]);
        expect(diagnoseModule(host('<div class="a" class:active={true}>x</div>'))).toEqual([]);
        expect(diagnoseModule(host('<input bind:value={v} />'))).toEqual([]);
    });

    it('keeps the plain duplicate message for same-spelling repeats', () =>
    {
        const findings = diagnoseModule(host('<input value={"a"} value={"b"} />'));
        expect(findings.map((d) => d.code)).toEqual(['azeroth/duplicate-attr']);
        expect(findings[0]!.message).toContain('Duplicate attribute');
    });

    it('leaves the component-side duplicate-prop rule untouched', () =>
    {
        const source = 'export default component C() { state v = "a"; <Widget bind:value={v} value={"y"} /> }';
        expect(diagnoseModule(source).map((d) => d.code)).toContain('azeroth/duplicate-prop');
    });
});
