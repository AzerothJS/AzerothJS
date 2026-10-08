// @vitest-environment happy-dom
//
// Every markup expression compiles its nested markup and its keyword statements on both emit paths.
// Each arm runs the default and the client-only emit under render, renderToString and hydrate.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as ts from 'typescript';
import { generateModule } from '../src/codegen.ts';
import { diagnoseModule } from '../src/diagnostics.ts';
import { generateVirtualCode } from '../src/project.ts';
import * as runtime from 'azerothjs/internal';
import { render, hydrate, renderToString, createRoot } from 'azerothjs';

/** What the compiled component reports back; each field is written by the emitted code. */
interface Hook
{
    hits: number;
    noop: number;
    effects: number;
    v?: unknown;
    el?: unknown;
    read?: () => number;
    run?: () => void;
    onRun?: () => void;
    kidInput?: (v: string) => void;
    bump?: () => void;
}

const hook: Hook = { hits: 0, noop: 0, effects: 0 };

type Lanes = Record<string, string>;

interface Arm
{
    src: string;
    fire: (root: HTMLElement) => void;
    probe: (root: HTMLElement) => string;
    /** What renderToString must contain. */
    html: string;
}

const click = (sel: string) => (root: HTMLElement): void =>
{
    (root.querySelector(sel) as HTMLElement).click();
};
const typeInto = (root: HTMLElement): void =>
{
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'typed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
};
const none = (): void => undefined;
const byN = (): string => `n=${ String(hook.read?.()) }`;
const byV = (): string => `v=${ String(hook.v) }`;
const byEl = (): string => `el=${ (hook.el as { textContent?: string } | undefined)?.textContent ?? String(hook.el) }`;
const attrOf = (name: string) => (root: HTMLElement): string => `${ name }=${ root.querySelector('b')?.getAttribute(name) }`;
const colorOf = (root: HTMLElement): string => `color=${ (root.querySelector('b') as HTMLElement).style.color }`;

function reset(): void
{
    Object.assign(hook, {
        hits: 0, noop: 0, effects: 0,
        v: undefined, el: undefined, read: undefined, run: undefined, onRun: undefined, kidInput: undefined, bump: undefined
    });
}

function fail(error: unknown): string
{
    const e = error as { name?: string; message?: string } | null;
    return `threw ${ e?.name ?? String(error) }: ${ (e?.message ?? '').slice(0, 50) }`;
}

function emit(src: string, ssr: boolean): string
{
    return generateModule(src, 'T.azeroth', ssr ? {} : { ssr: false }).code;
}

