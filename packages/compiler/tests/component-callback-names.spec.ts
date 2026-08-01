// @vitest-environment node
//
// The name-preservation invariant for component callback props: a component attribute is a
// props-object KEY, so every backend (codegen, the editor projection) must emit it under its
// AUTHORED name - for every name the event classifier matches, not for any blessed list.
// Host elements are the contrast case: there `on*` denotes a DOM event TYPE, a lowercase
// value domain, and the lowering is intentionally lossy.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import { generateVirtualCode } from '../src/project.ts';

function gen(src: string): string
{
    return generateModule(src).code;
}

/** Callback names across the classifier's whole matched domain, not a curated happy path. */
const CALLBACK_NAMES = [
    'onA',
    'onAbc',
    'onAbcDef',
    'onABC',
    'onMarketResolved',
    'onX2Y',
    'onSelectAllRowsNow'
];

describe('component callback props preserve their authored name', () =>
{
    for (const name of CALLBACK_NAMES)
    {
        it(`codegen emits ${ name } verbatim`, () =>
        {
            const code = gen(`import Foo from "./Foo.azeroth"; component C { <Foo ${ name }={(v) => v} /> }`);
            expect(code).toContain(`get ${ name }()`);
            // No case-mangled sibling may exist: the ONLY on-capital key is the authored one.
            const emitted = [...code.matchAll(/get (on[A-Z][\w]*)\(/g)].map((match) => match[1]);
            expect(emitted).toEqual([name]);
        });

        it(`the projection types ${ name } under the same key codegen emits`, () =>
        {
            const projected = generateVirtualCode(`import Foo from "./Foo.azeroth"; component C { <Foo ${ name }={(v) => v} /> }`).code;
            const mangled = `on${ name[2] }${ name.slice(3).toLowerCase() }`;
            expect(projected).toContain(name);
            if (mangled !== name)
            {
                expect(projected).not.toContain(mangled);
            }
        });
    }

    it('a lowercase tail is NOT a callback: onclick on a component stays an ordinary prop', () =>
    {
        const code = gen('import Foo from "./Foo.azeroth"; component C { <Foo onclick={(v) => v} /> }');
        expect(code).toContain('onclick');
        expect(code).not.toContain('onClick');
    });

    it('a non-identifier callback name emits as a quoted accessor, never invalid JS', () =>
    {
        // The classifier admits any non-lowercase third char, '-' included.
        const code = gen('import Foo from "./Foo.azeroth"; component C { <Foo on-retry={(v) => v} /> }');
        expect(code).toContain("get 'on-retry'()");
    });

    it('spread and literal attributes agree: neither renames callback keys', () =>
    {
        const code = gen('import Foo from "./Foo.azeroth"; component C { const rest = {}; <Foo {...rest} onPickOne={(v) => v} /> }');
        expect(code).toContain('...');
        expect(code).toContain('get onPickOne()');
    });

    it('builtins take the same path: Dynamic receives authored callback names', () =>
    {
        const code = gen('component C { const view = () => null; <Dynamic component={view} onPickOne={(v) => v} /> }');
        expect(code).toContain('get onPickOne()');
    });
});

describe('duplicate props are a compile error, never a silent last-wins', () =>
{
    it('a repeated callback prop is rejected', () =>
    {
        expect(() => gen('import Foo from "./Foo.azeroth"; component C { <Foo onPick={(v) => 1} onPick={(v) => 2} /> }'))
            .toThrow(/Duplicate prop 'onPick'/);
    });

    it('a repeated plain prop is rejected', () =>
    {
        expect(() => gen('import Foo from "./Foo.azeroth"; component C { <Foo value={1} value={2} /> }'))
            .toThrow(/Duplicate prop 'value'/);
    });

    it('bind:value plus an explicit value prop collide on the same emitted key', () =>
    {
        expect(() => gen('import Field from "./Field.azeroth"; component C { state x = ""; <Field bind:value={x} value={1} /> }'))
            .toThrow(/Duplicate prop 'value'/);
    });

    it('a static prop under the write-back callback key collides with bind:', () =>
    {
        expect(() => gen('import Field from "./Field.azeroth"; component C { state x = ""; <Field bind:value={x} onInput="nope" /> }'))
            .toThrow(/Duplicate prop 'onInput'/);
    });

    it('ONE authored handler composes with bind: (exempt); a second one is rejected', () =>
    {
        expect(() => gen('import Field from "./Field.azeroth"; component C { state x = ""; <Field bind:value={x} onInput={(v) => 1} /> }'))
            .not.toThrow();
        expect(() => gen('import Field from "./Field.azeroth"; component C { state x = ""; <Field bind:value={x} onInput={(v) => 1} onInput={(v) => 2} /> }'))
            .toThrow(/Duplicate prop 'onInput'/);
    });
});

describe('host elements reject duplicate attributes (render modes disagree on the winner)', () =>
{
    it('a repeated handler is rejected - template mode fires both, h-mode fires the last', () =>
    {
        expect(() => gen('component C { <button onClick={() => 1} onClick={() => 2}>x</button> }'))
            .toThrow(/Duplicate attribute 'onClick'/);
    });

    it('a repeated static attribute is rejected - the HTML parser keeps the first, h-mode the last', () =>
    {
        expect(() => gen('component C { <div class="a" class="b">x</div> }'))
            .toThrow(/Duplicate attribute 'class'/);
    });

    it('a repeated bind: is rejected', () =>
    {
        expect(() => gen('component C { state v = ""; <input bind:value={v} bind:value={v} /> }'))
            .toThrow(/Duplicate attribute 'bind:value'/);
    });

    it('class + class:active are DIFFERENT names and stay legal (the merge is the feature)', () =>
    {
        expect(() => gen('component C { state on = false; <div class="base" class:active={on}>x</div> }'))
            .not.toThrow();
    });
});

describe('markup children and an explicit children= prop collide', () =>
{
    it('both at once is rejected', () =>
    {
        expect(() => gen('import Foo from "./Foo.azeroth"; component C { <Foo children={1}><p>markup</p></Foo> }'))
            .toThrow(/Duplicate prop 'children'/);
    });

    it('an explicit children= prop alone is legal', () =>
    {
        expect(() => gen('import Foo from "./Foo.azeroth"; component C { <Foo children={1} /> }'))
            .not.toThrow();
    });
});

describe('host attribute merge is ONE rule in every mode: source order, later wins', () =>
{
    it('a static AFTER a spread beats it - and no longer bakes into the template', () =>
    {
        const code = gen('component C { state p = {}; <div {...p} title="a">x</div> }');
        expect(code).toMatch(/tmpl\('<div>x<\/div>'\)/);
        const object = code.slice(code.indexOf('bindProps'));
        expect(object.indexOf('...')).toBeLessThan(object.indexOf("title: 'a'"));
    });

    it('a static BEFORE a spread stays template-baked and the spread wins', () =>
    {
        const code = gen('component C { state p = {}; <div title="a" {...p}>x</div> }');
        expect(code).toMatch(/tmpl\('<div title="a">x<\/div>'\)/);
        expect(code).toContain('bindProps');
    });

    it('a dynamic attr after a spread also follows source order', () =>
    {
        const code = gen('component C { state p = {}; state t = "b"; <div {...p} title={t}>x</div> }');
        const object = code.slice(code.indexOf('bindProps'));
        expect(object.indexOf('...')).toBeLessThan(object.indexOf('title:'));
    });

    it('class:/style: directives CLAIM their key - a spread never outranks the merge', () =>
    {
        const code = gen('component C { state p = {}; state on = false; <div class="base" class:active={on} {...p}>x</div> }');
        const object = code.slice(code.indexOf('bindProps'));
        expect(object.indexOf('...')).toBeLessThan(object.indexOf('class:'));
    });
});

describe('spread merge order follows source order (JS object semantics)', () =>
{
    it('a spread AFTER bind: lands after the bind pair, so its keys can override at runtime', () =>
    {
        const code = gen('import Field from "./Field.azeroth"; component C { state x = ""; const rest = {}; <Field bind:value={x} {...rest} /> }');
        expect(code.indexOf('get onInput()')).toBeLessThan(code.indexOf('...rest'));
    });

    it('a spread BEFORE bind: lands before it, so the bind pair wins', () =>
    {
        const code = gen('import Field from "./Field.azeroth"; component C { state x = ""; const rest = {}; <Field {...rest} bind:value={x} /> }');
        expect(code.indexOf('...rest')).toBeLessThan(code.indexOf('get onInput()'));
    });
});

describe('host elements keep the DOM event domain (the intentionally lossy side)', () =>
{
    it('onClick on an element lowers to the lowercase event TYPE, not a props key', () =>
    {
        const code = gen('component C { <button onClick={() => 1} /> }');
        expect(code).toContain("'click'");
        expect(code).not.toContain('get onClick()');
    });

    it('a camelCase custom-element event is lowercased today - the documented DOM-side limit', () =>
    {
        // CustomEvent types ARE case-sensitive; this pins the current (lossy) behavior so a
        // future fix for custom elements changes this test deliberately, not accidentally.
        const code = gen('component C { <my-widget onValueChange={() => 1} /> }');
        expect(code).toContain("'valuechange'");
    });
});
