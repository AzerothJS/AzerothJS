// @vitest-environment node
//
// Real-execution coverage for generateModule (the unified IR codegen backend).
// Validates the emitted JS STRUCTURE: runtime import wiring, state/derived/effect
// desugaring, the R2 read/write rewrite, the mode-dispatched element-rooted body
// (tmpl clone + isStringMode/isHydrating h-tree), holes (bindHole), slots
// (bindSlot), attributes (setProp), events, spreads/refs (bindProps), constant
// folding, fragment roots, opaque passthrough, and source-map emission.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';

function gen(src: string): string
{
    return generateModule(src).code;
}

describe('generateModule - module shape and imports', () =>
{
    it('emits a factory function and imports the runtime helpers it uses', () =>
    {
        const code = gen('component Hi { <h1>hi</h1> }');
        expect(code).toContain('function Hi(props)');
        expect(code).toContain('from \'azerothjs\'');
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
        const injected = code.split('\n').find(l => l.startsWith('import { ') && l.includes('bindHole'));
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
        expect(code).toContain('function Card(props)');
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
        const code = gen('component C { form rows[] = { a: "" } with { validateArray: (r) => r.length ? null : "x" }; <button onClick={() => rows.append()}>Add</button> }');
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
        const code = gen('component C { form rows[] = { a: "" }; <For each={rows.rows()} key={(r) => r.key}>{(r) => <input bind:value={r.a} />}</For> }');
        expect(code).toContain('r.form.values().a');          // row field read -> row.form.values()
        expect(code).toContain('r.form.setValue("a"');        // bind: write -> row.form.setValue()
        expect(code).toContain('(r) => r.key');               // row.key in the key fn stays literal
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

    it('desugars the block-wrapper keywords (batch/untrack/cleanup/dispose) to their runtime calls', () =>
    {
        expect(gen('component C { state a = 0; state b = 0; effect { batch { a = 1; b = 2; } } <p>{a}</p> }'))
            .toContain('batch(() => { setA(1); setB(2); });');
        expect(gen('component C { state n = 0; effect { cleanup { stop(n); } } <p>{n}</p> }'))
            .toContain('onCleanup(() => { stop(n()); });');
        expect(gen('component C { dispose { teardown(); } <p>x</p> }'))
            .toContain('onRootDispose(() => { teardown(); });');
        expect(gen('component C { state n = 0; effect { untrack { log(n); } } <p>{n}</p> }'))
            .toContain('untrack(() => { log(n()); });');
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
        expect(code).toContain('function Card(props)');
    });

    it('carries type parameters from a generic component signature', () =>
    {
        const code = gen('interface P<T> { items: T[] }\nexport default component Box<T>(props: P<T>) { <ul>{props.items.length}</ul> }');
        expect(code).toContain('function Box<T>(props)');
    });

    it('recognises a no-props function-style signature with empty parens `component Name()`', () =>
    {
        // Empty parens carry no props type - it must still parse as a component (not fall
        // through to opaque passthrough, which would leak the `component Name()` text raw).
        const code = gen('export default component Page() { <main>hi</main> }');
        expect(code).toContain('function Page(props)');
        expect(code).not.toMatch(/\bcomponent\s+Page/);
    });

    it('recognises an untyped param signature `component Name(props)`', () =>
    {
        const code = gen('export default component Page(props) { <main>{props.title}</main> }');
        expect(code).toContain('function Page(props)');
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

    it('drives a reactive text hole with bindHole and a getter thunk', () =>
    {
        const code = gen('component C { state n = 0; <p>{n}</p> }');
        expect(code).toMatch(/bindHole\(_n\d+, \(\) => \(n\(\)\)\)/);
    });

    it('drives a reactive attribute via createEffect(setProp(...)) in the dom clone path', () =>
    {
        const code = gen('component C { state cls = "a"; <div class={cls}>x</div> }');
        // The dom clone path wires the rewritten value directly inside the effect.
        expect(code).toMatch(/createEffect\(\(\) => setProp\(_n\d+, 'class', cls\(\)\)\)/);
        // The SSR/hydrate h-tree path wraps the same value in a getter thunk.
        expect(code).toContain('class: () => (cls())');
    });

    it('wires an event handler with addEventListener (dom path) and an on* prop (ssr path)', () =>
    {
        const code = gen('component C { <button onClick={save}>x</button> }');
        expect(code).toMatch(/_n\d+\.addEventListener\('click', save\)/);
        expect(code).toContain('onclick: save');
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
        // Regression (field report): `get children() { return\n    (item) => ... }` -
        // automatic semicolon insertion silently turned that into `return;`, children
        // became undefined, and <For> crashed with "renderItem is not a function".
        // The emitted return is parenthesized now, so the newline is harmless.
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
        expect(code).toMatch(/addEventListener\('click', \(\) => setCount\(__p => __p \+ 1\)\)/);
    });

    it('accepts a bare function reference {save}', () =>
    {
        const code = gen('component C { <button onClick={save}>x</button> }');
        expect(() => gen('component C { <button onClick={save}>x</button> }')).not.toThrow();
        expect(code).toMatch(/addEventListener\('click', save\)/);
    });

    it('accepts the handler-factory idiom {makeHandler(id)} (a call WITH arguments)', () =>
    {
        const compile = (): string => gen('component C(props: { id: number }) { <button onClick={makeHandler(props.id)}>x</button> }');
        expect(compile).not.toThrow();
        expect(compile()).toContain('makeHandler(');
    });
});
