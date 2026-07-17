// @vitest-environment node
/**
 * U1 type-checking layer - real TypeScript Program backend (Option A).
 *
 * These tests exercise the GENUINE checker: each case is projected to virtual TypeScript, run
 * through a real `ts.Program` / `TypeChecker`, and the resulting diagnostics are mapped back to
 * `.azeroth` spans. There is no heuristic/syntactic type inference under test here - a rejection
 * means the real TypeScript checker found the type error, and an acceptance means it did not.
 */

import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { typeCheckModuleTS } from '../src/typecheck-ts.ts';

// A real path inside the compiler package so a bare `azerothjs` import resolves through the
// workspace node_modules - which is what activates real-type checking of the built-in components.
const REPO_FILE = fileURLToPath(new URL('../src/__typecheck_probe__.azeroth', import.meta.url));

describe('typeCheckModuleTS - handler type checking (real ts.Program)', () =>
{
    it('rejects a number-typed state as an event handler', () =>
    {
        const source = `component Counter {
    state count = 0;
    <button onClick={count}>tick</button>
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/handler-type');
        expect(diagnostics[0]!.severity).toBe('error');
        // The message carries the real TypeScript wording (a `satisfies` failure).
        expect(diagnostics[0]!.message).toContain('satisfy');
    });

    it('locates the error on the offending handler value', () =>
    {
        const source = `component Counter {
    state count = 0;
    <button onClick={count}>tick</button>
}`;
        const { start, end } = typeCheckModuleTS(source)[0]!;
        expect(source.slice(start, end)).toBe('count');
    });

    it('accepts a handler typed with a specific event (MouseEvent), not just Event', () =>
    {
        // The handler check must accept the correct, more-specific event signatures developers write
        // - a precise `(event: Event) => void` target would reject these via contravariance.
        const source = `component C {
    <button onClick={(e: MouseEvent) => e.preventDefault()}>x</button>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts an arrow-function handler that mutates state', () =>
    {
        const source = `component Counter {
    state count = 0;
    <button onClick={() => count++}>tick</button>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts a locally-declared function as a handler', () =>
    {
        const source = `component Counter {
    state count = 0;
    const onTick = () => { count++; };
    <button onClick={onTick}>tick</button>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('rejects a string-typed derived as a handler', () =>
    {
        const source = `component Label {
    state name = "world";
    derived greeting = "hello " + name;
    <button onClick={greeting}>go</button>
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/handler-type');
    });

    it('uses props types: a number prop is rejected, a function prop is accepted', () =>
    {
        const bad = `component Row(props: { onSelect: number }) {
    <button onClick={props.onSelect}>pick</button>
}`;
        expect(typeCheckModuleTS(bad)).toHaveLength(1);

        const good = `component Row(props: { onSelect: (event: Event) => void }) {
    <button onClick={props.onSelect}>pick</button>
}`;
        expect(typeCheckModuleTS(good)).toHaveLength(0);
    });

    it('checks every component in a module independently', () =>
    {
        const source = `component A {
    state n = 1;
    <button onClick={n}>a</button>
}
component B {
    state f = () => {};
    <button onClick={f}>b</button>
}`;
        const diagnostics = typeCheckModuleTS(source);
        // Only A's handler is a non-function; B's is fine.
        expect(diagnostics).toHaveLength(1);
        expect(source.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe('n');
    });

    it('returns nothing for a component with no handlers', () =>
    {
        const source = `component Static {
    state count = 0;
    <p>{count}</p>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('does NOT flag a valid handler over stylistic-only diagnostics (soundness)', () =>
    {
        // `() => (read, count++)` is a valid function; TypeScript emits only a stylistic
        // "left side of comma is unused" (2695) here, which must NOT fail the build.
        const source = `component C {
    state count = 0;
    const read = 1;
    <button onClick={() => (read, count++)}>x</button>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });
});

describe('typeCheckModuleTS - component prop type checking (real ts.Program)', () =>
{
    const CHILD = `component Child(props: { count: number }) {
    <p>{props.count}</p>
}
`;

    it('rejects a wrong-typed prop and locates it', () =>
    {
        const source = CHILD + `component Parent {
    <Child count={"hello"} />
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
        expect(source.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe('count');
    });

    it('accepts a correctly-typed prop fed from state', () =>
    {
        const source = CHILD + `component Parent {
    state n = 0;
    <Child count={n} />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('reports a missing required prop', () =>
    {
        const source = CHILD + `component Parent {
    <Child />
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
    });

    it('treats on* on a COMPONENT as a component-typed prop, not a DOM Event handler', () =>
    {
        const base = `component Child(props: { onPick: (id: number) => void }) {
    <button onClick={() => props.onPick(1)}>x</button>
}
`;
        const good = base + `component Parent {
    const pick = (id: number) => {};
    <Child onPick={pick} />
}`;
        expect(typeCheckModuleTS(good)).toHaveLength(0);

        const bad = base + `component Parent {
    <Child onPick={5} />
}`;
        const diagnostics = typeCheckModuleTS(bad);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
    });
});

describe('typeCheckModuleTS - form keyword (real ts.Program)', () =>
{
    it('accepts a well-typed form (createForm infers the field shape from initial)', () =>
    {
        const source = `import { createForm, required, email, combine } from 'azerothjs';
component SignIn {
    form login = { email: '', password: '' } with {
        validate: { email: combine(required(), email()), password: required() },
        onSubmit: async (values) => { console.log(values.email, values.password); }
    };
    <form onSubmit={login.handleSubmit}>
        <input value={login.values().email} />
        <p>{login.errors().email}</p>
        <button disabled={login.submitting()}>Go</button>
    </form>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts a form with no with-clause', () =>
    {
        const source = `import { createForm } from 'azerothjs';
component C {
    form f = { name: '', age: 0 };
    <p>{f.values().name}{f.values().age}</p>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts field-sugar access and bind:value={form.field} (typed via the FormApi<T> & T projection)', () =>
    {
        const source = `import { createForm } from 'azerothjs';
component C {
    form f = { name: '', count: 0 };
    <form onSubmit={f.handleSubmit}>
        <input bind:value={f.name} />
        <p>{f.name}{f.count}</p>
        <button disabled={f.submitting()}>Go</button>
    </form>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });
});

describe('typeCheckModuleTS - component bind: directive (real ts.Program)', () =>
{
    const FIELD = `component Field(props: { value: string; onInput?: (v: string) => void }) {
    <input value={props.value} onInput={(e) => props.onInput?.((e.target as HTMLInputElement).value)} />
}
`;

    it('accepts bind:value to a component that declares value + a matching onInput', () =>
    {
        const source = FIELD + `component Parent {
    state name = "";
    <Field bind:value={name} />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('rejects bind:value when the bound state type does not match the prop type', () =>
    {
        const source = FIELD + `component Parent {
    state count = 0;
    <Field bind:value={count} />
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    });
});

describe('typeCheckModuleTS - cross-FILE resolution (real ts.Program module resolver)', () =>
{
    const CHILD = `export component Child(props: { count: number }) {
    <p>{props.count}</p>
}`;
    const fs = (): ((path: string) => string | undefined) =>
    {
        const files = new Map([['/proj/child.azeroth', CHILD]]);
        return (path: string): string | undefined => files.get(path);
    };

    it('rejects a wrong-typed prop on a component imported from another .azeroth file', () =>
    {
        const parent = `import { Child } from './child.azeroth';
component Parent {
    <Child count={"oops"} />
}`;
        const diagnostics = typeCheckModuleTS(parent, { fileName: '/proj/parent.azeroth', readFile: fs() });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
        expect(parent.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe('count');
    });

    it('accepts a correctly-typed cross-file prop', () =>
    {
        const parent = `import { Child } from './child.azeroth';
component Parent {
    state n = 0;
    <Child count={n} />
}`;
        expect(typeCheckModuleTS(parent, { fileName: '/proj/parent.azeroth', readFile: fs() })).toHaveLength(0);
    });

    it('resolves an extensionless import to the sibling .azeroth file', () =>
    {
        const parent = `import { Child } from './child';
component Parent {
    <Child count={"x"} />
}`;
        expect(typeCheckModuleTS(parent, { fileName: '/proj/parent.azeroth', readFile: fs() })).toHaveLength(1);
    });

    it('degrades to no error (not a false positive) when an import cannot be resolved', () =>
    {
        const parent = `import { Ghost } from './nope.azeroth';
component Parent {
    <Ghost count={"x"} />
}`;
        expect(typeCheckModuleTS(parent, { fileName: '/proj/parent.azeroth', readFile: fs() })).toHaveLength(0);
    });
});

describe('typeCheckModuleTS - soundness: no false positives on children / control-flow', () =>
{
    it('does not flag control-flow built-ins with children (For)', () =>
    {
        const source = 'component C { state list = [1, 2, 3]; <ul><For each={list}>{(i) => <li>{i}</li>}</For></ul> }';
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('does not flag control-flow built-ins with children (Show)', () =>
    {
        const source = 'component C { state on = true; <Show when={on}><p>hi</p></Show> }';
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('does not flag a user component that takes its children as markup', () =>
    {
        const source = `component Card(props: { title: string }) {
    <div>{props.title}</div>
}
component App {
    <Card title={"x"}>hello</Card>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('does not flag a child-bearing component over a required `children` prop', () =>
    {
        const source = `component Box(props: { children: unknown }) {
    <div>x</div>
}
component App {
    <Box>hi</Box>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('does not flag markup children against a render-function `children` type', () =>
    {
        // The children placeholder must satisfy ANY declared `children` type (a render function, a
        // node, a string) without checking its value - never a false "missing prop".
        const source = `component List(props: { rows: number[]; children: (n: number) => unknown }) {
    <ul>x</ul>
}
component App {
    state rows = [1, 2, 3];
    <List rows={rows}>{(n) => <li>{n}</li>}</List>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('does not flag markup children against a non-function `children` type', () =>
    {
        const source = `component Card(props: { children: string }) {
    <div>x</div>
}
component App {
    <Card>hello</Card>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });
});

describe('typeCheckModuleTS - missing required props (real ts.Program)', () =>
{
    const CARD = `component Card(props: { title: string }) {
    <div>{props.title}</div>
}
`;

    it('reports a missing required prop on a self-closing component, located on the tag', () =>
    {
        const source = CARD + `component App {
    <Card />
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
        expect(source.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe('<Card');
    });

    it('still reports a missing required prop even when children are provided', () =>
    {
        const source = CARD + `component App {
    <Card>hello</Card>
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
    });

    it('reports a missing required `children` when none are given', () =>
    {
        const source = `component Box(props: { children: unknown }) {
    <div>x</div>
}
component App {
    <Box />
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
    });

    it('reports a missing required prop across a .azeroth file boundary', () =>
    {
        const exported = `export ${ CARD }`;
        const files = new Map([['/proj/card.azeroth', exported]]);
        const source = `import { Card } from './card.azeroth';
component App {
    <Card />
}`;
        const diagnostics = typeCheckModuleTS(source, { fileName: '/proj/app.azeroth', readFile: (p) => files.get(p) });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
    });
});

describe('typeCheckModuleTS - false-positive guards (soundness audit)', () =>
{
    it('accepts a spread that supplies the required props', () =>
    {
        const source = `component Child(props: { a: number; b: string }) {
    <p>{props.a}</p>
}
component App {
    state rest = { a: 1, b: "x" };
    <Child {...rest} />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts an omitted optional prop', () =>
    {
        const source = `component Child(props: { a?: number }) {
    <p>x</p>
}
component App {
    <Child />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts a static string attribute against a string prop', () =>
    {
        const source = `component Child(props: { label: string }) {
    <p>{props.label}</p>
}
component App {
    <Child label="hi" />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts a bare boolean attribute against a boolean prop', () =>
    {
        const source = `component Child(props: { disabled?: boolean }) {
    <p>x</p>
}
component App {
    <Child disabled />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts a valid union-member attribute', () =>
    {
        const source = `component Child(props: { size: "sm" | "lg" }) {
    <p>x</p>
}
component App {
    <Child size="sm" />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('still rejects a static string against a number prop', () =>
    {
        const source = `component Child(props: { count: number }) {
    <p>{props.count}</p>
}
component App {
    <Child count="5" />
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
    });

    it('still rejects a wrong union member', () =>
    {
        const source = `component Child(props: { size: "sm" | "lg" }) {
    <p>x</p>
}
component App {
    <Child size="xl" />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(1);
    });

    it('accepts a markup-valued prop (e.g. a fallback element) without a false error', () =>
    {
        const source = `component Child(props: { slot: unknown }) {
    <p>x</p>
}
component App {
    <Child slot={<b>hi</b>} />
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts a handler whose body embeds markup without a false error', () =>
    {
        const source = 'component C { <button onClick={() => render(<span>x</span>)}>go</button> }';
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('keeps a markup-valued prop present while still catching a sibling missing prop', () =>
    {
        const source = `component Child(props: { title: string; slot: unknown }) {
    <p>x</p>
}
component App {
    <Child slot={<b>hi</b>} />
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
    });
});

describe('typeCheckModuleTS - built-in control-flow components (real types via azerothjs)', () =>
{
    it('accepts a well-formed <For> (each + key + render children)', () =>
    {
        const source = `component C {
    state list = [1, 2, 3];
    <ul><For each={list} key={(i: number) => i}>{(i: number) => <li>{i}</li>}</For></ul>
}`;
        expect(typeCheckModuleTS(source, { fileName: REPO_FILE })).toHaveLength(0);
    });

    it('rejects a <For> missing its required `key` (a runtime crash)', () =>
    {
        const source = `component C {
    state list = [1, 2, 3];
    <ul><For each={list}>{(i: number) => <li>{i}</li>}</For></ul>
}`;
        const diagnostics = typeCheckModuleTS(source, { fileName: REPO_FILE });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
    });

    it('rejects a <For> whose `each` is not iterable', () =>
    {
        const source = `component C {
    <ul><For each={5} key={(i: number) => i}>{(i: number) => <li>{i}</li>}</For></ul>
}`;
        const diagnostics = typeCheckModuleTS(source, { fileName: REPO_FILE });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
    });

    it('rejects a <Show> missing its required `when`', () =>
    {
        const source = `component C {
    <Show><p>hi</p></Show>
}`;
        const diagnostics = typeCheckModuleTS(source, { fileName: REPO_FILE });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
    });

    it('accepts a factory prop (`fallback`) given the inner value (codegen wraps it in a thunk)', () =>
    {
        const source = `component C {
    state on = true;
    <Show when={on} fallback={document.createElement("p")}><span>hi</span></Show>
}`;
        expect(typeCheckModuleTS(source, { fileName: REPO_FILE })).toHaveLength(0);
    });

    it('rejects a factory prop (`fallback`) whose inner value is the wrong type', () =>
    {
        const source = `component C {
    state on = true;
    <Show when={on} fallback={42}><span>hi</span></Show>
}`;
        const diagnostics = typeCheckModuleTS(source, { fileName: REPO_FILE });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
    });

    it('does not treat a user component named like a built-in as the built-in', () =>
    {
        const source = `component For(props: { each: number }) {
    <p>{props.each}</p>
}
component C {
    <For each={1} />
}`;
        expect(typeCheckModuleTS(source, { fileName: REPO_FILE })).toHaveLength(0);
    });

    it('degrades to no built-in check when azerothjs cannot be resolved', () =>
    {
        // No file path -> the bare `azerothjs` import does not resolve -> built-ins fall back
        // to `any`, so even an obviously wrong `each` produces no error (sound: never a false error).
        const source = `component C {
    <ul><For each={5} key={(i: number) => i}>{(i: number) => <li>{i}</li>}</For></ul>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });
});

describe('typeCheckModuleTS - cross-region resolution (real ts.Program)', () =>
{
    it('resolves a module-level helper used in a handler', () =>
    {
        const source = `function makeHandler() { return () => {}; }
component C {
    <button onClick={makeHandler()}>x</button>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('rejects a module-level non-function constant used as a handler', () =>
    {
        const source = `const NOT_FN = 5;
component C {
    <button onClick={NOT_FN}>x</button>
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/handler-type');
    });
});

describe('typeCheckModuleTS - function-style signature props (interface + generics)', () =>
{
    it('checks props declared via an interface signature `component Card(props: CardProps)`', () =>
    {
        const base = `interface CardProps { title: string }
component Card(props: CardProps) { <h1>{props.title}</h1> }
`;
        expect(typeCheckModuleTS(base + 'component App { <Card title={"hi"} /> }')).toHaveLength(0);

        const bad = typeCheckModuleTS(base + 'component App { <Card title={5} /> }');
        expect(bad).toHaveLength(1);
        expect(bad[0]!.code).toBe('azeroth/prop-type');
    });

    it('reports a missing required prop with an interface signature', () =>
    {
        const source = `interface CardProps { title: string }
component Card(props: CardProps) { <h1>{props.title}</h1> }
component App { <Card /> }`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-missing');
    });

    it('type-checks a generic component signature', () =>
    {
        const base = `interface BoxProps<T> { value: T; render: (v: T) => string }
component Box<T>(props: BoxProps<T>) { <p>{props.render(props.value)}</p> }
`;
        // render expects (v) => string; passing a number for value is fine, but a non-function render is not.
        const bad = typeCheckModuleTS(base + 'component App { <Box value={1} render={"nope"} /> }');
        expect(bad.length).toBeGreaterThanOrEqual(1);
        expect(bad.some((d) => d.code === 'azeroth/prop-type')).toBe(true);
    });
});

describe('typeCheckModuleTS - factory props keep contextual typing (real ts.Program)', () =>
{
    it('types ErrorBoundary fallback params from the prop signature (no implicit any)', () =>
    {
        const source = `import { ErrorBoundary } from 'azerothjs';
component App {
    <ErrorBoundary fallback={(error, reset) => <button onClick={() => reset()}>retry</button>}>
        <p>content</p>
    </ErrorBoundary>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });

    it('accepts the function form of Show fallback unchanged', () =>
    {
        const source = `import { Show } from 'azerothjs';
component App {
    <Show when={true} fallback={() => <p>no</p>}>
        <b>yes</b>
    </Show>
}`;
        expect(typeCheckModuleTS(source)).toHaveLength(0);
    });
});