/** Runs the emitted module, types stripped, with only the names its import line declares. */
function load(emitted: string): () => HTMLElement
{
    const code = ts.transpileModule(emitted, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
    const imported = (/^import \{([^}]*)\} from 'azerothjs\/internal';/m.exec(code)?.[1] ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    const body = code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const values = runtime as unknown as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the compiler's output
    const factory = new Function(...imported, 'hook', `${ body }\nreturn C;`) as (...args: unknown[]) => () => HTMLElement;
    return factory(...imported.map((k) => values[k]), hook);
}

function mountPoint(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

/** The clone path: a DOM render of the default (both-branch) emit or of the client-only emit. */
function cloneLane(arm: Arm, ssr: boolean): string
{
    reset();
    const container = mountPoint();
    try
    {
        let C: () => HTMLElement;
        try
        {
            C = load(emit(arm.src, ssr));
        }
        catch (error)
        {
            return `load ${ fail(error) }`;
        }
        render(() => C(), container);
        arm.fire(container);
        return arm.probe(container);
    }
    catch (error)
    {
        return fail(error);
    }
    finally
    {
        container.remove();
    }
}

/** The h() path, server side: renderToString of the default emit. */
function ssrLane(arm: Arm): string
{
    reset();
    try
    {
        let C: () => HTMLElement;
        try
        {
            C = load(emit(arm.src, true));
        }
        catch (error)
        {
            return `load ${ fail(error) }`;
        }
        const html = renderToString(() => C());
        return html.includes(arm.html) ? 'html ok' : `html missing ${ arm.html }`;
    }
    catch (error)
    {
        return fail(error);
    }
}

/** The h() path, client side: hydrate the server HTML, then fire. */
function hydrateLane(arm: Arm): string
{
    const container = mountPoint();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try
    {
        let C: () => HTMLElement;
        try
        {
            C = load(emit(arm.src, true));
        }
        catch (error)
        {
            return `load ${ fail(error) }`;
        }
        reset();
        container.innerHTML = renderToString(() => C());
        reset();
        hydrate(() => C(), container);
        arm.fire(container);
        return arm.probe(container);
    }
    catch (error)
    {
        return fail(error);
    }
    finally
    {
        warn.mockRestore();
        container.remove();
    }
}

function parses(code: string): string
{
    const file = ts.createSourceFile('out.ts', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const first = (file as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics[0];
    return first === undefined ? 'parses'
        : `syntax error: ${ ts.flattenDiagnosticMessageText(first.messageText, ' ') } near "${ code.slice(first.start ?? 0, (first.start ?? 0) + 12) }"`;
}

/**
 * Syntax per emit path, each parsed on its own: hEmit is the default emit with its clone sections
 * cut away, and cloneEmit is the client-only emit.
 */
function emitLanes(src: string): Lanes
{
    let full: string;
    let clone: string;
    try
    {
        full = emit(src, true);
        clone = emit(src, false);
    }
    catch (error)
    {
        const refused = `compile ${ fail(error) }`;
        return { hEmit: refused, cloneEmit: refused };
    }
    const IF = 'if (isStringMode() || isHydrating())';
    const match = new Map<number, number>();
    const stack: number[] = [];
    const ifs: Array<{ at: number; enclosing: number }> = [];
    for (let i = 0; i < full.length; i++)
    {
        const ch = full[i];
        if (ch === '\'' || ch === '"' || ch === '`')
        {
            for (i++; i < full.length && full[i] !== ch; i++)
            {
                if (full[i] === '\\')
                {
                    i++;
                }
            }
            continue;
        }
        if (full.startsWith(IF, i))
        {
            ifs.push({ at: i, enclosing: stack[stack.length - 1] ?? -1 });
        }
        if (ch === '{')
        {
            stack.push(i);
        }
        else if (ch === '}')
        {
            match.set(stack.pop() ?? -1, i);
        }
    }
    const cuts = ifs.map(({ at, enclosing }) =>
    {
        const thenClose = match.get(full.indexOf('{', at + IF.length)) ?? full.length;
        return [thenClose + 1, match.get(enclosing) ?? full.length] as [number, number];
    });
    // Cuts nested in another cut go with it; the rest are disjoint and removed back to front.
    const outer = cuts.filter((c) => !cuts.some((d) => d !== c && d[0] <= c[0] && c[1] <= d[1])).sort((a, b) => b[0] - a[0]);
    let hOnly = full;
    for (const [s, e] of outer)
    {
        hOnly = hOnly.slice(0, s) + hOnly.slice(e);
    }
    return { hEmit: parses(hOnly), cloneEmit: parses(clone) };
}

function projection(src: string): string
{
    const v = generateVirtualCode(src) as unknown as { code: string } | string;
    return parses(typeof v === 'string' ? v : v.code);
}

function lanes(arm: Arm): Lanes
{
    return {
        ...emitLanes(arm.src),
        render: cloneLane(arm, true),
        client: cloneLane(arm, false),
        ssr: ssrLane(arm),
        hydrate: hydrateLane(arm)
    };
}

function green(want: string): Lanes
{
    return { hEmit: 'parses', cloneEmit: 'parses', render: want, client: want, ssr: 'html ok', hydrate: want };
}

const KID = `component Kid(props: { run?: () => void; onRun?: () => void; value?: string; onInput?: (v: string) => void }) {
    hook.run = props.run;
    hook.onRun = props.onRun;
    hook.kidInput = props.onInput;
    <i>k</i>
}`;

function mod(markup: string, body = ''): string
{
    return `${ KID }
export default component C() {
    state n = 0;
    state m = 0;
    state text = "";
    state ready = true;
    state list = [1];
    state rows = [{ name: "a" }];
    hook.read = () => n;
    ${ body }
    <div>${ markup }</div>
}`;
}

describe('a keyword inside a markup expression is lowered on both emit paths', () =>
{
    // Each snippet adds exactly 1 to `x` through the keyword.
    const KEYWORDS: Record<string, (x: string) => string> = {
        batch: (x) => `batch { ${ x } = ${ x } + 1; }`,
        untrack: (x) => `untrack { ${ x } = ${ x } + 1; }`,
        cleanup: (x) => `cleanup { hook.noop++; } ${ x } = ${ x } + 1;`,
        dispose: (x) => `dispose { hook.noop++; } ${ x } = ${ x } + 1;`,
        mount: (x) => `mount { hook.noop++; } ${ x } = ${ x } + 1;`,
        effect: (x) => `effect { hook.effects++; } ${ x } = ${ x } + 1;`,
        watch: (x) => `effect (m) { hook.effects++; } ${ x } = ${ x } + 1;`,
        state: (x) => `state s = 1; ${ x } = ${ x } + s;`,
        derived: (x) => `derived d = 1; ${ x } = ${ x } + d;`,
        deferred: (x) => `deferred d = 1; ${ x } = ${ x } + d;`
    };
    const hits = (read: (root: HTMLElement) => string) => (root: HTMLElement): string => `${ read(root) } hits=${ hook.hits > 0 ? 'yes' : 'no' }`;
    const POSITIONS: Record<string, { markup: (k: (x: string) => string) => string; fire: (r: HTMLElement) => void; probe: (r: HTMLElement) => string; want: string; html: string }> = {
        inlineHandler: { markup: (k) => `<button onClick={ () => { ${ k('n') } } }>go</button>`, fire: click('button'), probe: byN, want: 'n=1', html: '<button' },
        nestedArrow: { markup: (k) => `<button onClick={ () => { const f = () => { ${ k('n') } }; f(); } }>go</button>`, fire: click('button'), probe: byN, want: 'n=1', html: '<button' },
        forRowHandler: { markup: (k) => `<ul><For each={ list } key={ (x) => x } let={ x }><li onClick={ () => { ${ k('n') } } }>{ x }</li></For></ul>`, fire: click('li'), probe: byN, want: 'n=1', html: '<li' },
        composedBind: { markup: (k) => `<input bind:value={ text } onInput={ () => { ${ k('n') } } } />`, fire: typeInto, probe: (r) => `${ byN() } text=${ (r.querySelector('input') as HTMLInputElement).value }`, want: 'n=1 text=typed', html: '<input' },
        showChildHandler: { markup: (k) => `<Show when={ ready }><button onClick={ () => { ${ k('n') } } }>go</button></Show>`, fire: click('button'), probe: byN, want: 'n=1', html: '<button' },
        embeddedHandler: { markup: (k) => `{ ready && <button onClick={ () => { ${ k('n') } } }>go</button> }`, fire: click('button'), probe: byN, want: 'n=1', html: '<button' },
        componentCallback: { markup: (k) => `<Kid run={ () => { ${ k('n') } } } />`, fire: () => hook.run?.(), probe: byN, want: 'n=1', html: '<i>k</i>' },
        componentEvent: { markup: (k) => `<Kid onRun={ () => { ${ k('n') } } } />`, fire: () => hook.onRun?.(), probe: byN, want: 'n=1', html: '<i>k</i>' },
        componentBindHandler: { markup: (k) => `<Kid bind:value={ text } onInput={ () => { ${ k('n') } } } />`, fire: () => hook.kidInput?.('typed'), probe: byN, want: 'n=1', html: '<i>k</i>' },
        refCallback: { markup: (k) => `<b ref={ (el) => { ${ k('hook.hits') } } }>r</b>`, fire: none, probe: hits(() => 'ref'), want: 'ref hits=yes', html: '<b>r</b>' },
        attrTitle: { markup: (k) => `<b title={ (() => { ${ k('hook.hits') } return 'ok'; })() }>t</b>`, fire: none, probe: hits(attrOf('title')), want: 'title=ok hits=yes', html: 'title="ok"' },
        classToggle: { markup: (k) => `<b class:on={ (() => { ${ k('hook.hits') } return true; })() }>t</b>`, fire: none, probe: hits(attrOf('class')), want: 'class=on hits=yes', html: 'class="on"' },
        classDynamic: { markup: (k) => `<b class={ (() => { ${ k('hook.hits') } return 'ok'; })() } class:x={ false }>t</b>`, fire: none, probe: hits(attrOf('class')), want: 'class=ok hits=yes', html: 'class="ok"' },
        styleEntry: { markup: (k) => `<b style:color={ (() => { ${ k('hook.hits') } return 'red'; })() }>t</b>`, fire: none, probe: hits(colorOf), want: 'color=red hits=yes', html: 'color: red' },
        styleDynamic: { markup: (k) => `<b style={ (() => { ${ k('hook.hits') } return 'color: red'; })() } style:margin={ '0px' }>t</b>`, fire: none, probe: hits(colorOf), want: 'color=red hits=yes', html: 'color: red' }
    };
    // No valid bind: target holds a keyword; a computed one is pinned only as an emit that parses.
    const BIND_TARGETS: Record<string, (k: (x: string) => string) => string> = {
        bindTarget: (k) => `<input bind:value={ rows[(() => { ${ k('hook.hits') } return 0; })()].name } />`,
        componentBindTarget: (k) => `<Kid bind:value={ rows[(() => { ${ k('hook.hits') } return 0; })()].name } />`
    };
    for (const [keyword, k] of Object.entries(KEYWORDS))
    {
        for (const [position, p] of Object.entries(POSITIONS))
        {
            it(`${ position } / ${ keyword }`, () =>
            {
                expect(lanes({ src: mod(p.markup(k)), fire: p.fire, probe: p.probe, html: p.html })).toEqual(green(p.want));
            });
        }
        for (const [position, markup] of Object.entries(BIND_TARGETS))
        {
            it(`${ position } / ${ keyword }`, () =>
            {
                expect(emitLanes(mod(markup(k)))).toEqual({ hEmit: 'parses', cloneEmit: 'parses' });
            });
        }
    }
});

describe('markup inside a markup expression is compiled on both emit paths', () =>
{
    const EL = '(hook.el = <i>x</i>)';
    // The hydrate lane is left out where the markup is built at setup: hydration hands back a
    // descriptor there, as it does for an attribute.
    const SETUP = new Set(['classToggle', 'classDynamic', 'styleEntry', 'styleDynamic', 'ref', 'attrControl']);
    const ARMS: Record<string, { markup: string; fire: (r: HTMLElement) => void; probe: (r: HTMLElement) => string; want: string; html: string }> = {
        inlineHandler: { markup: `<button onClick={ () => { ${ EL }; } }>go</button>`, fire: click('button'), probe: byEl, want: 'el=x', html: '<button' },
        forRowHandler: { markup: `<ul><For each={ list } key={ (x) => x } let={ x }><li onClick={ () => { ${ EL }; } }>{ x }</li></For></ul>`, fire: click('li'), probe: byEl, want: 'el=x', html: '<li' },
        showChildHandler: { markup: `<Show when={ ready }><button onClick={ () => { ${ EL }; } }>go</button></Show>`, fire: click('button'), probe: byEl, want: 'el=x', html: '<button' },
        embeddedHandler: { markup: `{ ready && <button onClick={ () => { ${ EL }; } }>go</button> }`, fire: click('button'), probe: byEl, want: 'el=x', html: '<button' },
        componentEvent: { markup: `<Kid onRun={ () => { ${ EL }; } } />`, fire: () => hook.onRun?.(), probe: byEl, want: 'el=x', html: '<i>k</i>' },
        componentBindHandler: { markup: `<Kid bind:value={ text } onInput={ () => { ${ EL }; } } />`, fire: () => hook.kidInput?.('typed'), probe: byEl, want: 'el=x', html: '<i>k</i>' },
        composedBind: { markup: `<input bind:value={ text } onInput={ () => { ${ EL }; } } />`, fire: typeInto, probe: byEl, want: 'el=x', html: '<input' },
        classToggle: { markup: `<b class:on={ ${ EL } !== null }>t</b>`, fire: none, probe: (r) => `${ attrOf('class')(r) } ${ byEl() }`, want: 'class=on el=x', html: 'class="on"' },
        classDynamic: { markup: `<b class={ ${ EL } !== null ? "ok" : "" } class:x={ false }>t</b>`, fire: none, probe: (r) => `${ attrOf('class')(r) } ${ byEl() }`, want: 'class=ok el=x', html: 'class="ok"' },
        styleEntry: { markup: `<b style:color={ ${ EL } !== null ? "red" : "" }>t</b>`, fire: none, probe: (r) => `${ colorOf(r) } ${ byEl() }`, want: 'color=red el=x', html: 'color: red' },
        styleDynamic: { markup: `<b style={ ${ EL } !== null ? "color: red" : "" } style:margin={ "0px" }>t</b>`, fire: none, probe: (r) => `${ colorOf(r) } ${ byEl() }`, want: 'color=red el=x', html: 'color: red' },
        ref: { markup: `<b ref={ (e) => { ${ EL }; } }>r</b>`, fire: none, probe: byEl, want: 'el=x', html: '<b>r</b>' },
        attrControl: { markup: `<b title={ ${ EL } !== null ? "ok" : "" }>t</b>`, fire: none, probe: (r) => `${ attrOf('title')(r) } ${ byEl() }`, want: 'title=ok el=x', html: 'title="ok"' },
        propControl: { markup: `<Kid run={ () => { ${ EL }; } } />`, fire: () => hook.run?.(), probe: byEl, want: 'el=x', html: '<i>k</i>' }
    };
    for (const [name, a] of Object.entries(ARMS))
    {
        it(name, () =>
        {
            const got = lanes({ src: mod(a.markup), fire: a.fire, probe: a.probe, html: a.html });
            const want = green(a.want);
            if (SETUP.has(name))
            {
                delete got.hydrate;
                delete want.hydrate;
            }
            expect(got).toEqual(want);
        });
    }
});

// A `{` opens statements only in statement position. Each shape is keyword-free and evaluates
// to "ok" through a member named `effect`.
const SHAPES: Record<string, string> = {
    objectLiteral: '({ effect(v) { return v; } }).effect("ok")',
    nestedObjectProperty: '({ a: { effect(v) { return v; } } }).a.effect("ok")',
    ternaryAlternateInBlock: '(() => { const o = hook.hits > 99 ? null : { effect(v) { return v; } }; return o.effect("ok"); })()',
    classBody: 'new (class { m() { return 0; } effect(v) { return v; } })().effect("ok")',
    returnedObject: '(() => { return { effect(v) { return v; } }; })().effect("ok")'
};

describe('a member named like a keyword in an object literal or a class body is left as written', () =>
{
    const WRITERS: Record<string, { markup: (e: string) => string; body?: (e: string) => string; fire: (r: HTMLElement) => void; probe: (r: HTMLElement) => string; want: string; html: string }> = {
        body: { markup: () => '<i>b</i>', body: (e) => `hook.v = ${ e };`, fire: none, probe: byV, want: 'v=ok', html: '<i>b</i>' },
        attribute: { markup: (e) => `<b title={ ${ e } }>t</b>`, fire: none, probe: attrOf('title'), want: 'title=ok', html: 'title="ok"' },
        hole: { markup: (e) => `<b>{ ${ e } }</b>`, fire: none, probe: (r) => `text=${ r.querySelector('b')?.textContent }`, want: 'text=ok', html: 'ok' },
        componentProp: { markup: (e) => `<Kid run={ () => { hook.v = ${ e }; } } />`, fire: () => hook.run?.(), probe: byV, want: 'v=ok', html: '<i>k</i>' },
        showChildHandler: { markup: (e) => `<Show when={ ready }><button onClick={ () => { hook.v = ${ e }; } }>go</button></Show>`, fire: click('button'), probe: byV, want: 'v=ok', html: '<button' },
        inlineHandler: { markup: (e) => `<button onClick={ () => { hook.v = ${ e }; } }>go</button>`, fire: click('button'), probe: byV, want: 'v=ok', html: '<button' },
        forRowHandler: { markup: (e) => `<ul><For each={ list } key={ (x) => x } let={ x }><li onClick={ () => { hook.v = ${ e }; } }>{ x }</li></For></ul>`, fire: click('li'), probe: byV, want: 'v=ok', html: '<li' },
        embeddedHandler: { markup: (e) => `{ ready && <button onClick={ () => { hook.v = ${ e }; } }>go</button> }`, fire: click('button'), probe: byV, want: 'v=ok', html: '<button' },
        componentEvent: { markup: (e) => `<Kid onRun={ () => { hook.v = ${ e }; } } />`, fire: () => hook.onRun?.(), probe: byV, want: 'v=ok', html: '<i>k</i>' },
        componentBindHandler: { markup: (e) => `<Kid bind:value={ text } onInput={ () => { hook.v = ${ e }; } } />`, fire: () => hook.kidInput?.('typed'), probe: byV, want: 'v=ok', html: '<i>k</i>' },
        composedBind: { markup: (e) => `<input bind:value={ text } onInput={ () => { hook.v = ${ e }; } } />`, fire: typeInto, probe: byV, want: 'v=ok', html: '<input' },
        classToggle: { markup: (e) => `<b class:ok={ ${ e } === "ok" }>t</b>`, fire: none, probe: attrOf('class'), want: 'class=ok', html: 'class="ok"' },
        classDynamic: { markup: (e) => `<b class={ ${ e } } class:x={ false }>t</b>`, fire: none, probe: attrOf('class'), want: 'class=ok', html: 'class="ok"' },
        styleEntry: { markup: (e) => `<b style:color={ ${ e } === "ok" ? "red" : "blue" }>t</b>`, fire: none, probe: colorOf, want: 'color=red', html: 'color: red' },
        styleDynamic: { markup: (e) => `<b style={ ${ e } === "ok" ? "color: red" : "" } style:margin={ "0px" }>t</b>`, fire: none, probe: colorOf, want: 'color=red', html: 'color: red' },
        ref: { markup: (e) => `<b ref={ (el) => { hook.v = ${ e }; } }>r</b>`, fire: none, probe: byV, want: 'v=ok', html: '<b>r</b>' },
        spread: { markup: (e) => `<b {...{ title: ${ e } }}>t</b>`, fire: none, probe: attrOf('title'), want: 'title=ok', html: 'title="ok"' }
    };
    for (const [shape, e] of Object.entries(SHAPES))
    {
        for (const [writer, w] of Object.entries(WRITERS))
        {
            it(`${ shape } / ${ writer }`, () =>
            {
                const src = mod(w.markup(e), w.body?.(e) ?? '');
                expect({ ...lanes({ src, fire: w.fire, probe: w.probe, html: w.html }), projection: projection(src) })
                    .toEqual({ ...green(w.want), projection: 'parses' });
            });
        }
    }
});

describe('a keyword statement in any block stays lowered, and an object member beside it stays as written', () =>
{
    const STATEMENTS: Record<string, string> = {
        caseClauseBlock: 'switch (n) { case 0: { batch { n = n + 1; } } }',
        caseAfterConditional: 'switch (n) { case ready ? 0 : 1: { batch { n = n + 1; } } }',
        labeledBlock: 'outer: { batch { n = n + 1; } }',
        labelAfterNullish: 'const w = hook.none ?? 1; outer: { batch { n = n + w; } }',
        labelAfterOptionalChain: 'const w = hook.none?.p ? 0 : 1; outer: { batch { n = n + w; } }',
        caseAfterNullish: 'switch (n) { case hook.none ?? 0: { batch { n = n + 1; } } }',
        caseAfterOptionalChain: 'switch (n) { case hook.none?.p ? 1 : 0: { batch { n = n + 1; } } }',
        catchWithoutBinding: 'try { throw 0; } catch { batch { n = n + 1; } }',
        elseDoFinally: 'if (n > 9) { } else { batch { n = n + 1; } } do { untrack { n = n + 0; } } while (false); try { } finally { batch { n = n + 0; } }',
        getterBody: 'const o = { get x() { batch { n = n + 1; } return 0; } }; void o.x;',
        asyncMethodBody: 'const o = { async x() { batch { n = n + 1; } } }; void o.x();',
        generatorMethodBody: 'const o = { *x() { batch { n = n + 1; } yield 0; } }; o.x().next();',
        classMethodBody: 'new (class { m() { batch { n = n + 1; } } })().m();',
        staticBlock: 'class K { static { batch { n = n + 1; } } } void K;',
        arrowPropertyBody: 'const o = { f: () => { batch { n = n + 1; } } }; o.f();',
        afterObjectWithoutSemicolon: 'const o = { a: 1 }\n batch { n = n + o.a; }',
        afterClassPropertyKey: 'const o = { class: 1, f: () => { batch { n = n + o.class; } } }; o.f();',
        blockAfterDotClass: 'const c = hook.class\n { batch { n = n + 1; } } void c;',
        heritageCall: 'const mix = (B) => B; class K extends mix(Object) { m() { batch { n = n + 1; } } } new K().m();',
        spreadObject: 'const o = { ...{ effect(v) { return v; } } }; n = n + o.effect(1);',
        thrownObject: 'try { throw { effect(v) { return v; } }; } catch (e) { n = n + e.effect(1); }',
        yieldedObject: 'function* g() { yield { effect(v) { return v; } }; } n = n + g().next().value.effect(1);',
        typeofObject: 'const t = typeof { effect(v) { return v; } }; n = n + (t === "object" ? 1 : 0);',
        conditionalConsequent: 'const o = ready ? { effect(v) { return v; } } : null; n = n + o.effect(1);',
        alternateAfterOptionalChain: '{ const o = hook.none?.p ? null : { effect(v) { return v; } }; n = n + o.effect(1); }',
        classFieldThenMethod: 'class K { a = 1; effect(v) { return v; } } n = n + new K().effect(1);',
        classGetterThenMethod: 'class K { get g() { return 0; } effect(v) { return v; } } n = n + new K().effect(1);',
        namedClassExpression: 'const K = class Named { m() {} effect(v) { return v; } }; n = n + new K().effect(1);',
        // A `)` or `]` that the text before it never opened closes no block: the handler's body
        // stays open, and the label after it opens a block.
        closerInRegexAfterTypedLet: 'let seen: boolean\n /[)]/.test(")") && hook.noop++;\n outer: { batch { n = n + 1; } }',
        secondSlashAfterTypedLet: 'let seen: boolean\n /^throw/.test(String(n / 2)) && hook.noop++;\n outer: { batch { n = n + 1; } }',
        objectDividedByAGroup: 'const halves = [{ a: 1 } / (2 /* half */), 3];\n outer: { batch { n = n + halves.length - 1; } }',
        closerInRegexAfterSemicolon: 'let seen: boolean;\n /[)]/.test(")") && hook.noop++;\n outer: { batch { n = n + 1; } }'
    };
    for (const [name, stmt] of Object.entries(STATEMENTS))
    {
        it(name, () =>
        {
            const src = mod(`<button onClick={ () => { ${ stmt } } }>go</button>`);
            expect({ ...lanes({ src, fire: click('button'), probe: byN, html: '<button' }), projection: projection(src) })
                .toEqual({ ...green('n=1'), projection: 'parses' });
        });
    }

    it('an object method named like a keyword at module scope', () =>
    {
        const src = `const API = { effect(v) { return v; } };\n${ mod('<i>m</i>', 'hook.v = API.effect("ok");') }`;
        expect(lanes({ src, fire: none, probe: byV, html: '<i>m</i>' })).toEqual(green('v=ok'));
    });
});

describe('a malformed declaration in a markup expression is refused as in the component body', () =>
{
    const ARMS: Record<string, { markup: string; code: string }> = {
        inlineHandler: { markup: '<button onClick={ () => { state open[] = true; if (open) { n = n + 1; } } }>go</button>', code: 'azeroth/array-suffix' },
        classToggle: { markup: '<b class:on={ (() => { state open[] = true; return open === true; })() }>t</b>', code: 'azeroth/array-suffix' },
        embeddedHandler: { markup: '{ ready && <b onClick={ () => { state open[] = true; } }>t</b> }', code: 'azeroth/array-suffix' },
        malformedInlineHandler: { markup: '<button onClick={ () => { derived d = = 1; } }>go</button>', code: 'azeroth/malformed-declaration' }
    };
    for (const [name, a] of Object.entries(ARMS))
    {
        it(name, () =>
        {
            const src = mod(a.markup);
            expect(diagnoseModule(src).filter((d) => d.severity === 'error').map((d) => d.code)).toEqual([a.code]);
            expect(() => emit(src, true)).toThrow(a.code);
            expect(() => emit(src, false)).toThrow(a.code);
        });
    }

    it('markup in a body statement', () =>
    {
        const src = mod('{ view }', 'const view = <b onClick={ () => { state open[] = true; } }>t</b>;');
        expect(diagnoseModule(src).filter((d) => d.severity === 'error').map((d) => d.code)).toEqual(['azeroth/array-suffix']);
    });

    it('a well-formed nested declaration compiles', () =>
    {
        const src = mod('<button onClick={ () => { state open = true; if (open) { n = n + 1; } } }>go</button>');
        expect(lanes({ src, fire: click('button'), probe: byN, html: '<button' })).toEqual(green('n=1'));
    });
});

describe('a lifecycle keyword in a handler behaves as in a handler declared in the body', () =>
{
    const HANDLER: Record<string, string> = {
        effect: 'effect { hook.hits = hook.hits + 1; void m; }',
        cleanup: 'cleanup { hook.hits = hook.hits + 100; }',
        dispose: 'dispose { hook.hits = hook.hits + 100; }',
        mount: 'mount { hook.hits = hook.hits + 1000; }'
    };
    // A handler runs outside the component's scope: an effect there is ownerless (it warns and
    // outlives the component), cleanup and dispose never run, and mount runs once per handler call.
    const WANT: Record<string, string> = {
        effect: 'click=1 bump=2 dispose=2 bumpAfterDispose=3 warned=yes',
        cleanup: 'click=0 bump=0 dispose=0 bumpAfterDispose=0 warned=no',
        dispose: 'click=0 bump=0 dispose=0 bumpAfterDispose=0 warned=no',
        mount: 'click=1000 bump=1000 dispose=1000 bumpAfterDispose=1000 warned=no'
    };
    const src = (kw: string, inline: boolean): string => inline
        ? `export default component C() {\n    state m = 0; hook.bump = () => { m = m + 1; };\n    <div><button onClick={ () => { ${ HANDLER[kw] } } }>go</button></div>\n}`
        : `export default component C() {\n    state m = 0; hook.bump = () => { m = m + 1; };\n    function go() { ${ HANDLER[kw] } }\n    <div><button onClick={ go }>go</button></div>\n}`;

    async function counters(code: string): Promise<string>
    {
        reset();
        const warns: string[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) =>
        {
            warns.push(String(a[0]));
        });
        const container = mountPoint();
        try
        {
            const C = load(code);
            let dispose!: () => void;
            createRoot((d) =>
            {
                dispose = d;
                container.appendChild(C());
            });
            (container.querySelector('button') as HTMLElement).click();
            await Promise.resolve();
            const afterClick = hook.hits;
            hook.bump?.();
            const afterBump = hook.hits;
            dispose();
            const afterDispose = hook.hits;
            hook.bump?.();
            return `click=${ afterClick } bump=${ afterBump } dispose=${ afterDispose } bumpAfterDispose=${ hook.hits } warned=${ warns.some((w) => w.includes('no owner')) ? 'yes' : 'no' }`;
        }
        finally
        {
            warn.mockRestore();
            container.remove();
        }
    }

    for (const kw of Object.keys(HANDLER))
    {
        for (const ssr of [true, false])
        {
            it(`${ kw } / ${ ssr ? 'default' : 'client-only' } emit`, async () =>
            {
                expect(await counters(emit(src(kw, true), ssr))).toBe(WANT[kw]);
                expect(await counters(emit(src(kw, false), ssr))).toBe(WANT[kw]);
            });
        }
    }
});

// A `{` that TypeScript reads as a block or a body stays one: after a return type, the end of an
// expression, or `return` or `yield` and a line break. Its keyword is lowered in every lane.
describe('a `{` that opens a block or a body keeps its keyword lowered', () =>
{
    const RUN = 'const run = () => { try { CALL } catch (e) { hook.v = String(e); } };';
    const BATCH = { kr: 'batch { n = n + 1; }', allman: 'batch\n    {\n        n = n + 1;\n    }' };
    const RAW = /\b(?:batch|untrack)\s*\{|\beffect\s*\(\s*x\s*\)\s*\{|\bstate\s+s\b/;

    function check(def: string, call: string, want = 'n=1', moduleScope = false): void
    {
        const run = RUN.replace('CALL', call);
        const src = moduleScope
            ? `${ def }\n${ mod('<button onClick={ run }>go</button>', run) }`
            : mod('<button onClick={ run }>go</button>', `${ def }\n    ${ run }`);
        const v = generateVirtualCode(src) as unknown as { code: string } | string;
        const projected = typeof v === 'string' ? v : v.code;
        expect({ ...lanes({ src, fire: click('button'), probe: byN, html: '<button' }), projection: parses(projected), raw: RAW.test(projected) })
            .toEqual({ ...green(want), projection: 'parses', raw: false });
        expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
    }

    const body = (allman: boolean, stmts: string): string => (allman ? `\n    {\n        ${ stmts }\n    }` : ` { ${ stmts } }`);

    // Each return-type form, and a function type ending in `void`, on a function declaration.
    const TYPES: Record<string, [string, string]> = {
        void: ['void', ''],
        never: ['never', 'throw new Error("never");'],
        unknown: ['unknown', 'return x;'],
        undefined: ['undefined', 'return undefined;'],
        null: ['null', 'return null;'],
        this: ['this', 'return this;'],
        primitive: ['number', 'return 1;'],
        generic: ['Array<number>', 'return [1];'],
        array: ['number[]', 'return [1];'],
        tuple: ['[number, string]', 'return [1, "a"];'],
        typeLiteral: ['{ ok: boolean }', 'return { ok: true };'],
        union: ['number | undefined', 'return 1;'],
        typeof: ['typeof hook', 'return hook;'],
        keyof: ['keyof typeof hook', 'return "hits";'],
        predicate: ['x is number', 'return typeof x === "number";'],
        asserts: ['asserts x is number', 'if (typeof x !== "number") throw new TypeError("x");'],
        conditional: ['typeof x extends number ? "n" : "o"', 'return "o";'],
        templateLiteral: ['`n${ number }`', 'return `n${ 1 }`;'],
        functionType: ['() => void', 'return () => undefined;']
    };
    for (const [name, [type, ret]] of Object.entries(TYPES))
    {
        for (const allman of [false, true])
        {
            it(`returns ${ name } / ${ allman ? 'Allman' : 'K&R' }`, () =>
            {
                check(`function go(x: unknown): ${ type }${ body(allman, `${ allman ? BATCH.allman : BATCH.kr }\n        ${ ret }`) }`, 'go(1);');
            });
        }
    }

    // A return type on every function form: `void`, or the type a getter or a generator takes.
    const FORMS: Record<string, [(b: string) => string, string]> = {
        functionExpression: [(b) => `const go = function (): void${ b };`, 'go();'],
        arrow: [(b) => `const go = (): void =>${ b };`, 'go();'],
        objectMethod: [(b) => `const api = { go(): void${ b } };`, 'api.go();'],
        objectFunction: [(b) => `const api = { go: function (): void${ b } };`, 'api.go();'],
        classMethod: [(b) => `class K { go(): void${ b } }`, 'new K().go();'],
        staticMethod: [(b) => `class K { static go(): void${ b } }`, 'K.go();'],
        getter: [(b) => `class K { get go(): number${ b } }`, 'void new K().go;'],
        generator: [(b) => `function* go(): Iterable<number>${ b }`, 'go().next();'],
        generatorMethod: [(b) => `const api = { *go(): Iterable<number>${ b } };`, 'api.go().next();']
    };
    for (const [name, [def, call]] of Object.entries(FORMS))
    {
        for (const allman of [false, true])
        {
            it(`${ name } / ${ allman ? 'Allman' : 'K&R' }`, () =>
            {
                const stmts = allman ? BATCH.allman : BATCH.kr;
                check(def(body(allman, name === 'getter' ? `${ stmts }\n        return n;` : stmts)), call);
            });
        }
    }

    it('each keyword in a void function, Allman', () =>
    {
        for (const stmt of ['untrack\n    {\n        n = n + 1;\n    }', 'effect (x)\n    {\n        n = n + 1;\n    }', 'state s = 1;\n        n = n + s;'])
        {
            check(`function go(x: unknown): void${ body(true, stmt) }`, 'go(1);');
        }
    });

    it('a void function at module scope', () =>
    {
        check('function go(): void\n{\n    batch\n    {\n        hook.hits = hook.hits + 1;\n    }\n}', 'go(); n = hook.hits;', 'n=1', true);
    });

    // The projection rescans a keyword's body, so a keyword at its start starts a statement.
    it('a keyword at the start of another keyword\'s body', () =>
    {
        check('function go(x: unknown): void { batch { untrack { n = n + 1; } } }', 'go(1);');
        check('function go(x: unknown): void\n    {\n        effect (x)\n        {\n            batch\n            {\n                n = n + 1;\n            }\n        }\n    }', 'go(1);');
    });

    it('a module that opens with a keyword', () =>
    {
        check('untrack\n{\n    mark();\n}\nvar marked: number | undefined;\nfunction mark(): void\n{\n    marked = (marked ?? 0) + 1;\n}', 'n = n + (marked ?? 0);', 'n=1', true);
    });

    // After each object-lead token, valid TypeScript that puts a block or a body right after it.
    const block = (lead: string): string => `${ lead }\n        {\n            ${ BATCH.kr }\n        }`;
    const inGo = (text: string, star = ''): string => `function${ star } go(x: unknown)\n    {\n        ${ text }\n    }`;
    const TOKEN_ARMS: Record<string, [string, string, string?]> = {
        '!': [inGo(block('const el = hook.el!')), 'go(1);'],
        '+': [inGo(block('hook.hits++')), 'go(1);'],
        '-': [inGo(block('hook.hits--')), 'go(1);'],
        '/': [inGo(block('const re = /x/g')), 'go(1);'],
        'return': [inGo(block('return')), 'go(1);', 'n=0'],
        'yield': [inGo(block('yield'), '*'), 'const it = go(1); it.next(); it.next();'],
        'of': [inGo(block('const of = x;\n        hook.v = of')), 'go(1);'],
        '.default': [inGo(block('hook.v = mod.default')), 'go(1);'],
        '#default': [`class P\n    {\n        #default = 1;\n        run(): void\n        {\n            const v = this.#default\n            {\n                ${ BATCH.kr }\n            }\n        }\n    }`, 'new P().run();'],
        'typeof x.default': [`function go(): typeof mod.default\n    {\n        ${ BATCH.kr }\n        return mod.default;\n    }`, 'go();'],
        'extends x.default': [`class Sub extends mod.default\n    {\n        go() { ${ BATCH.kr } }\n    }\n    function after() { ${ BATCH.kr } }`, 'new Sub().go(); after();', 'n=2'],
        '.with': [inGo(block('hook.v = mod.with')), 'go(1);'],
        '#with': [`class P\n    {\n        #with = 1;\n        run(): void\n        {\n            const v = this.#with\n            {\n                ${ BATCH.kr }\n            }\n        }\n    }`, 'new P().run();'],
        'typeof x.with': [`function go(): typeof mod.with\n    {\n        ${ BATCH.kr }\n        return mod.with;\n    }`, 'go();'],
        'extends x.with': [`class Sub extends mod.with\n    {\n        go() { ${ BATCH.kr } }\n    }\n    function after() { ${ BATCH.kr } }`, 'new Sub().go(); after();', 'n=2']
    };
    for (const [token, [def, call, want]] of Object.entries(TOKEN_ARMS))
    {
        it(`after ${ token }`, () =>
        {
            check(`const mod = { default: class {}, with: class {} };\n    ${ def }`, call, want);
        });
    }

    // Every token in the lead lists has an arm above or the reason no block can follow it.
    const NO_BLOCK: Record<string, string> = {
        '(': 'an expression, a parameter or a parenthesized type follows',
        '[': 'an element, a pattern, a computed key or a tuple member follows',
        ',': 'the next element, argument, parameter, property or type follows',
        '=': 'an expression or a type follows; an arrow body follows `=>`',
        '?': 'an expression or a type follows; `?.` never precedes `{`',
        '&': 'an operand or an intersection member follows',
        '|': 'an operand or a union member follows',
        '~': 'prefix only',
        '*': 'an operand, a generator name or `[` follows',
        '%': 'binary only',
        '^': 'binary only',
        '<': 'an operand, a type argument or a type parameter follows',
        '.': 'a member name follows; `1.` is a numeric literal',
        'typeof': 'an operand follows; a member named `typeof` is a member',
        'await': 'not a restricted production: `await`, a line break and `{` awaits an object',
        'new': 'a constructor expression follows',
        'delete': 'an operand follows',
        'in': 'an operand or a type follows',
        'instanceof': 'an operand follows',
        'throw': 'a line break after `throw` is a syntax error',
        'default': '`export default {` exports an object; `default:` is a colon; a member named `default` is armed',
        'extends': 'a heritage expression, a constraint or a checked type follows',
        'with': 'reserved: the `with` statement takes `(`, so `with {` opens an options object'
    };
    it('every object-lead token has an arm or the reason none exists', () =>
    {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lower-reactive.ts'), 'utf8');
        const list = (name: string): string[] =>
            [...(new RegExp(`const ${ name }[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]`).exec(source)?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
        const leads = [...list('OBJECT_AFTER_CHAR'), ...list('OBJECT_AFTER_WORD')];
        expect(leads.length).toBeGreaterThan(20);
        expect(leads.filter((t) => TOKEN_ARMS[t] === undefined && NO_BLOCK[t] === undefined)).toEqual([]);
    });
});

// An expression region starts in expression position: a `{` opening a markup expression, a value
// or a `with` option is an object, and a member there named like a keyword is left as written.
describe('an object literal that opens an expression keeps its members', () =>
{
    const OBJ = '{ effect(v: string) { return v; } }';
    const ARMS: Record<string, { markup: string; body?: string; fire?: (r: HTMLElement) => void; probe: (r: HTMLElement) => string; want: string; html: string }> = {
        hole: { markup: `<b>{ ${ OBJ }.effect("ok") }</b>`, probe: (r) => `text=${ r.querySelector('b')?.textContent }`, want: 'text=ok', html: '>ok<' },
        attribute: { markup: `<b title={ ${ OBJ }.effect("ok") }>t</b>`, probe: attrOf('title'), want: 'title=ok', html: 'title="ok"' },
        classToggle: { markup: '<b class:on={ { effect() { return true; } }.effect() }>t</b>', probe: attrOf('class'), want: 'class=on', html: 'class="on"' },
        componentProp: { markup: '<Kid run={ { effect() { hook.v = "ok"; } }.effect } />', fire: () => hook.run?.(), probe: byV, want: 'v=ok', html: '<i>k</i>' },
        stateValue: { markup: '<b>{ api.effect("ok") }</b>', body: `state api = ${ OBJ };`, probe: (r) => `text=${ r.querySelector('b')?.textContent }`, want: 'text=ok', html: '>ok<' },
        derivedValue: { markup: '<b>{ label }</b>', body: `derived label = ${ OBJ }.effect(text + "ok");`, probe: (r) => `text=${ r.querySelector('b')?.textContent }`, want: 'text=ok', html: '>ok<' },
        classConstraint: { markup: '<i>c</i>', body: 'class Box<T extends { a: string }> { effect(v: T) { return v; } }\n    hook.v = new Box<{ a: string }>().effect({ a: "ok" }).a;', probe: byV, want: 'v=ok', html: '<i>c</i>' },
        // An object divided by a group: the `]` that ends the list closes nothing below it.
        dividedObjectInAList: { markup: '<b>{ [{ a: 1 } / (n / 2), "ok"][1] }</b>', probe: (r) => `text=${ r.querySelector('b')?.textContent }`, want: 'text=ok', html: '>ok<' },
        // A value named like a declaration keyword, followed by an operator word, is a value.
        operatorWordHole: { markup: '<b>{ store instanceof Map ? "m" : "o" }</b>', body: 'const store: unknown = "x";', probe: (r) => `text=${ r.querySelector('b')?.textContent }`, want: 'text=o', html: '>o<' },
        operatorWordStatement: { markup: '<button onClick={ () => { selector in cache || (n = n + 1); } }>go</button>', body: 'const selector = "a";\n    const cache: Record<string, number> = {};', fire: click('button'), probe: byN, want: 'n=1', html: '<button' }
    };
    for (const [name, a] of Object.entries(ARMS))
    {
        it(name, () =>
        {
            const src = mod(a.markup, a.body ?? '');
            expect({ ...lanes({ src, fire: a.fire ?? none, probe: a.probe, html: a.html }), projection: projection(src) })
                .toEqual({ ...green(a.want), projection: 'parses' });
            expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        });
    }

    it('a form option', () =>
    {
        const src = 'export default component C() {\n    form login = { email: "" } with { onSubmit: { effect(v: unknown) { return v; } }.effect };\n    <p>{ login.values.email }</p>\n}\n';
        expect(emitLanes(src)).toEqual({ hEmit: 'parses', cloneEmit: 'parses' });
        expect(projection(src)).toBe('parses');
    });
});

describe('a malformed declaration at module scope is refused as in a component', () =>
{
    const ARMS: Record<string, string> = {
        handler: 'const row = () => <button onClick={ () => { state open[] = true; hook.v = open; } }>go</button>;',
        hole: 'const row = () => <b>{ (() => { state open[] = true; return open ? "y" : "n"; })() }</b>;',
        function: 'function tick(): void { state open[] = true; hook.v = open; }'
    };
    for (const [name, top] of Object.entries(ARMS))
    {
        it(name, () =>
        {
            const src = `${ top }\n${ mod('<i>m</i>') }`;
            expect(diagnoseModule(src).filter((d) => d.severity === 'error').map((d) => d.code)).toEqual(['azeroth/array-suffix']);
            expect(() => emit(src, true)).toThrow('azeroth/array-suffix');
            expect(() => emit(src, false)).toThrow('azeroth/array-suffix');
        });
    }
});

// A `{` after `with` opens an options object, so a method there named like a keyword is a method.
describe('a keyword-named method in a `with` option is left as written', () =>
{
    const EQUALS = '{ equals: { effect(a: number, b: number) { return a === b; } }.effect }';
    const ARMS: Record<string, { body?: string; click: string; top?: string; want: string }> = {
        body: { body: `state s = 1 with ${ EQUALS };`, click: 's = 6; hook.v = s;', want: 'v=6' },
        function: { body: `function go(): number { state s = 1 with ${ EQUALS }; s = 2; return s; }`, click: 'hook.v = go();', want: 'v=2' },
        handler: { click: `state s = 1 with ${ EQUALS }; s = 3; hook.v = s;`, want: 'v=3' },
        moduleFunction: { top: `function go(): number { derived d = 5 with ${ EQUALS }; return d; }`, click: 'hook.v = go();', want: 'v=5' }
    };
    for (const [name, a] of Object.entries(ARMS))
    {
        it(name, () =>
        {
            const src = `${ a.top ?? '' }\n${ mod(`<button onClick={ () => { ${ a.click } } }>go</button>`, a.body ?? '') }`;
            expect({ ...lanes({ src, fire: click('button'), probe: byV, html: '<button' }), projection: projection(src) })
                .toEqual({ ...green(a.want), projection: 'parses' });
            expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        });
    }
});

// `as` and `satisfies` name a declaration when a well-formed one follows and are operators before
// anything else; `in` and `instanceof` name nothing, so the keyword before them is a value.
describe('a declaration named like an operator word', () =>
{
    const ARMS: Record<string, { body?: string; click: string; want: string }> = {
        stateAs: { body: 'state as = 1;', click: 'as = as + 1; hook.v = as;', want: 'v=2' },
        derivedSatisfies: { body: 'derived satisfies = n * 2;', click: 'n = n + 2; hook.v = satisfies;', want: 'v=4' },
        deferredAs: { body: 'deferred as = n + 1;', click: 'hook.v = as;', want: 'v=1' },
        typedStateAs: { body: 'state as: number = 1;', click: 'as = as + 1; hook.v = as;', want: 'v=2' },
        stateAsNoInitializer: { body: 'state as;', click: 'as = 5; hook.v = as;', want: 'v=5' },
        definiteStateAs: { body: 'state as!: number;', click: 'as = 4; hook.v = as;', want: 'v=4' },
        spacedDefiniteStateAs: { body: 'state as ! : number;', click: 'as = 8; hook.v = as;', want: 'v=8' },
        stateAsWith: { body: 'state as with { name: "as" };', click: 'as = 6; hook.v = as;', want: 'v=6' },
        stateAsWithLineBreak: { body: 'state as\n    with\n    { name: "as" };', click: 'as = 7; hook.v = as;', want: 'v=7' },
        handlerStateAs: { click: 'state as = 1; as = as + 2; hook.v = as;', want: 'v=3' },
        // The keyword alone on its line declares too when a well-formed declaration follows it.
        valueOnTheNextLine: { body: 'state\n    as = 1;', click: 'as = as + 1; hook.v = as;', want: 'v=2' },
        typeOnTheNextLine: { body: 'state\n    as: number;', click: 'as = 3; hook.v = as;', want: 'v=3' },
        nameAloneOnTheNextLine: { body: 'state\n    as;', click: 'as = 9; hook.v = as;', want: 'v=9' },
        instanceofOperand: { body: 'const store: unknown = new Map();', click: 'hook.v = store instanceof Map ? "m" : "o";', want: 'v=m' },
        instanceofStatement: { body: 'const store: unknown = new Map();\n    let seen = 0;\n    store instanceof Map && (seen = 1);', click: 'hook.v = seen;', want: 'v=1' },
        asOperand: { body: 'const state: unknown = 5;', click: 'hook.v = (state as number) + 1;', want: 'v=6' },
        // `[]` is the array suffix only before a value, a type or options: here it is a cast.
        castToTheEmptyTuple: { body: 'const state: unknown = [];\n    let seen = 0;\n    state as [] && (seen = 1);', click: 'hook.v = seen;', want: 'v=1' },
        castToTheEmptyTupleAlone: { body: 'const state: unknown = [];\n    state as [];', click: 'hook.v = "kept";', want: 'v=kept' },
        formCastToTheEmptyTuple: { body: 'const form: unknown = [];\n    let seen = 0;\n    form as [] && (seen = 1);', click: 'hook.v = seen;', want: 'v=1' },
        // A type on the line after `as` or `satisfies` is its operand, so the keyword is a value.
        castOnTheNextLine: { body: 'const state: unknown = 4;\n    let seen = 0;\n    state as\n    number && (seen = 1);', click: 'hook.v = seen;', want: 'v=1' },
        satisfiesOnTheNextLine: { body: 'const state = 4;\n    let seen = 0;\n    state satisfies\n    number && (seen = 1);', click: 'hook.v = seen;', want: 'v=1' },
        // `with` continues a declaration only before a `{`: here it is a member name.
        memberNamedWith: { body: 'interface Slots\n    {\n        state\n        as\n        with: number;\n    }', click: 'hook.v = "kept";', want: 'v=kept' },
        // A keyword on one line and a typed list on the next are three members of an interface.
        membersInATypedList: { body: 'interface Slots\n    {\n        state\n        as, later: number;\n    }', click: 'hook.v = "kept";', want: 'v=kept' },
        // A variable named `state` and a next line that opens with `as` stay two statements.
        asiEquals: { click: 'let state = 1; let as = 2; state\n            as == 2;\n            batch { hook.v = as + state; }', want: 'v=3' },
        asiArrow: { click: 'let state = 1; let as = 2; state\n            as => as;\n            batch { hook.v = as + state; }', want: 'v=3' },
        asiBang: { click: 'let state = 1; let as: number | undefined = 2; state\n            as! = 5;\n            batch { hook.v = as + state; }', want: 'v=6' },
        asiIndex: { click: 'let state = 1; const as = [7]; let i = 5; state\n            as[i = 0];\n            batch { hook.v = as[i] + state; }', want: 'v=8' },
        // In the value of a declaration too, a keyword before an operator word is a value.
        valueInstanceof: { body: 'const store: unknown = new Map();\n    derived kind = store instanceof Map ? "map" : "other";', click: 'hook.v = kind;', want: 'v=map' },
        valueAs: { body: 'const state: unknown = 5;\n    derived kind = state as number;', click: 'hook.v = kind + 1;', want: 'v=6' },
        valueSatisfies: { body: 'const stream = 4;\n    derived kind = stream satisfies number;', click: 'hook.v = kind;', want: 'v=4' },
        valueIn: { body: 'const selector = "a";\n    const table: Record<string, number> = { a: 1 };\n    derived kind = selector in table ? "known" : "unknown";', click: 'hook.v = kind;', want: 'v=known' },
        stateValueAfterAnd: { body: 'const stream: unknown = new Map();\n    state kind = n >= 0 && stream instanceof Map;', click: 'hook.v = kind;', want: 'v=true' },
        stateValueArrowBody: { body: 'const store: unknown = new Map();\n    state kind = () => store instanceof Map;', click: 'hook.v = kind();', want: 'v=true' },
        deferredValue: { body: 'const form: unknown = new Map();\n    deferred kind = form instanceof Map ? 1 : 2;', click: 'hook.v = kind;', want: 'v=1' },
        storeValue: { body: 'const stream: unknown = new Map();\n    store kind = stream instanceof Map ? { size: 1 } : { size: 2 };', click: 'hook.v = kind().size;', want: 'v=1' },
        parenthesizedValue: { body: 'const store: unknown = new Map();\n    derived kind = (store instanceof Map) ? "map" : "other";', click: 'hook.v = kind;', want: 'v=map' },
        valueBeforeOptions: { body: 'const state = 4;\n    derived kind = state with { name: "kind" };', click: 'hook.v = kind;', want: 'v=4' },
        // An ASCII name that starts with the letters of an operator word is a name.
        nameStartingWithIn: { body: 'state inedit = 1;', click: 'inedit = inedit + 1; hook.v = inedit;', want: 'v=2' },
        nameStartingWithAs: { body: 'state asincrono = 1;', click: 'asincrono = asincrono + 1; hook.v = asincrono;', want: 'v=2' }
    };
    for (const [name, a] of Object.entries(ARMS))
    {
        it(name, () =>
        {
            const src = mod(`<button onClick={ () => { ${ a.click } } }>go</button>`, a.body ?? '');
            expect({ ...lanes({ src, fire: click('button'), probe: byV, html: '<button' }), projection: projection(src) })
                .toEqual({ ...green(a.want), projection: 'parses' });
            expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        });
    }

    // After the name a `,` or a `!` that is not `!:` continues no declaration: with the keyword
    // on one line and the name on the next, each line is a statement of its own.
    const STATEMENTS: Record<string, { statement: string; assigns?: boolean }> = {
        comma: { statement: ', spare;' },
        bang: { statement: '!;' },
        bangComma: { statement: '!, spare;' },
        bangValue: { statement: '! = 5;', assigns: true }
    };
    for (const kind of ['state', 'deferred', 'form'])
    {
        for (const [follower, f] of Object.entries(STATEMENTS))
        {
            it(`${ kind } then as ${ follower } on the next line`, () =>
            {
                const body = `let ${ kind } = 1;\n    let as: number | undefined = 2;\n    let spare = 0;\n    ${ kind }\n    as${ f.statement }`;
                const src = mod(`<button onClick={ () => { hook.v = (as ?? 0) + ${ kind } + spare; } }>go</button>`, body);
                expect({ ...lanes({ src, fire: click('button'), probe: byV, html: '<button' }), projection: projection(src) })
                    .toEqual({ ...green(f.assigns ? 'v=6' : 'v=3'), projection: 'parses' });
                expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
            });
        }
    }

    // A keyword before `in` is a value in every place, an empty array after it included.
    const KEY = 'const state: PropertyKey = "length";';
    const counted = (top: string, body: string, markup: string): string =>
        `let ran = 0;\n${ top }\nexport default component C() {\n    hook.read = () => ran;\n    ${ body }\n    <div>${ markup }</div>\n}`;
    const ran = (): string => `ran=${ (hook.read?.() ?? 0) > 0 ? 'yes' : 'no' }`;
    const runs = (src: string, fire: (r: HTMLElement) => void, html: string): void =>
    {
        expect({ ...lanes({ src, fire, probe: ran, html }), projection: projection(src) })
            .toEqual({ ...green('ran=yes'), projection: 'parses' });
        expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
    };
    interface Place { top?: string; body?: string; markup: string; fire?: (r: HTMLElement) => void; html: string }
    const moduleFunction = (test: string): Place =>
        ({ top: `${ KEY }\nfunction go(): void { ${ test } }`, markup: '<button onClick={ () => go() }>go</button>', fire: click('button'), html: '<button' });
    const PLACES: Record<string, (test: string) => Place> = {
        moduleScope: (test) => ({ top: `${ KEY }\n${ test }`, markup: '<i>m</i>', html: '<i>m</i>' }),
        moduleFunction,
        moduleMarkupHandler: (test) => ({ top: `${ KEY }\nconst row = () => <li onClick={ () => { ${ test } } }>r</li>;`, markup: '<ul>{ row() }</ul>', fire: click('li'), html: '<li' }),
        inlineHandler: (test) => ({ body: KEY, markup: `<button onClick={ () => { ${ test } } }>go</button>`, fire: click('button'), html: '<button' }),
        ref: (test) => ({ body: KEY, markup: `<b ref={ () => { ${ test } } }>r</b>`, html: '<b>r</b>' }),
        hole: (test) => ({ body: KEY, markup: `<b>{ (() => { ${ test } return "h"; })() }</b>`, html: '>h<' }),
        attribute: (test) => ({ body: KEY, markup: `<b title={ (() => { ${ test } return "t"; })() }>t</b>`, html: 'title="t"' }),
        nestedMarkupHandler: (test) => ({ body: KEY, markup: `<ul>{ [1].map((i) => <li onClick={ () => { ${ test } } }>{ i }</li>) }</ul>`, fire: click('li'), html: '<li' }),
        classToggle: (test) => ({ body: KEY, markup: `<b class:on={ (() => { ${ test } return true; })() }>t</b>`, html: 'class="on"' }),
        body: (test) => ({ body: `${ KEY }\n    ${ test }`, markup: '<i>b</i>', html: '<i>b</i>' }),
        bodyFunction: (test) => ({ body: `${ KEY }\n    function go(): void { ${ test } }`, markup: '<button onClick={ go }>go</button>', fire: click('button'), html: '<button' })
    };
    for (const [place, at] of Object.entries(PLACES))
    {
        it(`state in an empty array / ${ place }`, () =>
        {
            const p = at('state in [] && ran++;');
            runs(counted(p.top ?? '', p.body ?? '', p.markup), p.fire ?? none, p.html);
        });
    }
    for (const [name, test] of Object.entries({ filled: 'state in [0] && ran++;', parenthesized: 'state in ([]) && ran++;' }))
    {
        it(`state in a ${ name } array / moduleFunction`, () =>
        {
            const p = moduleFunction(test);
            runs(counted(p.top ?? '', '', p.markup), p.fire ?? none, p.html);
        });
    }

    it('state instanceof an empty array is left as written', () =>
    {
        const src = counted(`${ KEY }\nfunction go(): void { state instanceof [] && ran++; }`, '', '<i>m</i>');
        expect({ ...emitLanes(src), projection: projection(src) }).toEqual({ hEmit: 'parses', cloneEmit: 'parses', projection: 'parses' });
        expect(emit(src, true)).toContain('state instanceof [] && ran++;');
        expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
    });

    // The line after the keyword is a statement of its own, whatever a later regex holds.
    const LIST = 'function go(state: number, as: number, spare: number, text: string): void\n{\n    state\n    as, spare\n';
    const LATER: Record<string, { top: string; call: string }> = {
        inTheSameFunction: { top: `${ LIST }    if (text) /,;/.test(text) && ran++;\n}`, call: 'go(1, 2, 3, "a,;b");' },
        inAnotherFunction: { top: `${ LIST }}\nfunction later(text: string): void\n{\n    if (text) /,;/.test(text) && ran++;\n}`, call: 'go(1, 2, 3, "a"); later("a,;b");' }
    };
    for (const [name, a] of Object.entries(LATER))
    {
        it(`a list on the line after the keyword, a regex holding a comma and a semicolon ${ name }`, () =>
        {
            runs(counted(a.top, '', `<button onClick={ () => { ${ a.call } } }>go</button>`), click('button'), '<button');
        });
    }

    // An alias on the line after `as` in an import or an export list is left as written.
    const ALIASES: Record<string, string> = {
        importAlias: 'import {\n    state as\n    shared\n} from "./m";',
        exportAlias: 'const state = 1;\nexport {\n    state as\n    shared\n};'
    };
    for (const [name, top] of Object.entries(ALIASES))
    {
        it(`${ name } on the next line`, () =>
        {
            const src = `${ top }\n${ mod('<i>m</i>') }`;
            expect({ ...emitLanes(src), projection: projection(src) }).toEqual({ hEmit: 'parses', cloneEmit: 'parses', projection: 'parses' });
            expect(emit(src, true)).toContain('state as\n    shared');
            expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        });
    }

    // The array suffix `[]` continues a declaration before a value, a type or options, and after
    // a `form` name before the `;` that ends it.
    const ARRAY_FORMS: Record<string, string> = {
        plain: 'form as[] = { qty: "0" };',
        spaced: 'form as [ ] = { qty: "0" };',
        typed: 'form as[]: { qty: string }[] = { qty: "0" };',
        definite: 'form as[]!: { qty: string }[];',
        optioned: 'form as[] with { name: "rows" };',
        bare: 'form as[];',
        bareSpaced: 'form as [ ] ;'
    };
    for (const [name, declared] of Object.entries(ARRAY_FORMS))
    {
        it(`an array form named \`as\`, ${ name }`, () =>
        {
            const src = mod('<p>{ String(as.rows().length) }</p>', declared);
            expect({ ...emitLanes(src), projection: projection(src) }).toEqual({ hEmit: 'parses', cloneEmit: 'parses', projection: 'parses' });
            expect(emit(src, true)).toContain('createFieldArray');
            expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        });
    }

    it('a `[]` suffix on a state named `as` is refused', () =>
    {
        const src = mod('<i>m</i>', 'state as[] = true;');
        expect(diagnoseModule(src).filter((d) => d.severity === 'error').map((d) => d.code)).toEqual(['azeroth/array-suffix']);
        expect(() => emit(src, true)).toThrow('azeroth/array-suffix');
    });

    // A name that goes on with a non-ASCII letter after an operator word is refused as a name.
    const LONGER: Record<string, string> = { in: 'in\u00e9dit', as: 'as\u00edncrono', satisfies: 'satisfies\u00e9', instanceof: 'instanceof\u00e9' };
    for (const [word, name] of Object.entries(LONGER))
    {
        it(`a state whose name goes on with a non-ASCII letter after \`${ word }\` is refused`, () =>
        {
            const src = mod('<i>m</i>', `state ${ name } = 0;`);
            expect(diagnoseModule(src).filter((d) => d.severity === 'error').map((d) => d.code)).toEqual(['azeroth/non-ascii-name']);
            expect(() => emit(src, true)).toThrow('azeroth/non-ascii-name');
        });
    }

    // A declaration with no `;` swallows the one after it, a bare array form included.
    for (const [name, swallowed] of Object.entries({ state: 'state later = 1;', arrayForm: 'form as[];' }))
    {
        it(`a swallowed ${ name } is refused`, () =>
        {
            const src = mod('<i>m</i>', `derived twice = n * 2\n    ${ swallowed }`);
            expect(diagnoseModule(src).filter((d) => d.severity === 'error').map((d) => d.code)).toEqual(['azeroth/unterminated-declaration']);
            expect(() => emit(src, true)).toThrow('azeroth/unterminated-declaration');
        });
    }
});

// Where the scan meets a class, a `!`, `of`, a regex or a non-ASCII name: each shape is valid
// TypeScript whose keyword is lowered and whose keyword-named member stays a member.
describe('the class header, a postfix `!`, a member named `class` and `of`', () =>
{
    const KW = 'batch { hook.hits = hook.hits + 1; }';
    const box = (header: string, member = 'effect(v: number) { return v + 1; }'): string => `class Box${ header }\n{\n    ${ member }\n}`;
    const BOX = 'hook.hits = new Box().effect(0);';
    const MEMBER = 'effect(v: number) { return v + 1; }';
    // A module-scope object method: the statements, then the keyword in a labeled block.
    const inMethod = (stmts: string): string => `const checks = {\n    run()\n    {\n        ${ stmts }\n        counted:\n        {\n            ${ KW }\n        }\n    }\n};`;
    // A function of the component body: the statements, one more, then the keyword.
    const inGo = (stmts: string): string => `function go(x: unknown)\n{\n    ${ stmts }\n    hook.noop++;\n    ${ KW }\n}`;
    const ARMS: Record<string, { def: string; call: string; module?: boolean; after?: boolean }> = {
        arrowConstraint: { def: box('<F extends () => { size: number }>'), call: BOX },
        arrowConstraintModule: { def: box('<F extends () => { size: number }>'), call: BOX, module: true },
        keyofConstraint: { def: box('<K extends keyof { a: 1; b: 2 }>'), call: BOX },
        readonlyConstraint: { def: box('<T extends readonly { a: 1 }[]>'), call: BOX },
        predicateConstraint: { def: box('<G extends (x: unknown) => x is { a: 1 }>'), call: BOX },
        arrowDefault: { def: box('<F = () => { size: number }>'), call: BOX },
        implementsTypeArgument: { def: `interface Sized<T> { size?: T }\n${ box(' implements Sized<() => { size: number }>') }`, call: BOX },
        extendsTypeArgument: { def: `class Base<T> { t?: T }\n${ box(' extends Base<() => { size: number }>') }`, call: BOX },
        fieldAfterHeader: { def: box('<F extends () => { size: number }>', 'state\n    count = 1;'), call: 'hook.hits = new Box().count;' },
        objectConstraint: { def: box('<T extends { size: number }>'), call: BOX },
        plainClass: { def: box(''), call: BOX },
        nonAsciiClassName: { def: `class \u00c9t\u00e9\n{\n    ${ MEMBER }\n}`, call: 'hook.hits = new \u00c9t\u00e9().effect(0);' },
        nonAsciiName: { def: `function go(x: unknown)\n{\n    const caf\u00e9 = hook.el;\n    hook.v = caf\u00e9!\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        spacedBang: { def: `function go(x: unknown)\n{\n    hook.v = hook.el !\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        doubledBang: { def: `function go(x: unknown)\n{\n    hook.v = hook.el!!\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        bang: { def: `function go(x: unknown)\n{\n    hook.v = hook.el!\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        prefixBang: { def: `function go(x: unknown)\n{\n    hook.v = !{ effect(v: number) { return v; } }.effect;\n    ${ KW }\n}`, call: 'go(1);' },
        typeofBang: { def: `function go(x: unknown)\n{\n    hook.v = typeof !{ ${ MEMBER } }.effect;\n    ${ KW }\n}`, call: 'go(1);' },
        returnBang: { def: `function go(x: unknown)\n{\n    ${ KW }\n    if (x === 0)\n    {\n        return !{ ${ MEMBER } }.effect;\n    }\n    return false;\n}`, call: 'go(1);' },
        voidBang: { def: `function go(x: unknown)\n{\n    hook.v = void !{ ${ MEMBER } }.effect;\n    ${ KW }\n}`, call: 'go(1);' },
        elseBang: { def: `function go(x: unknown)\n{\n    if (x === 0) hook.v = 1;\n    else !{ ${ MEMBER } }.effect;\n    ${ KW }\n}`, call: 'go(1);' },
        doBang: { def: `function go(x: unknown)\n{\n    do !{ ${ MEMBER } }.effect; while (x === 0);\n    ${ KW }\n}`, call: 'go(1);' },
        caseBang: { def: `function go(x: unknown)\n{\n    switch (x) { case !{ ${ MEMBER } }.effect: break; }\n    ${ KW }\n}`, call: 'go(1);' },
        plainBang: { def: `function go(x: unknown)\n{\n    const el = hook.el;\n    hook.v = el!\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        memberDoBang: { def: `function go(x: unknown)\n{\n    const o = { do: hook.el };\n    hook.v = o.do!\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        memberReturnBang: { def: `function go(x: unknown)\n{\n    const o = { return: hook.el };\n    hook.v = o.return!\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        privateReturnBang: { def: `class Q\n{\n    #return = 1;\n    run()\n    {\n        hook.v = this.#return!\n        {\n            ${ KW }\n        }\n    }\n}`, call: 'new Q().run();' },
        fieldNamedClass: { def: `class Row\n{\n    class\n    count = 0;\n    bump()\n    {\n        ${ KW }\n    }\n}`, call: 'new Row().bump();' },
        fieldNamedClassNoSemicolons: { def: `class Row\n{\n    class\n    count = 0\n    bump()\n    {\n        ${ KW }\n    }\n}`, call: 'new Row().bump();' },
        privateFieldNamedClass: { def: `class Row\n{\n    #class\n    count = 0;\n    bump()\n    {\n        ${ KW }\n    }\n}`, call: 'new Row().bump();' },
        privateClassRead: { def: `class Chip\n{\n    #class = 'on'\n    toggle()\n    {\n        const name = this.#class\n        if (name)\n        {\n            ${ KW }\n        }\n    }\n}`, call: 'new Chip().toggle();' },
        classExpressionField: { def: `class Row\n{\n    kind = class\n    {\n        effect(v: number) { return v; }\n    };\n    bump()\n    {\n        ${ KW }\n    }\n}`, call: 'new Row().bump(); hook.hits = hook.hits + new (new Row().kind)().effect(0);' },
        typeNamedOfInCall: { def: `type of = void;\nfunction invoke(f: () => void) { f(); }\nfunction go(x: unknown)\n{\n    invoke(function (): of\n    {\n        ${ KW }\n    });\n}`, call: 'go(1);' },
        forOfObject: { def: `function go(x: unknown)\n{\n    for (const k of Object.keys({ effect(v: number) { return v; } }))\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        forOfPrefixBang: { def: `function go(x: unknown)\n{\n    for (const k of !{ ${ MEMBER } }.effect ? [1] : [2])\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        // A value named `of` is an operand: `++` and `!` after it are postfix and a `/` divides.
        ofIncrementThenBlock: { def: `function go(x: unknown)\n{\n    let of = 5;\n    of++\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        ofBangThenBlock: { def: `function go(x: unknown)\n{\n    const of = hook.el;\n    hook.v = of!\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        ofDividedInConditional: { def: `function go(x: unknown)\n{\n    const of = 6;\n    switch (x)\n    {\n        case 0:\n            hook.v = hook.noop ? of / 2 : of / 3;\n            break;\n        case 1:\n        {\n            ${ KW }\n        }\n    }\n}`, call: 'go(1);' },
        // A name with a non-ASCII or an astral character is one name, whatever word it holds.
        astralBangThenBlock: { def: `function go(x: unknown)\n{\n    const \u{1d4b3} = hook.el;\n    hook.v = \u{1d4b3}!\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        nameEndingInTheWordIn: { def: `function go(x: unknown)\n{\n    const prot\u00e9in = hook.el;\n    hook.v = prot\u00e9in\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        nameEndingInTheWordOf: { def: `function go(x: unknown)\n{\n    let pr\u00e9of = 5;\n    pr\u00e9of++\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        nameEndingInTheWordClass: { def: `function go(x: unknown)\n{\n    const d\u00e9class = hook.el;\n    hook.v = d\u00e9class\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        nameStartingWithTheWordClass: { def: `function go(x: unknown)\n{\n    const class\u00e9 = hook.el;\n    hook.v = class\u00e9\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        // A regex right after a statement head or `throw`: a `?`, a bracket or a word in it is text
        regexAfterIfThenCase: { def: `function go(x: unknown)\n{\n    switch (x)\n    {\n        case 0:\n            if (hook.noop) /a?b/.test('ab') && hook.noop++;\n            break;\n        case 1:\n        {\n            ${ KW }\n        }\n    }\n}`, call: 'go(1);' },
        regexAfterIfThenLabel: { def: `function go(x: unknown)\n{\n    if (x) /a?b/.test('ab') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexAfterElseIfThenLabel: { def: `function go(x: unknown)\n{\n    if (x === 0) hook.noop++; else if (x) /a?b/.test('ab') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexAfterWhileThenLabel: { def: `function go(x: unknown)\n{\n    let k = 1;\n    while (k--) /a?b/.test('ab') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexAfterForThenLabel: { def: `function go(x: unknown)\n{\n    for (const v of [x]) /a?b/.test('ab') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexAfterDoWhileThenLabel: { def: `function go(x: unknown)\n{\n    let k = 1;\n    do k--; while (k > 0)\n    /a?b/.test('ab') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        escapedQuestionAfterIfThenLabel: { def: `function go(x: unknown)\n{\n    if (x) /\\?page=/.test('?page=') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        thrownRegexThenLabel: { def: `function go(x: unknown)\n{\n    if (x === 0) throw /a?b/;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        thrownRegexThenBlock: { def: `function go(x: unknown)\n{\n    if (x === 0) throw /ab/\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexHoldingClassThenLoop: { def: `function go(x: unknown)\n{\n    if (x) /class Foo/.test('class Foo') && hook.noop++;\n    for (const v of [x])\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexHoldingBracketInMethod: { def: `function go(x: unknown)\n{\n    const checks = {\n        opens()\n        {\n            if (x) /[(]/.test('(') && hook.noop++;\n        }\n    };\n    checks.opens();\n    ${ KW }\n}`, call: 'go(1);', after: true },
        // The controls: the same regex in parentheses, and one with no `?`.
        parenthesizedRegexAfterIfThenLabel: { def: `function go(x: unknown)\n{\n    if (x) (/a?b/).test('ab') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        plainRegexAfterIfThenLabel: { def: `function go(x: unknown)\n{\n    if (x) /a*b/.test('ab') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        // A regex statement on the line after a statement with no `;`, or after a no-break space:
        // what its text leaves open is closed at the `;`, so the next label or case opens a block.
        regexAfterTypedLetThenLabel: { def: `function go(x: unknown)\n{\n    let matched: boolean\n    /colou?r/.test('color') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexAfterTypeAliasThenCase: { def: `function go(x: unknown)\n{\n    switch (x)\n    {\n        case 0:\n            type Hit = boolean\n            /\\?page=/.test('?page=') && hook.noop++;\n            break;\n        case 1:\n        {\n            ${ KW }\n        }\n    }\n}`, call: 'go(1);' },
        regexAfterDebuggerThenLoop: { def: `function go(x: unknown)\n{\n    debugger\n    /class Foo/.test('class Foo') && hook.noop++;\n    for (const v of [x])\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexAfterTypedLetInMethod: { def: `function go(x: unknown)\n{\n    const checks = {\n        opens()\n        {\n            let seen: boolean\n            /[(]/.test('(') && hook.noop++;\n        }\n    };\n    checks.opens();\n    ${ KW }\n}`, call: 'go(1);', after: true },
        regexAfterNoBreakSpaceThenLabel: { def: `function go(x: unknown)\n{\n    const ok =\u00a0/colou?r/.test('color');\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexAfterNoBreakSpaceInField: { def: `class Box\n{\n    ok =\u00a0/[(]/.test('(') ? 1 : 2;\n    ${ MEMBER }\n}\nfunction go(x: unknown)\n{\n    hook.noop = new Box().effect(0);\n    ${ KW }\n}`, call: 'go(1);', after: true },
        objectDividedInAListThenLabel: { def: `function go(x: unknown)\n{\n    const halves = [{ a: 1 } / 2, 3];\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);', after: true },
        // A closer in such text closes its own kind: a `)` or `]` closes no block and no class
        // body, and a `}` no bracket, so the method around it stays open to its own `}`.
        closerInRegexThenLabel: { def: inMethod('let seen: boolean\n        /[)]/.test(\')\') && hook.noop++;'), call: 'checks.run();', after: true },
        escapedCloserInRegexThenLabel: { def: inMethod('let seen: boolean\n        /\\]/.test(\']\') && hook.noop++;'), call: 'checks.run();', after: true },
        closingBraceInRegexThenLabel: { def: inMethod('let seen: boolean\n        /[}]/.test(\'}\') && hook.noop++;'), call: 'checks.run();', after: true },
        closerInRegexAfterTypeofInThenLabel: { def: inMethod('const stats = { in: 4 };\n        let total: typeof stats.in\n        /[)]/.test(\')\') && hook.noop++;'), call: 'checks.run();', after: true },
        closerInRegexAfterNoBreakSpaceThenLabel: { def: inMethod('const ok =\u00a0/[)]/.test(\')\');'), call: 'checks.run();', after: true },
        closerInRegexAfterNoBreakSpaceInField: { def: `class Box\n{\n    ok =\u00a0/[)]/.test(')') ? 1 : 2;\n    ${ MEMBER }\n}\nfunction go(x: unknown)\n{\n    hook.noop = new Box().effect(0);\n    ${ KW }\n}`, call: 'go(1);', after: true },
        bracketAndBraceInRegexThenLabel: { def: inMethod('let seen: boolean\n        /[({]/.test(\'(\') && hook.noop++;'), call: 'checks.run();', after: true },
        regexAfterTypedLetEndsMethod: { def: `function go(x: unknown)\n{\n    const checks = {\n        opens()\n        {\n            let seen: boolean\n            /[(]/.test('(') && hook.noop++\n        }\n    };\n    checks.opens();\n    ${ KW }\n}`, call: 'go(1);', after: true },
        objectDividedByAGroupThenLabel: { def: inMethod('const halves = [{ a: 1 } / (2 /* half */), 3];'), call: 'checks.run();', after: true },
        objectDividedTwiceThenLabel: { def: inMethod('const halves = { a: 1 } / (hook.noop / 2);'), call: 'checks.run();', after: true },
        // The controls: a `;` before the regex, a class that closes what it opens, the object in
        // parentheses.
        closerInRegexAfterSemicolonThenLabel: { def: inMethod('let seen: boolean;\n        /[)]/.test(\')\') && hook.noop++;'), call: 'checks.run();', after: true },
        balancedRegexThenLabel: { def: inMethod('let seen: boolean\n        /[()]/.test(\')\') && hook.noop++;'), call: 'checks.run();', after: true },
        parenthesizedObjectDividedByAGroupThenLabel: { def: inMethod('const halves = [({ a: 1 }) / (2 /* half */), 3];'), call: 'checks.run();', after: true },
        // A `!` on the line after a statement with no `;` is a prefix, and so is one after it.
        doubledBangAfterLineBreakThenLabel: { def: `function go(x: unknown)\n{\n    const wanted = String(x)\n    !!/colou?r/.test(wanted) && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        spacedBangsAfterLineBreakThenLabel: { def: `function go(x: unknown)\n{\n    const wanted = String(x)\n    ! !/colou?r/.test(wanted) && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        tripleBangAfterLineBreakThenLabel: { def: `function go(x: unknown)\n{\n    const wanted = String(x)\n    !!!/colou?r/.test(wanted) && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        doubledBangAfterCallThenCase: { def: `function go(x: unknown)\n{\n    switch (x)\n    {\n        case 0:\n            String(x)\n            !!/\\?page=/.test('?page=') && hook.noop++;\n            break;\n        case 1:\n        {\n            ${ KW }\n        }\n    }\n}`, call: 'go(1);' },
        regexAfterTypeofOfThenLabel: { def: `function go(x: unknown)\n{\n    const of = 1;\n    let total: typeof of\n    /colou?r/.test('color') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        // The controls: a `;` before the regex, no `?`, an ASCII space, one `!`, a `;` before two.
        regexAfterSemicolonThenLabel: { def: `function go(x: unknown)\n{\n    let matched: boolean;\n    /colou?r/.test('color') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        plainRegexAfterTypedLetThenLabel: { def: `function go(x: unknown)\n{\n    let matched: boolean\n    /colou*r/.test('color') && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        regexAfterSpaceThenLabel: { def: `function go(x: unknown)\n{\n    const ok = /colou?r/.test('color');\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        bangAfterLineBreakThenLabel: { def: `function go(x: unknown)\n{\n    const wanted = String(x)\n    !/colou?r/.test(wanted) && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        doubledBangAfterSemicolonThenLabel: { def: `function go(x: unknown)\n{\n    const wanted = String(x);\n    !!/colou?r/.test(wanted) && hook.noop++;\n    counted:\n    {\n        ${ KW }\n    }\n}`, call: 'go(1);' },
        // A regex does not close on the first `/` of a `//`: after a `/` that divides, or one
        // that closes a regex read as a division, the line comment stays a comment.
        castDividedThenComment: { def: inGo('hook.v = hook.noop as Readonly<number> / 2; // it\'s half'), call: 'go(1);' },
        castDividedThenQuoteComment: { def: inGo('hook.v = hook.noop as Readonly<number> / 2; // the "half'), call: 'go(1);' },
        castDividedThenBacktickComment: { def: inGo('hook.v = hook.noop as Readonly<number> / 2; // the `half'), call: 'go(1);' },
        castDividedThenGluedComment: { def: inGo('hook.v = hook.noop as Readonly<number> / 2;//it\'s half'), call: 'go(1);' },
        satisfiesDividedThenComment: { def: inGo('hook.v = hook.noop satisfies Readonly<number> / 2; // it\'s half'), call: 'go(1);' },
        regexStatementThenComment: { def: inGo('let found: boolean\n    /\\d+/.test(\'1\') && hook.noop++; // it\'s a digit'), call: 'go(1);' },
        regexAfterNoBreakSpaceThenComment: { def: inGo('const ok =\u00a0/\\d+/.test(\'1\'); // it\'s a digit'), call: 'go(1);' },
        // The controls: a plain comment, the cast in parentheses, the comment on the next line,
        // a comment of three slashes, a regex with a comment glued to it, and a regex multiplied.
        castDividedThenPlainComment: { def: inGo('hook.v = hook.noop as Readonly<number> / 2; // half of it'), call: 'go(1);' },
        parenthesizedCastDividedThenComment: { def: inGo('hook.v = (hook.noop as Readonly<number>) / 2; // it\'s half'), call: 'go(1);' },
        castDividedThenCommentOnTheNextLine: { def: inGo('hook.v = hook.noop as Readonly<number> / 2;\n    // it\'s half'), call: 'go(1);' },
        castDividedThenTripleSlashComment: { def: inGo('hook.v = hook.noop as Readonly<number> / 2; /// it\'s half'), call: 'go(1);' },
        regexThenGluedLineComment: { def: inGo('hook.v = /it\'s///a contraction'), call: 'go(1);' },
        regexThenGluedBlockComment: { def: inGo('hook.v = /it\'s//*a contraction*/;'), call: 'go(1);' },
        regexMultipliedGlued: { def: inGo('hook.v = /it\'s/*2;'), call: 'go(1);' }
    };
    const indent = (text: string): string => text.split('\n').join('\n    ');
    for (const [name, a] of Object.entries(ARMS))
    {
        it(name, () =>
        {
            const run = `const run = () => { try { ${ a.call } } catch (e) { hook.v = String(e); } };`;
            // A module-scope definition stands before the component, or after it when it holds a
            // bracket the module scan would count.
            const src = a.after
                ? `${ mod('<button onClick={ run }>go</button>', run) }\n${ a.def }`
                : a.module
                    ? `${ a.def }\n${ mod('<button onClick={ run }>go</button>', run) }`
                    : mod('<button onClick={ run }>go</button>', `${ indent(a.def) }\n    ${ run }`);
            const v = generateVirtualCode(src) as unknown as { code: string } | string;
            const projected = typeof v === 'string' ? v : v.code;
            const hits = (): string => `hits=${ hook.hits }`;
            expect({
                ...lanes({ src, fire: click('button'), probe: hits, html: '<button' }),
                projection: parses(projected),
                raw: /\bbatch\s*\{/.test(projected),
                member: !src.includes(MEMBER) || projected.includes(MEMBER)
            }).toEqual({ ...green('hits=1'), projection: 'parses', raw: false, member: true });
            expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        });
    }
});

// A `/` divides after a postfix `!`, `++` or `--`, a member name, a literal or a value named `of`.
// After a prefix operator, a statement head, `throw` or a spread it opens a regex.
describe('a division after a postfix operator or a member name keeps the method body', () =>
{
    const LINES: Record<string, string> = {
        bang: 'hook.v = hook.noop! / Math.max(\n            1, 2);',
        increment: 'hook.v = hook.noop++ / Math.max(\n            1, 2);',
        decrement: 'hook.v = hook.noop-- / Math.max(\n            1, 2);',
        callBang: 'hook.v = Number(hook.noop)! / Math.max(\n            1, 2);',
        bangArray: 'hook.v = hook.noop! / [\n            1][0];',
        memberIn: 'const stats = { in: 4 };\n        hook.v = stats.in / Math.max(\n            1, 2);',
        memberOf: 'const stats = { of: 4 };\n        hook.v = stats.of / Math.max(\n            1, 2);',
        memberHeadBang: 'const stats = { for: (v: number) => v };\n        hook.v = stats.for(4)! / Math.max(\n            1, 2);',
        // After a control head or a line break the `!` is a prefix and the `/` opens a regex.
        headBang: 'if (hook.hits === 0) !/[)]/.test(\')\') && hook.noop++;',
        whileBang: 'while (hook.hits < 0) !/[)]/.test(\')\') && hook.noop++;',
        forBang: 'for (let i = 0; i < 1; i++) !/[)]/.test(\')\') && hook.noop++;',
        lineBreakBang: 'const t = hook.noop\n        !/[)]/.test(\')\') && hook.noop++;',
        doubledLineBreakBang: 'const t = hook.noop\n        !!/[)]/.test(\')\') && hook.noop++;',
        // A `++` or `--` before its operand or after a line break is a prefix, and the third
        // sign of a run is binary: the `/` after each opens a regex.
        prefixIncrementRegex: 'hook.v = ++/[)]/.lastIndex;',
        prefixDecrementRegex: 'hook.v = --/[)]/.lastIndex;',
        lineBreakIncrementRegex: 'hook.v = hook.noop\n        ++/[)]/.lastIndex;',
        tripleIncrementRegex: 'hook.v = hook.noop+++/[)]/.lastIndex;',
        tripleDecrementRegex: 'hook.v = hook.noop---/[)]/.lastIndex;',
        // Markup on the line after a postfix operator stays markup, past a comment too.
        markupAfterIncrement: 'hook.noop++\n        <p>{ hook.noop }</p>;',
        markupAfterBang: 'hook.v = hook.noop!\n        <p>{ hook.noop }</p>;',
        markupAfterComment: 'hook.noop++ // counted\n        <p>{ hook.noop }</p>;',
        // Text in that markup is no code: an apostrophe there opens no string.
        markupTextAfterIncrement: 'hook.noop++\n        <p>it\'s { hook.noop }</p>;',
        markupTextAfterBang: 'hook.v = hook.noop!\n        <p>it\'s { hook.noop }</p>;',
        markupTextAfterComment: 'hook.noop++ // counted\n        <p>it\'s { hook.noop }</p>;',
        // A `/` after a literal, a value named `of` or a name with a non-ASCII character divides,
        // as it does inside a statement head.
        regexDivided: 'hook.v = /x/ / Math.max(\n            1, 2);',
        ofDivided: 'const of = 4;\n        hook.v = of / Math.max(\n            1, 2);',
        ofBangDivided: 'const of: number | undefined = 4;\n        hook.v = of! / Math.max(\n            1, 2);',
        nonAsciiTailDivided: 'const prot\u00e9in = 4;\n        hook.v = prot\u00e9in / Math.max(\n            1, 2);',
        astralBangDivided: 'const \u{1d4b3}: number | undefined = 4;\n        hook.v = \u{1d4b3}! / Math.max(\n            1, 2);',
        divisionInHead: 'const limit = 4;\n        if (limit / Math.max(\n            1, 2) > 99) hook.noop++;',
        // With a second `/` on the line, a regex opened at the first would close there and take
        // the `(` between them.
        bangTwice: 'hook.v = hook.noop! / Math.max(1 / 2, 2);',
        incrementTwice: 'hook.v = hook.noop++ / Math.max(1 / 2, 2);',
        decrementTwice: 'hook.v = hook.noop-- / Math.max(1 / 2, 2);',
        memberInTwice: 'const stats = { in: 4 };\n        hook.v = stats.in / Math.max(1 / 2, 2);',
        memberOfTwice: 'const stats = { of: 4 };\n        hook.v = stats.of / Math.max(1 / 2, 2);',
        memberHeadBangTwice: 'const stats = { for: (v: number) => v };\n        hook.v = stats.for(4)! / Math.max(1 / 2, 2);',
        regexDividedTwice: 'hook.v = /x/ / Math.max(1 / 2, 2);',
        ofDividedTwice: 'const of = 4;\n        hook.v = of / Math.max(1 / 2, 2);',
        ofBangDividedTwice: 'const of: number | undefined = 4;\n        hook.v = of! / Math.max(1 / 2, 2);',
        nonAsciiTailDividedTwice: 'const prot\u00e9in = 4;\n        hook.v = prot\u00e9in / Math.max(1 / 2, 2);',
        astralBangDividedTwice: 'const \u{1d4b3}: number | undefined = 4;\n        hook.v = \u{1d4b3}! / Math.max(1 / 2, 2);',
        divisionInHeadTwice: 'const limit = 4;\n        if (limit / Math.max(1 / 2, 2) > 99) hook.noop++;',
        // With a block between the two, that regex would take its `{` and leave its `}` to
        // close the method.
        bangBlock: 'hook.v = hook.noop! / (() => { return 1 / 2; })();',
        memberInBlock: 'const stats = { in: 4 };\n        hook.v = stats.in / (() => { return 1 / 2; })();',
        memberHeadBangBlock: 'const stats = { for: (v: number) => v };\n        hook.v = stats.for(4)! / (() => { return 1 / 2; })();',
        regexDividedBlock: 'hook.v = /x/ / (() => { return 1 / 2; })();',
        ofDividedBlock: 'const of = 4;\n        hook.v = of / (() => { return 1 / 2; })();',
        ofBangDividedBlock: 'const of: number | undefined = 4;\n        hook.v = of! / (() => { return 1 / 2; })();',
        nonAsciiTailDividedBlock: 'const prot\u00e9in = 4;\n        hook.v = prot\u00e9in / (() => { return 1 / 2; })();',
        astralBangDividedBlock: 'const \u{1d4b3}: number | undefined = 4;\n        hook.v = \u{1d4b3}! / (() => { return 1 / 2; })();',
        divisionInHeadBlock: 'const limit = 4;\n        if (limit / (() => { return 1 / 2; })() > 99) hook.noop++;',
        // The `;` of a `for` head ends no statement: the head stays open to its `)`.
        forHeadThenBlock: 'for (let i = 0; i < 1; i++)\n        {\n            hook.noop++;\n        }',
        // A `/` after a statement head, `throw`, a spread or `of` in a `for` head opens a regex.
        headRegex: 'if (hook.hits === 0) /[}]/.test(\'}\') && hook.noop++;',
        elseIfRegex: 'if (hook.hits > 99) hook.noop++; else if (hook.hits === 0) /[}]/.test(\'}\') && hook.noop++;',
        whileRegex: 'while (hook.hits < 0) /[}]/.test(\'}\') && hook.noop++;',
        forRegex: 'for (let i = 0; i < 1; i++) /[}]/.test(\'}\') && hook.noop++;',
        doWhileRegex: 'do hook.noop++; while (hook.hits < 0)\n        /[}]/.test(\'}\') && hook.noop++;',
        forOfRegex: 'for (const found of /[}]/.exec(\'}\') ?? []) hook.noop += found.length;',
        throwRegex: 'if (hook.hits > 99) throw /[}]/;',
        spreadRegex: 'hook.v = [.../[}]/.source];',
        spreadTypeofRegex: 'hook.v = [...typeof /[}]/];',
        spreadTypeofNamedGroup: 'hook.v = [...typeof /(?<year>\\d+)/];',
        // An escaped `}` in such a regex is text: read as a division, it would close the method.
        headRegexEscapedBrace: 'if (hook.hits === 0) /\\}/.test(\'}\') && hook.noop++;',
        whileRegexEscapedBrace: 'while (hook.hits < 0) /\\}/.test(\'}\') && hook.noop++;',
        forRegexEscapedBrace: 'for (let i = 0; i < 1; i++) /\\}/.test(\'}\') && hook.noop++;',
        forOfRegexEscapedClosers: 'for (const found of /\\)\\}/.exec(\')}\') ?? []) hook.noop += found.length;',
        throwRegexEscapedBrace: 'if (hook.hits > 99) throw /\\}/;',
        spreadRegexInObject: 'hook.v = { .../\\}/ };',
        headBangEscapedBrace: 'if (hook.hits === 0) !/\\}/.test(\'}\') && hook.noop++;',
        doubledLineBreakBangEscapedBrace: 'const t = hook.noop\n        !!/\\}/.test(\'}\') && hook.noop++;',
        prefixIncrementEscapedBrace: 'hook.v = ++/\\}/.lastIndex;',
        lineBreakIncrementEscapedBrace: 'hook.v = hook.noop\n        ++/\\}/.lastIndex;',
        // A regex statement on the line after a statement with no `;` is read as divisions. Where
        // its text ends in a word, a spread or a head, the closing `/` opens no regex.
        regexEndingInDefault: 'let found: boolean\n        /^export default/.test(\'x\') && hook.noop++;',
        regexEndingInThrow: 'let found: boolean\n        /^throw/.test(\'x\') && hook.noop++;',
        regexEndingInWith: 'let found: boolean\n        /^with/.test(\'x\') && hook.noop++;',
        regexEndingInExtends: 'type Row = number\n        / extends/.test(\'x\') && hook.noop++;',
        regexEndingInDots: 'let found: boolean\n        /^.../.test(\'x\') && hook.noop++;',
        regexEndingInAHead: 'let found: boolean\n        /while (x)/.test(\'x\') && hook.noop++;',
        regexAfterMemberNamedIn: 'const stats = { in: 4 };\n        let total: typeof stats.in\n        /^in /.test(\'in \') && hook.noop++;',
        // With a second `/` on the line that regex closes there and takes a `(` with it: the `)`
        // left over closes no block and no class body.
        regexEndingInThrowTwice: 'let found: boolean\n        /^throw/.test(\'x\' + 4 / 2) && hook.noop++;',
        regexEndingInAHeadTwice: 'let found: boolean\n        /while (x)/.test(\'x\' + 4 / 2) && hook.noop++;',
        regexEndingInDotsTwice: 'let found: boolean\n        /^.../.test(\'x\' + 4 / 2) && hook.noop++;',
        regexEndingInEqualsTwice: 'let found: boolean\n        /^a=/.test(\'x\' + 4 / 2) && hook.noop++;',
        // The controls: a `;` before the regex, and a word that leads no regex.
        regexEndingInDefaultAfterSemicolon: 'let found: boolean;\n        /^export default/.test(\'x\') && hook.noop++;',
        regexEndingInConst: 'let found: boolean\n        /^export const/.test(\'x\') && hook.noop++;',
        regexEndingInThrowTwiceAfterSemicolon: 'let found: boolean;\n        /^throw/.test(\'x\' + 4 / 2) && hook.noop++;',
        regexEndingInConstTwice: 'let found: boolean\n        /^const/.test(\'x\' + 4 / 2) && hook.noop++;',
        // A regex does not close on the first `/` of a `//`: a `/` the scan takes for its start,
        // after a cast to a generic type or at the end of a regex read as divisions, divides.
        castDividedThenComment: 'hook.v = hook.noop as Readonly<number> / 2; // it\'s half\n        hook.noop++;',
        castDividedThenQuoteComment: 'hook.v = hook.noop as Readonly<number> / 2; // the "half\n        hook.noop++;',
        castDividedThenBacktickComment: 'hook.v = hook.noop as Readonly<number> / 2; // the `half\n        hook.noop++;',
        castDividedThenBraceComment: 'hook.v = hook.noop as Readonly<number> / 2; // half }\n        hook.noop++;',
        castDividedThenGluedComment: 'hook.v = hook.noop as Readonly<number> / 2;//it\'s half\n        hook.noop++;',
        satisfiesDividedThenComment: 'hook.v = hook.noop satisfies Readonly<number> / 2; // it\'s half\n        hook.noop++;',
        regexStatementThenComment: 'let found: boolean\n        /\\d+/.test(\'1\') && hook.noop++; // it\'s a digit\n        hook.noop++;',
        regexAfterNoBreakSpaceThenComment: 'const ok =\u00a0/\\d+/.test(\'1\'); // it\'s a digit\n        hook.noop++;',
        // The `;` before that comment ends its statement, so the keyword on the next line is one.
        castDividedThenCommentThenKeyword: 'hook.v = hook.noop as Readonly<number> / 2; // half',
        // The controls: a plain comment, the cast in parentheses, the comment on the next line,
        // a comment of three slashes.
        castDividedThenPlainComment: 'hook.v = hook.noop as Readonly<number> / 2; // half of it\n        hook.noop++;',
        parenthesizedCastDividedThenComment: 'hook.v = (hook.noop as Readonly<number>) / 2; // it\'s half\n        hook.noop++;',
        castDividedThenCommentOnTheNextLine: 'hook.v = hook.noop as Readonly<number> / 2;\n        // it\'s half\n        hook.noop++;',
        castDividedThenTripleSlashComment: 'hook.v = hook.noop as Readonly<number> / 2; /// it\'s half\n        hook.noop++;',
        // A regex keeps its text before a comment, spaced or glued to it, with a flag and in a
        // call.
        regexThenSpacedComment: 'hook.v = /it\'s/ // a contraction\n        hook.noop++;',
        regexThenGluedLineComment: 'hook.v = /it\'s///a contraction\n        hook.noop++;',
        regexThenGluedBlockComment: 'hook.v = /it\'s//*a contraction*/;',
        flaggedRegexThenGluedLineComment: 'hook.v = /it\'s/g//a contraction\n        hook.noop++;',
        flaggedRegexThenGluedBlockComment: 'hook.v = /it\'s/g/*a contraction*/;',
        regexInACallThenComment: 'hook.v = String(hook.noop).replace(/it\'s/, \'\'); // a contraction',
        // It keeps it before a `*`, and before a `/` that a flag or a space sets apart from it.
        regexMultipliedGlued: 'hook.v = /it\'s/*2;',
        plainRegexMultipliedGlued: 'hook.v = /abc/*2;',
        flaggedRegexDividedGlued: 'hook.v = /it\'s/g/ 2;',
        regexDividedSpaced: 'hook.v = /it\'s/ / 2;',
        // Divided by a `/` right after its closing `/`, a regex is read as a division. Text that
        // is balanced as code, with a statement after its line, keeps the keyword a statement.
        regexDividedGlued: 'hook.v = /abc// 2;\n        hook.noop++;'
    };
    const BATCH = 'batch { hook.hits = hook.hits + 1; }';
    const SCOPES: Record<string, (line: string, mark?: string) => string> = {
        objectMethod: (line, mark = '') => `const api = {\n    ${ mark }go()\n    {\n        ${ line }\n        ${ BATCH }\n    }\n};`,
        classMethod: (line, mark = '') => `class Api\n{\n    ${ mark }go()\n    {\n        ${ line }\n        ${ BATCH }\n    }\n}\nconst api = new Api();`,
        classFieldArrow: (line, mark = '') => `class Api\n{\n    go = ${ mark }() =>\n    {\n        ${ line }\n        ${ BATCH }\n    };\n}\nconst api = new Api();`,
        function: (line, mark = '') => `const api = { go: () => run() };\n${ mark }function run()\n{\n    ${ line }\n    ${ BATCH }\n}`
    };
    for (const [name, line] of Object.entries(LINES))
    {
        for (const [scope, wrap] of Object.entries(SCOPES))
        {
            it(`${ name } in a module ${ scope }`, () =>
            {
                const src = `${ mod('<button onClick={ () => api.go() }>go</button>') }\n${ wrap(line) }`;
                const hits = (): string => `hits=${ hook.hits }`;
                expect({ ...lanes({ src, fire: click('button'), probe: hits, html: '<button' }), projection: projection(src) })
                    .toEqual({ ...green('hits=1'), projection: 'parses' });
                expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
            });
        }
    }

    // A `for await` head is a `for` head, and a member named `for` before `await` is not one. An
    // async method runs its keyword after the probe, so these pin the emit and the projection.
    const ASYNC_LINES: Record<string, string> = {
        forAwaitBang: 'for await (const x of [\')\']) !/[)]/.test(x) && hook.noop++;',
        forAwaitOfObject: 'for await (const x of { effect(v: number) { return [v]; } }.effect(1)) hook.noop += x;',
        memberForThenAwait: 'const stats = { for: 4 };\n        void stats.for\n        await (Promise.resolve(hook.noop))! / Math.max(\n            1, 2);',
        memberForThenAwaitTwice: 'const stats = { for: 4 };\n        void stats.for\n        await (Promise.resolve(hook.noop))! / Math.max(1 / 2, 2);',
        forAwaitRegex: 'for await (const x of [\'}\']) /[}]/.test(x) && hook.noop++;',
        spreadAwaitRegex: 'hook.v = [...await /[}]/.exec(\'}\')!];',
        memberForThenAwaitBlock: 'const stats = { for: 4 };\n        void stats.for\n        await (Promise.resolve(hook.noop))! / (() => { return 1 / 2; })();',
        forAwaitRegexEscapedBrace: 'for await (const x of [\'}\']) /\\}/.test(x) && hook.noop++;'
    };
    for (const [name, line] of Object.entries(ASYNC_LINES))
    {
        for (const [scope, wrap] of Object.entries(SCOPES))
        {
            it(`${ name } in a module ${ scope }`, () =>
            {
                const src = `${ mod('<p>x</p>') }\n${ wrap(line, 'async ') }`;
                expect({ ...emitLanes(src), projection: projection(src) })
                    .toEqual({ hEmit: 'parses', cloneEmit: 'parses', projection: 'parses' });
                expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
            });
        }
    }
});

describe('a regex after `export default`', () =>
{
    it('keeps the labeled block after it a block', () =>
    {
        const src = 'export default /a?b/;\nlet n = 0;\ncounted:\n{\n    batch { n = n + 1; }\n}\n';
        expect({ ...emitLanes(src), projection: projection(src), raw: /\bbatch\s*\{/.test(emit(src, true)) })
            .toEqual({ hEmit: 'parses', cloneEmit: 'parses', projection: 'parses', raw: false });
        expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
    });
});

// A `<` that opens a generic arrow's type parameters is not markup, with or without the trailing
// comma: the arrow, a generic function type and a generic call signature are left as written.
describe('a generic arrow in a markup expression', () =>
{
    const SHAPES: Record<string, string> = {
        typed: '<T>(v: T): T => v',
        untyped: '<T>(v: T) => v',
        constrained: '<T extends unknown>(v: T) => v',
        trailingComma: '<T,>(v: T): T => v'
    };
    const text = (r: HTMLElement): string => `text=${ r.querySelector('b')?.textContent }`;
    const WRITERS: Record<string, { markup: (g: string) => string; fire?: (r: HTMLElement) => void; probe: (r: HTMLElement) => string; want: string; html: string }> = {
        hole: { markup: (g) => `<b>{ (${ g })("ok") }</b>`, probe: text, want: 'text=ok', html: '>ok<' },
        attribute: { markup: (g) => `<b title={ (${ g })("ok") }>t</b>`, probe: attrOf('title'), want: 'title=ok', html: 'title="ok"' },
        classToggle: { markup: (g) => `<b class:on={ (${ g })(true) }>t</b>`, probe: attrOf('class'), want: 'class=on', html: 'class="on"' },
        classDynamic: { markup: (g) => `<b class={ (${ g })("ok") } class:x={ false }>t</b>`, probe: attrOf('class'), want: 'class=ok', html: 'class="ok"' },
        styleEntry: { markup: (g) => `<b style:color={ (${ g })("red") }>t</b>`, probe: colorOf, want: 'color=red', html: 'color: red' },
        styleDynamic: { markup: (g) => `<b style={ (${ g })("color: red") } style:margin={ "0px" }>t</b>`, probe: colorOf, want: 'color=red', html: 'color: red' },
        inlineHandler: { markup: (g) => `<button onClick={ () => { const id = ${ g }; n = id(n + 1); } }>go</button>`, fire: click('button'), probe: byN, want: 'n=1', html: '<button' },
        composedBind: { markup: (g) => `<input bind:value={ text } onInput={ () => { const id = ${ g }; n = id(n + 1); } } />`, fire: typeInto, probe: byN, want: 'n=1', html: '<input' },
        handlerStatement: { markup: (g) => `<button onClick={ () => { ${ g }; n = n + 1; } }>go</button>`, fire: click('button'), probe: byN, want: 'n=1', html: '<button' }
    };
    for (const [shape, g] of Object.entries(SHAPES))
    {
        for (const [writer, w] of Object.entries(WRITERS))
        {
            it(`${ shape } / ${ writer }`, () =>
            {
                const src = mod(w.markup(g));
                expect({ ...lanes({ src, fire: w.fire ?? none, probe: w.probe, html: w.html }), projection: projection(src) })
                    .toEqual({ ...green(w.want), projection: 'parses' });
                expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
            });
        }
    }

    const SIGNATURES: Record<string, string> = {
        functionType: 'const id: <T>(v: T) => T = (v) => v;',
        callSignature: 'const id: { <T>(v: T): T } = (v) => v;'
    };
    for (const [name, declared] of Object.entries(SIGNATURES))
    {
        it(`a generic ${ name } in a handler`, () =>
        {
            const src = mod(`<button onClick={ () => { ${ declared } n = id(n + 1); } }>go</button>`);
            expect({ ...lanes({ src, fire: click('button'), probe: byN, html: '<button' }), projection: projection(src) })
                .toEqual({ ...green('n=1'), projection: 'parses' });
            expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        });
    }
});

// A `{` after any return type, `void` included, is a body: each keyword in it is lowered.
describe('a keyword in a function with a return type', () =>
{
    const GO = '<button onClick={ go }>go</button>';
    const ARMS: Record<string, { body: string; markup?: string; top?: string; want?: string }> = {
        fnBatch: { body: 'function go(): void { batch { n = n + 1; } }' },
        fnAllman: { body: 'function go(): void\n    {\n        batch { n = n + 1; }\n    }' },
        fnUntrack: { body: 'function go(): void { untrack { n = n + 1; } }' },
        fnState: { body: 'function go(): void { state s = 1; n = n + s; }' },
        fnDerived: { body: 'function go(): void { derived d = 1; n = n + d; }' },
        fnEffect: { body: 'function go(): void { effect { hook.effects++; } n = n + 1; }' },
        fnMount: { body: 'function go(): void { mount { hook.noop++; } n = n + 1; }' },
        fnExpr: { body: 'const go = function (): void { batch { n = n + 1; } };' },
        objMethod: { body: 'const api = { go(): void { batch { n = n + 1; } } };', markup: '<button onClick={ () => api.go() }>go</button>' },
        classMethod: { body: 'class K { go(): void { batch { n = n + 1; } } }', markup: '<button onClick={ () => new K().go() }>go</button>' },
        inEffectBody: { body: 'effect { function f(): void { untrack { hook.v = n; } } f(); }', markup: '<button onClick={ () => { n = n + 1; } }>go</button>' },
        postfixAsi: { body: 'function go(): void\n    {\n        hook.noop++\n        {\n            batch { n = n + 1; }\n        }\n    }' },
        numberReturn: { body: 'function go(): number { batch { n = n + 1; } return n; }' },
        voidArrow: { body: 'const go = (): void => { batch { n = n + 1; } };' },
        untyped: { body: 'function go() { batch { n = n + 1; } }' },
        moduleComposable: { body: '', top: 'function tick(): void { batch { hook.hits++; } }', markup: '<button onClick={ () => { tick(); n = n + 1; } }>go</button>', want: 'n=1 hits=1' }
    };
    for (const [name, a] of Object.entries(ARMS))
    {
        it(name, () =>
        {
            const src = `${ a.top ?? '' }\n${ mod(a.markup ?? GO, a.body) }`;
            const probe = (): string => (a.want === undefined ? byN() : `${ byN() } hits=${ hook.hits }`);
            expect({ ...lanes({ src, fire: click('button'), probe, html: '<button' }), projection: projection(src) })
                .toEqual({ ...green(a.want ?? 'n=1'), projection: 'parses' });
            expect(diagnoseModule(src).filter((d) => d.severity === 'error')).toEqual([]);
        });
    }

    it('a `[]` suffix in a void function is refused', () =>
    {
        const src = mod(GO, 'function go(): void { state open[] = true; }');
        expect(diagnoseModule(src).filter((d) => d.severity === 'error').map((d) => d.code)).toEqual(['azeroth/array-suffix']);
        expect(() => emit(src, true)).toThrow('azeroth/array-suffix');
        expect(() => emit(src, false)).toThrow('azeroth/array-suffix');
    });
});
