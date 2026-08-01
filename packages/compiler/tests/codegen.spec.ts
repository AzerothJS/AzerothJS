// @vitest-environment node
//
// Real-execution coverage for generateModule (the unified IR codegen backend).
// Validates the emitted JS STRUCTURE: runtime import wiring, state/derived/effect
// desugaring, the R2 read/write rewrite, the mode-dispatched element-rooted body
// (tmpl clone + isStringMode/isHydrating h-tree), holes (bindHole), slots
// (bindSlot), attributes (setProp), events, spreads/refs (bindProps), constant
// folding, fragment roots, opaque passthrough, and source-map emission.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateModule } from '../src/codegen.ts';
import { CompileError } from '../src/markup-parser.ts';

function gen(src: string): string
{
    return generateModule(src).code;
}

/**
 * Parses the emitted module as real JavaScript (`node --check`, ESM), returning null when it parses
 * and the reported syntax error otherwise. Asserting on the emitted TEXT cannot catch a literal that
 * silently fails to parse, which is exactly how a raw CR shipped.
 */
function syntaxErrorOf(code: string): string | null
{
    const dir = mkdtempSync(join(tmpdir(), 'az-emit-'));
    try
    {
        const file = join(dir, 'emitted.mjs');
        writeFileSync(file, code);
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        return null;
    }
    catch (err)
    {
        const stderr = (err as { stderr?: Buffer }).stderr;
        return stderr ? stderr.toString() : String(err);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('generateModule - module shape and imports', () =>
{
    it('emits a factory function and imports the runtime helpers it uses', () =>
    {
        const code = gen('component Hi { <h1>hi</h1> }');
        expect(code).toContain('function Hi(props = {})');
        expect(code).toContain('from \'azerothjs/internal\'');
        // A static host output hoists a tmpl() clone.
        expect(code).toMatch(/const _tmpl\$1 = tmpl\(/);
        expect(code).toContain('import { ');
    });

    it('copies opaque host code through verbatim', () =>
    {
        const code = gen('const greeting = "hi";\ncomponent Hi { <h1>hi</h1> }');
        expect(code).toContain('const greeting = "hi";');
    });

    it('returns the source unchanged with a null map when there is no component', () =>
    {
        const result = generateModule('export const x = 1;');
        expect(result.code).toBe('export const x = 1;');
        expect(result.map).toBe(null);
    });

    it('does not re-import a runtime name the source already imports', () =>
    {
        const code = gen('import { createSignal } from \'azerothjs\';\ncomponent C { state n = 0; <p>{n}</p> }');
        // createSignal is used but already imported, so the injected import omits it.
        const injected = code.split('\n').find(l => l.startsWith('import { ') && l.includes('bindContent'));
        expect(injected).toBeDefined();
        expect(injected).not.toContain('createSignal');
    });
});

describe('generateModule - reactive desugaring', () =>
{
    it('desugars state to createSignal with a matching setter name', () =>
    {
        const code = gen('component C { state count = 0; <p>{count}</p> }');
        expect(code).toContain('const [count, setCount] = createSignal(0);');
    });

    it('desugars derived to createMemo over a rewritten initializer', () =>
    {
        const code = gen('component C { state n = 0; derived doubled = n * 2; <p>{doubled}</p> }');
        expect(code).toContain('const doubled = createMemo(() => (n() * 2));');
    });

    it('desugars effect to createEffect over rewritten statements', () =>
    {
        const code = gen('component C { state n = 0; effect { console.log(n); } <p>{n}</p> }');
        expect(code).toContain('createEffect(() => { console.log(n()); });');
    });

    it('desugars `effect (deps) { ... }` to the on() explicit-dependency primitive', () =>
    {
        const code = gen('component C { state n = 0; effect (n) { save(n); } <p>{n}</p> }');
        expect(code).toContain('on([() => (n())], () => { save(n()); });');
    });

    it('passes `effect (deps)` deferral + previous values through to on()', () =>
    {
        const code = gen('component C { state a = 0; effect (a) (cur, prev) with { defer: true } { log(cur, prev); } <p>{a}</p> }');
        expect(code).toContain('on([() => (a())], (cur, prev) => { log(cur, prev); }, { defer: true });');
    });

    it('desugars `deferred` to createDeferred (a read-only reactive value, like derived)', () =>
    {
        const code = gen('component C { state n = 0; deferred slow = n * 2; <p>{slow}</p> }');
        expect(code).toContain('const slow = createDeferred(() => (n() * 2));');
    });

    it('rewrites destructured-prop reads to props.<name> (reactive alias), with `??` defaults', () =>
    {
        const code = gen('component Card({ title, size = "sm" }: CardProps) { <p class={size}>{title}</p> }');
        // The runtime function still takes a single `props` object; the destructured names are aliases.
        expect(code).toContain('function Card(props = {})');
        expect(code).toContain('props.title');
        expect(code).toContain('(props.size ?? "sm")');
        // A snapshot `const { ... } = props` would lose reactivity, so it must NOT be emitted.
        expect(code).not.toContain('= props;');
    });

    it('supports number / object / array (any-expression) defaults in destructured props', () =>
    {
        const code = gen('component C({ count = 0, opts = {}, items = [] }: P) { <ul>{count}{opts.x}{items.length}</ul> }');
        expect(code).toContain('(props.count ?? 0)');
        expect(code).toContain('(props.opts ?? {})');
        expect(code).toContain('(props.items ?? [])');
    });

    it('bind:value desugars to a reactive value + a write-back input listener (assignment -> setter)', () =>
    {
        const code = gen('component C { state name = ""; <input bind:value={name} /> }');
        // Write-back: `name = $event.target.value` rewritten to the setter.
        expect(code).toContain('setName($event.target.value)');
        // The value side reads the state reactively.
        expect(code).toContain('name()');
    });

    it('effect-wraps an attribute value that is an explicit getter, even with no VISIBLE dependency', () =>
    {
        // `code` is a plain string param here, not a signal - so static analysis finds no dependency, and
        // wrapDynamic passes an already-function-shaped value through unchanged. Neither signal on its own
        // would catch this; the fix is the explicit isFunctionLiteral check alongside them. Regression for
        // a real bug: a DOM element's `class={ () => ... }` (an explicit author-written getter, the same
        // idiom the framework's own docs teach for list-row labels) was bound with a BARE setProp call - no
        // createEffect - so it read correctly once at mount and then silently never updated again.
        const code = gen('component C(props: { code: string }) { <button class={ () => "a " + props.code }>x</button> }');
        expect(code).toContain('createEffect(() => setProp(');
        // Every setProp call is effect-wrapped - none left bare.
        const setPropCalls = code.match(/setProp\(/g) ?? [];
        const wrappedCalls = code.match(/createEffect\(\(\) => setProp\(/g) ?? [];
        expect(setPropCalls.length).toBe(wrappedCalls.length);
    });

    it('still effect-wraps when the getter body has a directly visible dependency (baseline, must not regress)', () =>
    {
        const code = gen('component C { state active = false; <button class={ () => (active() ? "on" : "off") }>x</button> }');
        expect(code).toContain('createEffect(() => setProp(');
    });

    it('effect-wraps an attribute value that is a bare reference to a locally defined getter function', () =>
    {
        // The same bug as the function-literal case, one level of indirection further: `rowClass` is a
        // const arrow function defined in the component body, referenced by NAME at the attribute site -
        // dependency analysis sees only the bare identifier `rowClass`, not the signal read inside its
        // body, so it has no way to know this is reactive without this fix. wrapDynamic's own doc comment
        // already calls a bare reference here "a signal getter" - this makes the effect-wrapping decision
        // honor that stated intent, not just the value-wrapping decision.
        const code = gen(`component C
        {
            state active = false;
            const rowClass = (): string => (active() ? "on" : "off");
            <button class={ rowClass }>x</button>
        }`);
        const setPropCalls = code.match(/setProp\(/g) ?? [];
        const wrappedCalls = code.match(/createEffect\(\(\) => setProp\(/g) ?? [];
        expect(setPropCalls.length).toBeGreaterThan(0);
        expect(setPropCalls.length).toBe(wrappedCalls.length);
    });

    it('bind:checked writes back on `change`, reading `$event.target.checked`', () =>
    {
        const code = gen('component C { state on = false; <input type="checkbox" bind:checked={on} /> }');
        expect(code).toContain('setOn($event.target.checked)');
        expect(code).toContain('change');
    });

    it('bind:value on a component desugars to a value getter + an onInput write-back (value passed directly)', () =>
    {
        const code = gen('import Field from "./Field.azeroth"; component C { state name = ""; <Field bind:value={name} /> }');
        // Value side: a reactive getter for the bound state.
        expect(code).toContain('get value() { return (name()); }');
        // Write-back: the component calls onInput with the new VALUE (not a DOM event), rewritten to setter.
        expect(code).toContain('get onInput() { return (($event) => setName($event)); }');
    });

    it('bind:checked on a component writes back through onChange', () =>
    {
        const code = gen('import Toggle from "./Toggle.azeroth"; component C { state on = false; <Toggle bind:checked={on} /> }');
        expect(code).toContain('get checked() { return (on()); }');
        expect(code).toContain('get onChange() { return (($event) => setOn($event)); }');
    });

    it('a component on* callback prop keeps its authored casing (it is a prop, not a DOM event)', () =>
    {
        const code = gen('import Ticket from "./Ticket.azeroth"; component C { <Ticket onSideChange={(next) => next} /> }');
        expect(code).toContain('get onSideChange()');
        expect(code).not.toContain('onSidechange');
    });

    it('bind: composed with an authored same-name callback keeps BOTH under one key, write-back first', () =>
    {
        const code = gen('import Field from "./Field.azeroth"; component C { state name = ""; <Field bind:value={name} onInput={(v) => console.log(v)} /> }');
        const accessors = [...code.matchAll(/get onInput\(\)/g)];
        expect(accessors.length).toBe(1);
        // The state the user just produced must be visible to the authored handler.
        expect(code.indexOf('setName($event)')).toBeGreaterThan(-1);
        expect(code.indexOf('setName($event)')).toBeLessThan(code.indexOf('console.log(v)'));
    });

    it('rejects bind: to a read-only derived on a component (same write-back guard as DOM)', () =>
    {
        expect(() => gen('import Field from "./Field.azeroth"; component C { state a = 1; derived d = a + 1; <Field bind:value={d} /> }'))
            .toThrow(/read-only/);
    });

    it('form keyword lowers to createForm({ initial, ...with })', () =>
    {
        const code = gen('import { createForm } from "azerothjs"; component C { form f = { a: "" } with { onSubmit: (v) => { void v; } }; <p>{f.values().a}</p> }');
        expect(code).toContain('const f = createForm({ initial: ({ a: "" }), ...({');
        expect(code).toContain('onSubmit');
    });

    it('form keyword with no with-clause lowers to createForm({ initial })', () =>
    {
        const code = gen('import { createForm } from "azerothjs"; component C { form f = { a: 0 }; <p>{f.values().a}</p> }');
        expect(code).toContain('const f = createForm({ initial: ({ a: 0 }) });');
    });

    it('array-form keyword (form NAME[]) lowers to createFieldArray({ blank, ...with })', () =>
    {
        const code = gen('component C { form rows[] = { a: "" } with { validateArray: (rows) => rows.length ? null : "x" }; <button onClick={() => rows.append()}>Add</button> }');
        expect(code).toContain('const rows = createFieldArray({ blank: () => ({ a: "" }), ...({');
        expect(code).toContain('validateArray');
        expect(code).toContain('import { createFieldArray');   // runtime import wired
    });

    it('array-form keyword with no with-clause lowers to createFieldArray({ blank })', () =>
    {
        const code = gen('component C { form rows[] = { a: 0 }; <button onClick={() => rows.append()}>Add</button> }');
        expect(code).toContain('const rows = createFieldArray({ blank: () => ({ a: 0 }) });');
    });

    it('<For> over an array-form sugars the row field through .form (read + bind write)', () =>
    {
        const code = gen('component C { form rows[] = { a: "" }; <For each={rows.rows()} key={(row) => row.key}>{(row) => <input bind:value={row.a} />}</For> }');
        expect(code).toContain('row().form.values().a');        // row field read -> the getter call, then .form.values()
        expect(code).toContain('row().form.setValue("a"');      // bind: write -> row().form.setValue()
        expect(code).toContain('(row) => row.key');               // row.key in the key fn stays literal
    });

    it('<For> row reads gain the getter call: member, bare, and index - the key fn stays by-value', () =>
    {
        const code = gen('component C { state items = [{ id: 1, name: "a" }]; <For each={items} key={(row) => row.id}>{(row, index) => <li data-n={index} onClick={() => console.log(row)}>{row.name}</li>}</For> }');
        expect(code).toContain('row().name');                   // member read through the getter
        expect(code).toContain('console.log(row())');           // bare read through the getter
        expect(code).toContain('index()');                        // the index param is a getter too
        expect(code).toContain('(row) => row.id');                // the key fn receives the VALUE
    });

    it('a callback outside the row does not catch the row rewrite', () =>
    {
        const code = gen('component C { state items = [{ id: 1 }]; const total = (row) => row.id; <For each={items} key={(row) => row.id}>{(row) => <li>{row.id}</li>}</For> }');
        expect(code).toContain('const total = (row) => row.id');  // same param name outside the For - untouched
    });

    it('a <For> EMBEDDED in a component prop expression keeps the row rewrite, marker-free output', () =>
    {
        // Regression: a For inside a factory prop (`fallback={ <div><For ...> ... }`) lowers
        // in raw mode, deferring the single rewrite to the enclosing pass - which has no IR
        // to learn the row param from. The raw emission wraps the render arrow in the
        // reserved `__azRow(...)` marker; the walk scopes its params as rows and the rewrite
        // strips the wrapper, so no marker ever reaches emitted code.
        const code = gen('component C { state items = [{ id: 1, label: "x" }]; state on = true; <Show when={on} fallback={<ul><For each={items} key={(row) => row.id}>{(row) => <li title={`k-${ row.id }`}>{row.label}</li>}</For></ul>}><p>y</p></Show> }');
        expect(code).toContain('row().label');                    // member read through the getter
        expect(code).toContain('`k-${ row().id }`');              // template-literal read through the getter
        expect(code).toContain('(row) => row.id');                // the key fn still receives the VALUE
        expect(code).not.toContain('__azRow');                    // the marker is transport, not output
    });

    it('Dynamic `component=` is a FACTORY prop: markup emits the callable thunk the runtime calls', () =>
    {
        // The runtime contract is `component()` -> component-or-tag. A plain getter would make
        // the runtime call the RESOLVED value instead (invoking a component with no props, or
        // crashing on a tag string). The factory emission is what unifies markup with the
        // manual `Dynamic({ component: view })` API.
        const code = gen('component C { state tag = "path"; <svg><Dynamic component={ tag } props={ () => ({ d: "M0 0" }) } /></svg> }');
        expect(code).toContain('component: () => (tag())');
        expect(code).not.toContain('get component()');
    });

    it('factory emission is the COMPONENT\'s contract, never the prop NAME\'s', () =>
    {
        // A USER component with props that happen to be called `component`/`fallback` gets
        // plain reactive getters like any other prop - emission must depend on what the tag
        // IS, not on what the prop is named.
        const code = gen('import Uploader from "./Uploader.azeroth";\ncomponent C { state part = "a"; <Uploader component={ part } fallback={ part } /> }');
        expect(code).toContain('get component() { return (part()); }');
        expect(code).toContain('get fallback() { return (part()); }');
        expect(code).not.toContain('component: () =>');
    });

    it('Routes keeps its factory `fallback` (framework component outside the auto-import set)', () =>
    {
        const code = gen('import { Routes } from "azerothjs";\ncomponent C { <Routes fallback={ <p>404</p> } /> }');
        expect(code).toMatch(/fallback: \(\) => \(/);
        expect(code).not.toContain('get fallback()');
    });

    it('a HAND-WRITTEN For({ children }) call is untouched - For is public manual API', () =>
    {
        // The row rewrite must never key off the `For` NAME: the runtime For is public manual
        // API, and a manual children callback receives getters the author already calls
        // (`item()`). A name-based rewrite would emit `item()()`. Recognition rides the
        // compiler-emitted `__azRow` marker instead, which hand-written code cannot carry.
        const code = gen('import { For, h } from "azerothjs";\ncomponent C { state items = [1]; const manual = () => For({ each: () => items, key: (n) => n, children: (item) => h("li", {}, () => item()) }); <div>{ manual() }</div> }');
        expect(code).toContain('() => item()');                   // the author getter call, exactly as written
        expect(code).not.toContain('item()()');
    });

    it('a NESTED <For> inside a component-rooted row composes both row mechanisms', () =>
    {
        // The outer row is component-rooted (IR rowItems on the pass-through arrow); the inner
        // For lowers inside that expression in raw mode (marker path). Both rewrites land, both
        // key fns stay by-value, and the marker is stripped.
        const code = gen('component C { state groups = [{ id: 1, members: [{ id: 2, name: "m" }] }]; <For each={groups} key={(g) => g.id}>{(g) => <Panel title={g.id}><For each={g.members} key={(m) => m.id}>{(m) => <Row name={m.name} /> }</For></Panel>}</For> }');
        expect(code).toContain('g().id');                         // outer row read through the getter
        expect(code).toContain('g().members');                    // inner each reads the OUTER row getter
        expect(code).toContain('m().name');                       // inner row read through the getter
        expect(code).toContain('(g) => g.id');                    // outer key by-value
        expect(code).toContain('(m) => m.id');                    // inner key by-value
        expect(code).not.toContain('__azRow');
    });

    it('a COMPONENT-rooted row keeps the getter rewrite (pass-through path)', () =>
    {
        // Regression: a row rooted at a component takes the pass-through path (no clonable
        // template); without the captured param span rowItems is never built, `item={ row }`
        // hands the child the raw GETTER, and a row var in a template literal stringifies a
        // function body into the page.
        const code = gen('component C { state items = [{ id: 1 }]; <For each={items} key={(row) => row.id}>{(row) => <Show when={row.id > 0}><li title={`n-${ row.id }`}>{row.id}</li></Show>}</For> }');
        expect(code).toContain('row().id > 0');                   // bare prop expression through the getter
        expect(code).toContain('`n-${ row().id }`');              // template-literal read through the getter
        expect(code).toContain('(row) => row.id');                // the key fn still receives the VALUE
    });

    it('form FIELD read rewrites to values(); a write (and bind:) to setValue; API access is untouched', () =>
    {
        const code = gen('import { createForm } from "azerothjs"; component C { form f = { a: "" }; <form onSubmit={f.handleSubmit}><input bind:value={f.a} /><p>{f.a}</p><span>{f.submitting()}</span></form> }');
        expect(code).toContain('f.values().a');          // field read -> values()
        expect(code).toContain('f.setValue("a"');        // bind: write -> setValue
        expect(code).toContain('f.submitting()');        // FormApi access left as-is
        expect(code).toContain('f.handleSubmit');        // FormApi access left as-is
    });

    it('class:name={cond} merges with a static class into one reactive className', () =>
    {
        const code = gen('component C { state on = false; <span class="base" class:active={on}>x</span> }');
        expect(code).toContain("'base'");
        expect(code).toContain("(on()) ? 'active' : ''");
        expect(code).toContain(".filter(Boolean).join(' ')");
    });

    it('class:name merges with a dynamic class={expr}', () =>
    {
        const code = gen('component C { state tone = ""; state on = false; <span class={tone} class:active={on}>x</span> }');
        expect(code).toContain('tone()');
        expect(code).toContain("(on()) ? 'active' : ''");
    });

    it('style:prop={v} merges with a static style into one reactive style string', () =>
    {
        const code = gen('component C { state c = "red"; <span style="opacity: 1" style:color={c}>x</span> }');
        expect(code).toContain("'opacity: 1'");
        expect(code).toContain("'color: ' + (c())");
        expect(code).toContain(".filter(Boolean).join('; ')");
    });

    it('auto-wraps a computed {expr} reactive WITHOUT an explicit () => (a state read)', () =>
    {
        const code = gen('component C { state n = 0; <p>{format(n)}</p> }');
        expect(code).toContain('() => (format(n()))');
    });

    it('auto-wraps a computed {expr} reactive even when dep analysis sees no source', () =>
    {
        // `external()` is not a known source; the runtime effect still tracks whatever it reads.
        const code = gen('component C { <p>{format(external())}</p> }');
        expect(code).toContain('() => (format(external()))');
    });

    it('desugars the block-wrapper keywords (batch/untrack/cleanup/dispose/mount) to their runtime calls', () =>
    {
        expect(gen('component C { state a = 0; state b = 0; effect { batch { a = 1; b = 2; } } <p>{a}</p> }'))
            .toContain('batch(() => { setA(1); setB(2); });');
        expect(gen('component C { state n = 0; effect { cleanup { stop(n); } } <p>{n}</p> }'))
            .toContain('onCleanup(() => { stop(n()); });');
        expect(gen('component C { dispose { teardown(); } <p>x</p> }'))
            .toContain('onRootDispose(() => { teardown(); });');
        expect(gen('component C { state n = 0; effect { untrack { log(n); } } <p>{n}</p> }'))
            .toContain('untrack(() => { log(n()); });');
        expect(gen('component C { mount { chart.render(); } <p>x</p> }'))
            .toContain('onMount(() => { chart.render(); });');
    });

    it('mount is shape-gated: a call form and a shadowing local stay plain code', () =>
    {
        // `mount(fn);` is a plain call, not the keyword.
        const call = gen('component C { mount(fn); <p>x</p> }');
        expect(call).toContain('mount(fn);');
        expect(call).not.toContain('onMount');

        // The keyword reads the reactive scope like every wrapper: state reads rewrite.
        const reactive = gen('component C { state n = 0; mount { boot(n); } <p>{n}</p> }');
        expect(reactive).toContain('onMount(() => { boot(n()); });');
    });

    it('carries a state type annotation into the createSignal type argument', () =>
    {
        const code = gen('component C { state n: number = 0; <p>{n}</p> }');
        expect(code).toContain('createSignal<number>(0)');
    });

    it('returns null when the component has no markup output', () =>
    {
        expect(gen('component C { state n = 0; }')).toContain('return null;');
    });

    it('compiles markup returned from a body helper function (not just the top-level output)', () =>
    {
        const code = gen('component C { const row = () => <li>x</li>; <ul>{row()}</ul> }');
        // The helper`s markup must be compiled (h/tmpl), not left as raw JSX.
        expect(code).not.toMatch(/=>\s*<li/);
        expect(/row\b[\s\S]{0,80}(h\(|tmpl\()/.test(code)).toBe(true);
    });

    it('compiles markup in a module-level helper (outside any component, possibly shared)', () =>
    {
        const code = gen('const ornament = () => <span class="x" />;\ncomponent C { <div>{ornament()}</div> }');
        expect(code).not.toMatch(/=>\s*<span/);
        expect(code).toMatch(/h\(|tmpl\(/);
    });

    it('compiles a function-style signature `component Name(props: T)` to a plain function', () =>
    {
        const code = gen('interface P { title: string }\nexport default component Card(props: P) { <h1>{props.title}</h1> }');
        expect(code).toContain('function Card(props = {})');
    });

    it('carries type parameters from a generic component signature', () =>
    {
        const code = gen('interface P<T> { items: T[] }\nexport default component Box<T>(props: P<T>) { <ul>{props.items.length}</ul> }');
        expect(code).toContain('function Box<T>(props = {})');
    });

    it('recognises a no-props function-style signature with empty parens `component Name()`', () =>
    {
        // Empty parens carry no props type - it must still parse as a component (not fall
        // through to opaque passthrough, which would leak the `component Name()` text raw).
        const code = gen('export default component Page() { <main>hi</main> }');
        expect(code).toContain('function Page(props = {})');
        expect(code).not.toMatch(/\bcomponent\s+Page/);
    });

    it('recognises an untyped param signature `component Name(props)`', () =>
    {
        const code = gen('export default component Page(props) { <main>{props.title}</main> }');
        expect(code).toContain('function Page(props = {})');
        expect(code).not.toMatch(/\bcomponent\s+Page/);
    });
});

describe('generateModule - nested-scope keywords (composables)', () =>
{
    it('lowers a `derived` inside a render callback to createMemo with called reads', () =>
    {
        const code = gen('component C { state count = 0; <ul>{items.map(i => { derived active = i.id === count; return <li class={active ? "on" : ""}>x</li>; })}</ul> }');
        // The keyword becomes createMemo, the top-level state read is called, and the nested
        // derived`s own reads gain `()` within the callback scope.
        expect(code).toContain('const active = createMemo(() => (i.id === count()))');
        expect(code).toMatch(/active\(\) \? "on" : ""/);
        expect(code).not.toMatch(/\bderived\s+active/);
    });

    it('lowers `state`/`effect` inside a module-level function (a composable)', () =>
    {
        const code = gen('function useToggle() { state open = false; const toggle = () => open = !open; effect { log(open); } return { open, toggle }; }\ncomponent C { <p>x</p> }');
        expect(code).toContain('const [open, setOpen] = createSignal(false)');
        expect(code).toContain('setOpen(!open())');
        expect(code).toContain('createEffect(() => { log(open()); })');
        expect(code).not.toMatch(/\bstate\s+open|\beffect\s*\{/);
    });

    it('rejects a write to a nested `derived` (read-only), like at the top level', () =>
    {
        expect(() => gen('component C { <ul>{items.map(i => { derived active = i.id; active = 5; return <li>x</li>; })}</ul> }'))
            .toThrow(/read-only/);
    });

    it('leaves a plain local that shadows a nested source name alone', () =>
    {
        // The inner plain `const active` shadows nothing reactive; its read must NOT gain `()`.
        const code = gen('component C { <ul>{items.map(i => { const active = i.id; return <li>{active}</li>; })}</ul> }');
        expect(code).not.toMatch(/active\(\)/);
    });

    it('lowers EVERY transformed keyword in a composable, not just state/derived/effect', () =>
    {
        // The module-scope pre-filter is derived from LOWERABLE_WORDS. When it hand-listed
        // state|derived|effect, a `deferred` or a wrapper block in a composable fell through
        // and was emitted VERBATIM - invalid JavaScript that the projection type-checked
        // happily, so the editor was green and the build shipped broken output.
        for (const [source, expected] of [
            ['deferred slow = heavy;', 'createDeferred(() => (heavy))'],
            ['batch { a(); }', 'batch(() => { a(); })'],
            ['untrack { b(); }', 'untrack(() => { b(); })'],
            ['cleanup { c(); }', 'onCleanup(() => { c(); })'],
            ['dispose { d(); }', 'onRootDispose(() => { d(); })'],
            ['mount { e(); }', 'onMount(() => { e(); })']
        ] as const)
        {
            const code = gen(`function useThing() { ${ source } }\ncomponent C { <p>x</p> }`);
            expect(code).toContain(expected);
            // The surface keyword must not survive as a statement head.
            expect(code).not.toMatch(new RegExp(`^\\s*${ source.split(/[ {]/)[0] as string }\\s`, 'm'));
        }
    });

    it('leaves a module-scope identifier named after a non-transformed keyword verbatim', () =>
    {
        // `form`/`store` and the other factories are component-body sugar the nested lowerer
        // does not transform, so they stay OUT of the pre-filter: a module using `form` as an
        // ordinary name keeps its byte-identical emit (and its fine-grained source map).
        const code = gen('const form = document.querySelector("form");\ncomponent C { <p>x</p> }');
        expect(code).toContain('const form = document.querySelector("form");');
    });
});

describe('generateModule - keyword options (`with { ... }` clause)', () =>
{
    it('passes a `state` equals/name option through to createSignal', () =>
    {
        expect(gen('component C { state pos = origin with { equals: samePos }; <p>{pos.x}</p> }'))
            .toContain('createSignal(origin, { equals: samePos })');
    });

    it('keeps the type argument alongside the options on a typed `state`', () =>
    {
        expect(gen('component C { state n: number = 0 with { name: "n" }; <p>{n}</p> }'))
            .toContain('createSignal<number>(0, { name: "n" })');
    });

    it('passes a `derived` equals option through to createMemo', () =>
    {
        expect(gen('component C { state a = 0; derived d = a * 2 with { equals: cheapEq }; <p>{d}</p> }'))
            .toContain('createMemo(() => (a() * 2), { equals: cheapEq })');
    });

    it('passes an `effect` name option through to createEffect', () =>
    {
        expect(gen('component C { state n = 0; effect with { name: "sync" } { sync(n); } <p>{n}</p> }'))
            .toContain('createEffect(() => { sync(n()); }, { name: "sync" })');
    });

    it('passes an `effect (deps)` defer option through to on()', () =>
    {
        const code = gen('component C { state n = 0; effect (n) with { defer: true } { work(n); } <p>{n}</p> }');
        expect(code).toContain('on([() => (n())], () => { work(n()); }, { defer: true });');
    });

    it('rewrites reactive reads inside the options object', () =>
    {
        // An option value that reads a source is rewritten like any other expression.
        expect(gen('component C { state base = 0; state x = 0 with { equals: (a, b) => a === base }; <p>{x}</p> }'))
            .toContain('equals: (a, b) => a === base()');
    });

    it('supports a `with` clause on a nested (composable) declaration', () =>
    {
        const code = gen('component C { state count = 0; <ul>{items.map(i => { derived active = i.id === count with { equals: byId }; return <li class={active ? "on" : ""}>x</li>; })}</ul> }');
        expect(code).toContain('const active = createMemo(() => (i.id === count()), { equals: byId })');
    });

    it('supports `effect (deps)` on a nested (composable) scope', () =>
    {
        const code = gen('component C { state count = 0; const r = (() => { effect (count) { log(count); } return count; })(); <p>{r}</p> }');
        expect(code).toContain('on([() => (count())], () => { log(count()); });');
    });
});

describe('generateModule - element-rooted unified body', () =>
{
    it('emits a mode-dispatched body: SSR/hydrate h-tree then a dom clone', () =>
    {
        const code = gen('component C { state n = 0; <p>{n}</p> }');
        expect(code).toContain('if (isStringMode() || isHydrating())');
        expect(code).toMatch(/const _r = _tmpl\$1\(\);/);
        expect(code).toContain('return _r;');
    });

    it('drives a reactive only-child text hole with bindContent and a getter thunk', () =>
    {
        const code = gen('component C { state n = 0; <p>{n}</p> }');
        // The hole is its element's only child: no anchor pair, the binding
        // drives the element's content directly.
        expect(code).toMatch(/bindContent\(_n\d+, \(\) => \(n\(\)\)\)/);
        expect(code).not.toContain('<!--[-->');
    });

    it('drives a text hole with siblings through the bindHole anchor pair', () =>
    {
        const code = gen('component C { state n = 0; <p><b>x</b>{n}</p> }');
        expect(code).toMatch(/bindHole\(_n\d+, \(\) => \(n\(\)\)\)/);
        expect(code).toContain('<!--[--><!--]-->');
    });

    it('drives a reactive attribute via createEffect(setProp(...)) in the dom clone path', () =>
    {
        const code = gen('component C { state cls = "a"; <div class={cls}>x</div> }');
        // The dom clone path wires the rewritten value directly inside the effect.
        expect(code).toMatch(/createEffect\(\(\) => setProp\(_n\d+, 'class', cls\(\)\)\)/);
        // The SSR/hydrate h-tree path wraps the same value in a getter thunk.
        expect(code).toContain('class: () => (cls())');
    });

    it('wires an event handler with bindEvent (dom path) and an on* prop (ssr path)', () =>
    {
        const code = gen('component C { <button onClick={save}>x</button> }');
        // bindEvent delegates bubbling types to one document listener and
        // falls back to addEventListener for non-bubbling ones. The h-branch wire
        // format is the canonical handler-form key - the runtime reserves
        // non-handler-form on* spellings and refuses them.
        expect(code).toMatch(/bindEvent\(_n\d+, 'click', save\)/);
        expect(code).toContain('onClick: save');
    });

    it('routes a spread/ref through bindProps', () =>
    {
        const code = gen('component C { state p = 0; <div {...p} ref={el}>x</div> }');
        expect(code).toMatch(/bindProps\(_n\d+, \{ \.\.\.p\(\), ref: el \}\)/);
    });
});

describe('generateModule - control flow and components (slots)', () =>
{
    it('auto-imports a built-in and drives it through bindSlot', () =>
    {
        const code = gen('component C { state on = true; <div><Show when={on}><p>yes</p></Show></div> }');
        expect(code).toContain('Show');
        expect(code).toMatch(/bindSlot\(_n\d+, Show\(\{/);
        // The when prop is a reactive getter.
        expect(code).toContain('get when() { return (on()); }');
    });

    it('emits a user component call with getter props and static props left literal', () =>
    {
        const code = gen('component C { state n = 0; <Foo count={n} label="hi" /> }');
        expect(code).toContain('Foo({');
        expect(code).toContain('get count() { return (n()); }');
        expect(code).toContain('label: \'hi\'');
    });
});

describe('generateModule - constant folding and fragments', () =>
{
    it('folds a literal hole into the hoisted template (no bindHole)', () =>
    {
        const code = gen('component C { <p>{1 + 2}</p> }');
        expect(code).toContain('tmpl(\'<p>3</p>\')');
        expect(code).not.toContain('bindHole');
    });

    it('emits a fragment-rooted output as an h()-built array (no clone)', () =>
    {
        const code = gen('component F { state n = 0; <><p>{n}</p></> }');
        expect(code).toMatch(/return \(\[h\('p'/);
        expect(code).not.toContain('tmpl(');
    });

    it('a children expression starting on the line AFTER the brace survives ASI', () =>
    {
        // Regression: with an unparenthesized `get children() { return\n    (item) => ... }`,
        // automatic semicolon insertion turns that into `return;`, children becomes
        // undefined, and <For> crashes with "renderItem is not a function". The emitted
        // return is parenthesized, so the newline is harmless.
        const code = gen('component L { <For each={[1]} key={(i) => i}>{\n    (item) => <li>{item}</li>\n}</For> }');
        const childrenGetter = /get children\(\) \{ return \(([\s\S]*?)\); \}/.exec(code);
        expect(childrenGetter).not.toBeNull();
        // The load-bearing property: no bare `return` followed by a line break.
        expect(code).not.toMatch(/\breturn\s*\n/);
    });
});

describe('generateModule - source map', () =>
{
    it('emits a v3 source map with the source content embedded', () =>
    {
        const result = generateModule('component C { state n = 0; <p>{n}</p> }', 'C.azeroth');
        expect(result.map).not.toBeNull();
        expect(result.map!.version).toBe(3);
        expect(result.map!.sources).toEqual(['C.azeroth']);
        expect(result.map!.sourcesContent[0]).toContain('component C');
        expect(typeof result.map!.mappings).toBe('string');
        expect(result.map!.mappings.length).toBeGreaterThan(0);
    });
});

describe('generateModule - event-handler validation', () =>
{
    // An `on*` handler value is a function position. An expression that runs at setup
    // (an assignment, ++/--, or a zero-arg call of a plain reference) is not a function,
    // so codegen REJECTS it at compile time rather than emitting an eager setter call.
    // The author must wrap it (`{ () => ... }`). This shares one classifier with
    // diagnoseModule, so the build-time diagnostic and codegen always agree.

    it('rejects an update-expression handler {count++} (it runs at setup, not on the event)', () =>
    {
        expect(() => gen('component C { state count = 0; <button onClick={count++}>x</button> }'))
            .toThrow(/runs at setup, not on the event/);
    });

    it('rejects an assignment handler {n = 1}', () =>
    {
        expect(() => gen('component C { state n = 0; <button onClick={n = 1}>x</button> }'))
            .toThrow(/must be a function/);
    });

    it('rejects a zero-argument call of a plain reference {save()}', () =>
    {
        expect(() => gen('component C { <button onClick={save()}>x</button> }'))
            .toThrow(/must be a function/);
    });

    it('the rejection message names the wrapped fix', () =>
    {
        expect(() => gen('component C { state count = 0; <button onClick={count++}>x</button> }'))
            .toThrow(/Wrap it: onClick=\{\(\) => count\+\+\}/);
    });

    it('accepts the arrow form {() => count++} and emits a real function handler', () =>
    {
        const code = gen('component C { state count = 0; <button onClick={() => count++}>x</button> }');
        expect(code).toMatch(/bindEvent\(_n\d+, 'click', \(\) => setCount\(__p => __p \+ 1\)\)/);
    });

    it('accepts a bare function reference {save}', () =>
    {
        const code = gen('component C { <button onClick={save}>x</button> }');
        expect(() => gen('component C { <button onClick={save}>x</button> }')).not.toThrow();
        expect(code).toMatch(/bindEvent\(_n\d+, 'click', save\)/);
    });

    it('accepts the handler-factory idiom {makeHandler(id)} (a call WITH arguments)', () =>
    {
        const compile = (): string => gen('component C(props: { id: number }) { <button onClick={makeHandler(props.id)}>x</button> }');
        expect(compile).not.toThrow();
        expect(compile()).toContain('makeHandler(');
    });
});

describe('generateModule - regex and apostrophes in holes / markup (scanner regression)', () =>
{
    // Everyday code that desyncs a char-by-char brace scanner - a regex literal in a hole,
    // an apostrophe in markup text (`Don't`) - hard-fails the build with a bogus
    // "Unclosed tag". These must compile.
    it('compiles a regex literal inside a hole', () =>
    {
        const compile = (): string => gen('component C(props: { name: string }) { <p>{ props.name.replace(/\'/g, "") }</p> }');
        expect(compile).not.toThrow();
        expect(compile()).toContain('replace(');
    });

    it('compiles a regex whose body contains braces', () =>
    {
        const compile = (): string => gen('component C(props: { s: string }) { <p>{ props.s.match(/[{}]/) ? "y" : "n" }</p> }');
        expect(compile).not.toThrow();
    });

    it('compiles an apostrophe in nested markup text inside a hole', () =>
    {
        const compile = (): string => gen('component C(props: { ok: boolean }) { <div>{ props.ok ? <span>Don\'t</span> : <span>Do</span> }</div> }');
        expect(compile).not.toThrow();
        expect(compile()).toContain('span');
    });
});

describe('generateModule - carriage returns in emitted literals', () =>
{
    // A CRLF checkout is the DEFAULT on Windows (core.autocrlf=true), so this is what every
    // multi-line `<style>` looked like: the raw CR landed inside a single-quoted literal, which
    // ends it, and the build failed with `[PARSE_ERROR] Unterminated string` pointed at the
    // author's markup.
    const CRLF_STYLE = 'component Card {\r\n    <div>\r\n        <style>\r\n            .a { color: red; }\r\n        </style>\r\n    </div>\r\n}\r\n';

    it('emits parseable JavaScript for a CRLF <style> (raw-text CDATA path)', () =>
    {
        const code = gen(CRLF_STYLE);
        expect(syntaxErrorOf(code)).toBeNull();
        // Escaped, in both the hoisted template and the h() branch.
        expect(code).toContain('\\r\\n            .a { color: red; }');
        expect(code).not.toMatch(/'[^'\n]*\r/);
    });

    it('escapes a CR that reaches a static attribute value through &#13;', () =>
    {
        const code = gen('component C { <div title="a&#13;b">x</div> }');
        expect(syntaxErrorOf(code)).toBeNull();
        expect(code).toContain('title="a\\rb"');
        expect(code).toContain('title: \'a\\rb\'');
    });

    it('escapes a CR that reaches static text through constant folding', () =>
    {
        // The folder evaluates the literal via TypeScript's DECODED node.text, so `\\r` in the source
        // becomes a real CR in the template text.
        const code = gen('component C { <p>{"a\\r\\nb"}</p> }');
        expect(syntaxErrorOf(code)).toBeNull();
        expect(code).toContain('a\\r\\nb');
    });

    it('escapes an authored lone CR in markup text', () =>
    {
        const code = gen('component C { <p>a\rb</p> }');
        expect(syntaxErrorOf(code)).toBeNull();
    });
});

describe('generateModule - static content properties (innerHTML / textContent)', () =>
{
    it('routes a static innerHTML through the SAME property write in both render modes', () =>
    {
        const code = gen('component C { <div innerHTML="<b>bold</b>"></div> }');
        // Baked into the template it is an inert (lowercased) HTML attribute and the element stays
        // EMPTY, while the h() branch writes raw content - one artifact rendering two different DOMs.
        expect(code).toContain('tmpl(\'<div></div>\')');
        expect(code).not.toMatch(/tmpl\('[^']*innerhtml/i);
        expect(code).toContain('setProp(_n0, \'innerHTML\', \'<b>bold</b>\')');
        expect(code).toContain('h(\'div\', { innerHTML: \'<b>bold</b>\' })');
    });

    it('routes a static textContent the same way', () =>
    {
        const code = gen('component C { <div textContent="hi"></div> }');
        expect(code).toContain('tmpl(\'<div></div>\')');
        expect(code).toContain('setProp(_n0, \'textContent\', \'hi\')');
        expect(code).toContain('h(\'div\', { textContent: \'hi\' })');
    });

    it('does not let constant folding put a content property back into the template', () =>
    {
        const code = gen('component C { <div innerHTML={\'<b>x</b>\'}></div> }');
        expect(code).toContain('tmpl(\'<div></div>\')');
        expect(code).toContain('\'innerHTML\', \'<b>x</b>\'');
    });

    it('still bakes value/checked into the template (their server form IS that attribute)', () =>
    {
        const code = gen('component C { <input value="a" checked /> }');
        expect(code).toContain('tmpl(\'<input value="a" checked>\')');
        expect(code).not.toContain('setProp');
    });
});

describe('generateModule - character references in attribute values', () =>
{
    it('escapes an author-written &amp; exactly once, and agrees across render modes', () =>
    {
        const code = gen('component C { <div title="Tom &amp; Jerry">x</div> }');
        expect(code).toContain('title="Tom &amp; Jerry"');
        expect(code).not.toContain('&amp;amp;');
        expect(code).toContain('title: \'Tom & Jerry\'');
    });
});

describe('generateModule - markup nested through expression holes', () =>
{
    /** `<div>{<div>{ ... }</div>}</div>` to `levels` deep - nesting the parser's per-call cap misses. */
    function nested(levels: number): string
    {
        let inner = 'x';
        for (let i = 0; i < levels; i++)
        {
            inner = `<div>{${ inner }}</div>`;
        }
        return `component C { ${ inner } }`;
    }

    it('raises a LOCATED CompileError past the depth cap, not a RangeError', () =>
    {
        // The cap is per parseMarkup call and every hole re-enters it at depth 0, so this nesting used
        // to overflow the shared recursion's stack: an unlocated RangeError instead of the located
        // error the cap exists to guarantee.
        let err: unknown = null;
        try
        {
            gen(nested(700));
        }
        catch (error)
        {
            err = error;
        }
        expect(err).toBeInstanceOf(CompileError);
        expect((err as CompileError).message).toContain('nested deeper than 500 levels');
        expect((err as CompileError).offset).toBeGreaterThan(0);
    });

    it('still compiles nesting under the cap', () =>
    {
        expect(gen(nested(50))).toContain('h(\'div\'');
    });
});

describe('codegen - bind: alongside an explicit handler for the same event', () =>
{
    // A chat composer needs BOTH: `bind:value` for the draft, and `onInput` to announce typing.
    // Emitting two separate registrations for one event silently drops one of them - as a
    // duplicate object key on the string/hydrate path (last wins) and as an overwritten slot in
    // the delegated-event store on the DOM path (also last wins). Either way the BINDING is the
    // one that dies, so the field stops updating and nothing warns.
    it('composes the write-back and the author handler into one listener (DOM path)', () =>
    {
        const code = gen('component C { state draft = ""; <input bind:value={draft} onInput={() => announce()} /> }');
        const registrations = [...code.matchAll(/bindEvent\(_n0, 'input'/g)];
        expect(registrations).toHaveLength(1);
        // Both behaviors survive in the single listener.
        expect(code).toContain('setDraft($event.target.value)');
        expect(code).toContain('announce()');
    });

    it('emits no duplicate object key on the string/hydrate path', () =>
    {
        const code = gen('component C { state draft = ""; <input bind:value={draft} onInput={() => announce()} /> }');
        const stringBranch = code.slice(code.indexOf('isStringMode()'), code.indexOf('const _r ='));
        expect([...stringBranch.matchAll(/onInput:/g)]).toHaveLength(1);
    });

    it('composes bind:checked with an explicit onChange', () =>
    {
        const code = gen('component C { state on = false; <input type="checkbox" bind:checked={on} onChange={() => track()} /> }');
        expect([...code.matchAll(/bindEvent\(_n0, 'change'/g)]).toHaveLength(1);
        expect(code).toContain('setOn($event.target.checked)');
        expect(code).toContain('track()');
    });
});
