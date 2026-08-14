// @vitest-environment happy-dom
//
// The `style { ... }` section, end to end.
//
// The section's whole justification is that ONE name is rewritten on BOTH sides - the `.card`
// in the CSS and the `class="card"` in the markup - so every assertion here compares the two
// rather than checking either alone. A test that only asserted "the class has a suffix" would
// pass against a compiler that suffixed it differently from the stylesheet, which is precisely
// the failure mode: the markup looks right, the rules exist, and the page paints unstyled.
//
// The scoped names are never hard-coded. A content hash is not a fact a test may assert; what
// must hold is that the class in the document and the selector in the delivered CSS AGREE.
import { describe, it, expect } from 'vitest';
import * as runtime from 'azerothjs/internal';
import { render, renderToString, hydrate, collectStyleSheet, resetStyleSheet, css, For, Show } from 'azerothjs';

import { generateModule } from '../src/codegen.ts';
import { generateVirtualCode } from '../src/project.ts';
import { diagnoseModule } from '../src/diagnostics.ts';
import { parseModule } from '../src/parser.ts';
import { styleScopeOf } from '../src/style-section.ts';

/**
 * Compiles a `.azeroth` source and EXECUTES its module body against the real runtime, returning
 * the default export. Executing the module (not just reading its text) is what puts the
 * `registerStyle(...)` call through the same path a real import would.
 */
function compile(source: string): (props?: Record<string, unknown>) => unknown
{
    const body = generateModule(source, 'T.azeroth').code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const name = (/^function\s+(\w+)/m.exec(body) as RegExpExecArray)[1] as string;

    const extras = { For, Show };
    const keys = [...Object.keys(runtime), ...Object.keys(extras)];
    const values: Record<string, unknown> = { ...(runtime as unknown as Record<string, unknown>), ...extras };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the compiler's own output IS the point; a string assertion cannot tell a styled page from a well-spelled one
    const factory = new Function(...keys, `${ body }\nreturn ${ name };`) as (...args: unknown[]) => (props?: Record<string, unknown>) => unknown;
    return factory(...keys.map((key) => values[key]));
}

/** The scoped name the compiler assigned to `base`, read from the compiler's own resolution. */
function scopedName(source: string, base: string): string
{
    const scope = styleScopeOf(source, parseModule(source));
    const name = scope?.classes[base];
    expect(name, `the section defines no class '${ base }'`).toBeDefined();
    return name as string;
}

const SIGN_IN = `style
{
    .form { display: grid; gap: 1rem; }
    .field-error { color: rgb(200, 0, 0); }
    div { margin: 0; }
}

export default component SignInForm()
{
    state bad = true;
    <form class="form wide">
        <span class="field-error" class:field-error={ bad }>oops</span>
    </form>
}`;

describe('parsing the style section', () =>
{
    it('is a module item, with the CSS as its body', () =>
    {
        const items = parseModule(SIGN_IN).items;
        const section = items.find((item) => item.kind === 'style');

        expect(section).toBeDefined();
        expect(SIGN_IN.slice(section!.bodyStart, section!.bodyEnd)).toContain('.field-error');
        expect(section!.unterminated).toBe(false);
    });

    it('is recognised in both brace styles', () =>
    {
        for (const source of ['style { .a { color: red } }', 'style\n{\n    .a { color: red }\n}'])
        {
            expect(parseModule(source).items.some((item) => item.kind === 'style'), source).toBe(true);
        }
    });

    it('a brace inside a CSS string, a comment or url() does not end it', () =>
    {
        // Each of these closes the section EARLY under a naive brace count, leaving the
        // component below it inside the stylesheet - it would simply vanish from the module.
        const source = `style
{
    .a { content: "}"; }
    .b { content: '{'; }
    /* } */
    .c { background: url(a}b.png); }
}

component Late { <p>here</p> }`;
        const items = parseModule(source).items;

        expect(items.filter((item) => item.kind === 'style')).toHaveLength(1);
        expect(items.some((item) => item.kind === 'component' && item.name === 'Late')).toBe(true);
    });

    it('CSS the JS scanner would mis-tokenize passes through whole', () =>
    {
        // `url(//...)` reads as a line comment to the JS scanner (swallowing the rest of the
        // line, closing brace included), and the `/` in `calc(100%/3)` opens a regex that runs
        // to the next slash. Both are ordinary CSS.
        const source = `style
{
    .a { background: url(//cdn.example.com/x.png); width: calc(100%/3); }
}

component Late { <p>here</p> }`;
        const items = parseModule(source).items;

        expect(items.filter((item) => item.kind === 'style')).toHaveLength(1);
        expect(items.some((item) => item.kind === 'component' && item.name === 'Late')).toBe(true);
    });

    it('an unterminated section is CARRIED, not thrown (the parser stays total)', () =>
    {
        const items = parseModule('style {\n    .a { color: red }\n').items;
        const section = items.find((item) => item.kind === 'style');

        expect(section?.unterminated).toBe(true);
    });

    it('`style` stays an ordinary identifier', () =>
    {
        const sources = [
            'const style = { color: 1 };',
            'export const style = 1;\nexport function use() { return style; }',
            'component C { <p style="color: red">x</p> }',
            'component C { const el = ref.current; el.style.width = "1px"; <p>x</p> }',
            'type T = { style: { color: string } };'
        ];
        for (const source of sources)
        {
            expect(parseModule(source).items.some((item) => item.kind === 'style'), source).toBe(false);
        }
    });
});

describe('compiling the style section', () =>
{
    const compiled = generateModule(SIGN_IN, 'SignInForm.azeroth').code;

    it('registers the section\'s RAW text, so the runtime derives the same scope', () =>
    {
        // Emitting PRE-SCOPED text would make the runtime scope it a second time
        // (`.form_a1_b2`) - every class in the markup would then name a rule that does not
        // exist, and nothing in the output would look wrong.
        expect(compiled).toContain('registerStyle(');
        expect(compiled).toContain('.form { display: grid; gap: 1rem; }');
        expect(compiled).not.toContain(`.${ scopedName(SIGN_IN, 'form') } {`);
    });

    it('rewrites a static class, per token, leaving unknown tokens alone', () =>
    {
        // `wide` is not in the section: a utility or global class, and rewriting it would
        // break every stylesheet the compiler cannot see.
        expect(compiled).toContain(`class="${ scopedName(SIGN_IN, 'form') } wide"`);
    });

    it('rewrites a `class:name` directive to the same scoped name', () =>
    {
        const scoped = scopedName(SIGN_IN, 'field-error');
        expect(compiled).toContain(`'${ scoped }'`);
        expect(compiled).not.toContain('\'field-error\'');
    });

    it('the same rule text in two modules gets the same scope (content hash, no file identity)', () =>
    {
        const rules = 'style { .btn { color: red } }\n';
        const a = styleScopeOf(`${ rules }component A { <b class="btn">a</b> }`, parseModule(`${ rules }component A { <b class="btn">a</b> }`));
        const b = styleScopeOf(`${ rules }component B { <i class="btn">b</i> }`, parseModule(`${ rules }component B { <i class="btn">b</i> }`));

        expect(a?.classes.btn).toBe(b?.classes.btn);
    });

    it('a module with no section is byte-identical to before (no registration, no rewrite)', () =>
    {
        const source = 'export default component C { <p class="plain">x</p> }';
        const code = generateModule(source, 'C.azeroth').code;

        expect(code).toContain('class="plain"');
        expect(code).not.toContain('registerStyle');
    });

    it('an empty section registers nothing (an empty scope in every collected document)', () =>
    {
        expect(generateModule('style { }\ncomponent C { <p>x</p> }', 'C.azeroth').code).not.toContain('registerStyle');
    });

    it('a section styles every component in the module, wherever it sits', () =>
    {
        const source = `component First { <p class="tag">1</p> }

style { .tag { color: red } }

component Second { <p class="tag">2</p> }`;
        const scoped = scopedName(source, 'tag');
        const code = generateModule(source, 'M.azeroth').code;

        expect(code.match(new RegExp(`class="${ scoped }"`, 'g'))).toHaveLength(2);
    });

    it('markup inside an expression is rewritten too (the raw-mode path)', () =>
    {
        // Three markup positions that reach three different emitters: a component's markup
        // CHILDREN, an attribute expression (`fallback=`), and a hole. Only the first goes
        // through the component lowering, so a fix threaded into that one alone leaves the
        // other two emitting the bare class - the element looks styled and is not.
        const source = `style { .row { color: red } }

export default component L()
{
    state on = true;
    <ul>
        <Show when={ on } fallback={<li class="row">none</li>}><li class="row">one</li></Show>
        { on ? <li class="row">tern</li> : null }
    </ul>
}`;
        const scoped = scopedName(source, 'row');
        const code = generateModule(source, 'L.azeroth').code;

        // The emitters quote differently (a baked template attribute vs an h() prop), so an
        // assertion on one spelling would pass while the other shipped unscoped.
        expect(code).not.toContain('class: \'row\'');
        expect(code).not.toContain('class="row"');
        expect(code.match(new RegExp(scoped, 'g'))?.length).toBeGreaterThanOrEqual(3);
    });

    it('a static class handed to a COMPONENT is scoped (the child puts it on an element)', () =>
    {
        const source = `import Card from './Card.azeroth';

style { .panel { padding: 1rem } }

export default component C() { <Card class="panel" /> }`;
        const code = generateModule(source, 'C.azeroth').code;

        expect(code).toContain(scopedName(source, 'panel'));
        expect(code).not.toContain('class: \'panel\'');
    });
});

describe('the projection hands TypeScript no CSS', () =>
{
    it('drops the section, so nothing inside it is mapped', () =>
    {
        const virtual = generateVirtualCode(SIGN_IN);

        // Before the section existed, this exact text reached the virtual TS verbatim and
        // TypeScript reported `Cannot find name 'red'` about the author's own stylesheet.
        expect(virtual.code).not.toContain('display: grid');
        expect(virtual.code).not.toContain('rgb(200, 0, 0)');
        expect(virtual.code).toContain('function SignInForm');
    });

    it('no offset in the section maps into the virtual module', () =>
    {
        // The unmapped region is what buys the whole tool chain: every consumer's rule for
        // "no mapping" is already "drop it", so formatting, ESLint, the ts-plugin, navigation,
        // diagnostics, inlay hints and code lens are all correct here without knowing the
        // section exists. One mapped byte and TypeScript starts reporting on CSS again.
        const section = parseModule(SIGN_IN).items.find((item) => item.kind === 'style')!;
        const { mapping } = generateVirtualCode(SIGN_IN);

        for (let offset = section.start; offset < section.end; offset++)
        {
            expect(mapping.toGenerated(offset), `offset ${ offset } of the style section is mapped`).toBeNull();
        }
    });

    it('projects the UNSCOPED class, so the author sees the name they wrote', () =>
    {
        // The projection is what hover, rename and navigation read. Showing `form_1a2b3c`
        // there would surface a compiler-internal name the author never typed.
        expect(generateVirtualCode(SIGN_IN).code).toContain('class: \'form wide\'');
    });
});

describe('style-section diagnostics', () =>
{
    const codes = (source: string): string[] => diagnoseModule(source).map((d) => d.code);

    it('a well-formed module reports nothing', () =>
    {
        expect(diagnoseModule(SIGN_IN)).toEqual([]);
    });

    it('rejects a second section (a class in two of them has no single scope)', () =>
    {
        const source = 'style { .a { color: red } }\nstyle { .b { color: blue } }\ncomponent C { <p class="a">x</p> }';
        const found = diagnoseModule(source).filter((d) => d.code === 'azeroth/style-section');

        expect(found).toHaveLength(1);
        expect(found[0]?.severity).toBe('error');
        expect(found[0]?.message).toMatch(/ONE `style` section/);
    });

    it('rejects an unterminated section (it swallows every component below it)', () =>
    {
        const found = diagnoseModule('style {\n    .a { color: red }\ncomponent C { <p>x</p> }')
            .filter((d) => d.code === 'azeroth/style-section');

        expect(found[0]?.message).toMatch(/never closed/);
    });

    it('rejects a section inside a component body, and says where it belongs', () =>
    {
        const found = diagnoseModule('component C {\n    style { .a { color: red } }\n    <p class="a">x</p>\n}')
            .filter((d) => d.code === 'azeroth/style-section');

        expect(found).toHaveLength(1);
        expect(found[0]?.message).toMatch(/module SECTION/);
    });

    it('rejects a section the parser could not see, rather than letting CSS reach TypeScript', () =>
    {
        // No `;` after the previous statement, so `style` is not at a statement start and the
        // whole block stays opaque TypeScript. Silence here is the bad outcome: the author gets
        // `Cannot find name 'red'` and no explanation.
        const found = diagnoseModule('const x = 1\nstyle { .a { color: red } }\ncomponent C { <p class="a">x</p> }')
            .filter((d) => d.code === 'azeroth/style-section');

        expect(found).toHaveLength(1);
        expect(found[0]?.message).toMatch(/statement may begin/);
    });

    it('says nothing about ordinary uses of the word `style`', () =>
    {
        const sources = [
            'component C { <p style="color: red">x</p> }',
            'const style = { a: 1 };\ncomponent C { <p>{ style.a }</p> }',
            'component C { effect { el.style.width = "1px"; } <p>x</p> }',
            'interface P { style: { color: string } }\ncomponent C(props: P) { <p>x</p> }'
        ];
        for (const source of sources)
        {
            expect(codes(source), source).not.toContain('azeroth/style-section');
        }
    });

    it('reads the CSS as CSS - no markup or TypeScript rule fires inside it', () =>
    {
        // `@media (width < 40rem)`, a `component` in a comment, and an `onclick` in a selector
        // are all things the markup and TypeScript rules would flag if they saw them.
        const source = `style
{
    @media (width < 40rem) { .a { color: red } }
    /* component Fake { } */
    [onclick] { color: blue }
}

component C { <p class="a">x</p> }`;

        expect(diagnoseModule(source)).toEqual([]);
    });
});

describe('the compiled component and its stylesheet agree', () =>
{
    it('the class in the DOM names a rule the runtime actually registered', () =>
    {
        resetStyleSheet();
        const C = compile(SIGN_IN);

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => C() as HTMLElement, container);

        const form = container.querySelector('form') as HTMLElement;
        const classes = form.getAttribute('class')?.split(/\s+/) ?? [];
        const scoped = classes.find((name) => name.startsWith('form_')) as string;

        expect(scoped).toBeDefined();
        expect(classes).toContain('wide');
        // The whole point: the delivered stylesheet defines the class the element carries.
        expect(collectStyleSheet()).toContain(`.${ scoped } {`);
    });

    it('server and client produce the SAME class names', () =>
    {
        // A scope derived from anything but the rule text (a filename, a counter) would differ
        // between the two, and hydration overwrites `class` without comparing - so the page
        // would render unstyled with nothing to see in a diff.
        resetStyleSheet();
        const C = compile(SIGN_IN);

        const html = renderToString(() => C() as HTMLElement);
        const served = /class="([^"]*)"/.exec(html)?.[1] as string;

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => C() as HTMLElement, container);
        const client = (container.querySelector('form') as HTMLElement).getAttribute('class');

        expect(served).toBe(client);
    });

    it('hydration adopts the server\'s markup and keeps the class', () =>
    {
        resetStyleSheet();
        const C = compile(SIGN_IN);

        const html = renderToString(() => C() as HTMLElement);
        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);
        const before = (container.querySelector('form') as HTMLElement).getAttribute('class');

        hydrate(() => C() as HTMLElement, container);
        const after = (container.querySelector('form') as HTMLElement).getAttribute('class');

        expect(after).toBe(before);
        // The stylesheet is head content: a <style> adopted INTO the container would be an
        // extra node the hydration cursor cannot account for.
        expect(container.querySelector('style')).toBeNull();
    });

    it('a `class:` toggle flips between the SCOPED name and nothing', () =>
    {
        resetStyleSheet();
        const source = `style { .on { color: rgb(0, 128, 0) } }

export default component T(props: { flag: () => boolean })
{
    <p class:on={ props.flag() }>x</p>
}`;
        const C = compile(source);
        const scoped = scopedName(source, 'on');

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => C({ flag: () => true }) as HTMLElement, container);

        expect((container.querySelector('p') as HTMLElement).getAttribute('class')).toBe(scoped);
        expect(collectStyleSheet()).toContain(`.${ scoped }`);
    });

    it('the section and an equivalent css`` template resolve to one scope', () =>
    {
        // Two implementations of the hash or the selector rewrite would drift apart here, and
        // the drift is invisible: both sides keep working, they simply stop being the same class.
        const rules = '.solo { color: rgb(3, 3, 3); }';
        const fromTemplate = css(rules).solo;
        const fromSection = scopedName(`style { ${ rules } }\ncomponent C { <p class="solo">x</p> }`, 'solo');

        expect(fromSection).toBe(fromTemplate);
    });
});

describe('what the section deliberately does NOT rewrite', () =>
{
    it('a `class={expr}` value is left alone, even when it is a literal', () =>
    {
        // The rule is syntactic, not value-based: quotes are scoped, braces are TypeScript.
        // A half-rule ("scope it when the expression happens to be a string literal") would be
        // impossible to predict from the source.
        const source = `style { .box { color: red } }

export default component C()
{
    <p class={ 'box' }>x</p>
}`;
        const code = generateModule(source, 'C.azeroth').code;

        expect(code).toContain('\'box\'');
        expect(code).not.toContain(scopedName(source, 'box'));
    });

    it('a classList({ ... }) key is left alone', () =>
    {
        const source = `style { .box { color: red } }

export default component C()
{
    state on = true;
    <p class={ classList({ box: on }) }>x</p>
}`;
        const code = generateModule(source, 'C.azeroth').code;

        expect(code).toContain('box: ');
        expect(code).not.toContain(scopedName(source, 'box'));
    });

    it('element, id and attribute selectors stay global', () =>
    {
        resetStyleSheet();
        compile(SIGN_IN);

        // `div { margin: 0 }` in the section applies page-wide, exactly as it reads.
        expect(collectStyleSheet()).toContain('div { margin: 0; }');
    });

    it('CSS carrying `</style>` cannot break out of the served stylesheet', () =>
    {
        resetStyleSheet();
        compile(`style { .x { content: "</style><script>alert(1)</script>" } }

export default component C() { <p class="x">x</p> }`);

        const sheet = collectStyleSheet();
        expect(sheet).not.toContain('</style>');
        expect(sheet).toContain('\\3c');
    });
});

describe('scoping constructs through the real pipeline', () =>
{
    // Each case compiles and EXECUTES a module, then reads the delivered stylesheet back from
    // the runtime registry - the same text a server response or an adopted sheet carries. The
    // rewrite is char-level and position-independent, so most of these work by construction;
    // these specs exist because "by construction" is a claim, not evidence, and because each
    // pins the EXACT delivered spelling a regression would corrupt.

    /** Compiles + executes a one-section module and returns { sheet, scoped } for assertions. */
    function deliver(cssBody: string, markup = '<p class="probe">x</p>'): { sheet: string; name: (base: string) => string }
    {
        resetStyleSheet();
        const source = `style {\n${ cssBody }\n}\n\nexport default component S() { ${ markup } }`;
        compile(source);
        return { sheet: collectStyleSheet(), name: (base: string) => scopedName(source, base) };
    }

    it('descendant selectors: every class in the chain is scoped, combinators intact', () =>
    {
        const { sheet, name } = deliver('.list .item > .label { color: red }');

        expect(sheet).toContain(`.${ name('list') } .${ name('item') } > .${ name('label') } { color: red }`);
    });

    it('attribute selectors stay global, beside a scoped class in one selector list', () =>
    {
        const { sheet, name } = deliver('[data-open] { color: red }\n.row[data-open] { color: blue }');

        expect(sheet).toContain('[data-open] { color: red }');
        expect(sheet).toContain(`.${ name('row') }[data-open] { color: blue }`);
    });

    it('CSS nesting: nested class rules and `&` both survive, nested classes scoped', () =>
    {
        const { sheet, name } = deliver('.card { color: red; .inner { color: blue } &:hover { color: green } }');

        expect(sheet).toContain(`.${ name('card') } {`);
        expect(sheet).toContain(`.${ name('inner') } { color: blue }`);
        expect(sheet).toContain('&:hover { color: green }');
    });

    it('pseudo-elements: the class is scoped, the pseudo-element and its content string are not', () =>
    {
        // `content: ".done"` is the adversarial half: a dotted token inside a string that a
        // sloppier rewrite would corrupt into a scoped name.
        const { sheet, name } = deliver('.btn::before { content: ".done" }');

        expect(sheet).toContain(`.${ name('btn') }::before { content: ".done" }`);
    });

    it('@supports: the query passes through verbatim, the classes inside are scoped', () =>
    {
        const { sheet, name } = deliver('@supports (display: grid) { .g { display: grid } }');

        expect(sheet).toContain('@supports (display: grid) {');
        expect(sheet).toContain(`.${ name('g') } { display: grid }`);
    });

    it('@layer: layer names stay global, classes inside a layer block are scoped', () =>
    {
        const { sheet, name } = deliver('@layer base, overrides;\n@layer base { .l { color: red } }');

        expect(sheet).toContain('@layer base, overrides;');
        expect(sheet).toContain(`.${ name('l') } { color: red }`);
        expect(sheet).not.toContain('base_');
    });

    it('@keyframes: the animation name is GLOBAL - never rewritten in the declaration or the reference', () =>
    {
        // Only `.class` selectors scope. A keyframes name is an ident, so declaration and
        // reference stay untouched and therefore always agree - which also means the name is
        // shared app-wide (see the collision pin below).
        const { sheet, name } = deliver('.spin { animation: spin 1s linear infinite }\n@keyframes spin { from { opacity: 0 } to { opacity: 1 } }');

        expect(sheet).toContain(`.${ name('spin') } { animation: spin 1s linear infinite }`);
        expect(sheet).toContain('@keyframes spin { from { opacity: 0 } to { opacity: 1 } }');
        expect(sheet).not.toContain('@keyframes spin_');
        expect(sheet).not.toContain('animation: spin_');
    });

    it('two modules defining the same @keyframes name COLLIDE - the documented global semantics', () =>
    {
        // The pinned behavior, not a defect: keyframe names live in one global namespace, both
        // definitions are delivered, and the CSS cascade's last-wins rule decides. A component
        // that needs a private animation prefixes the name itself. This spec exists so the
        // semantics can never change silently.
        resetStyleSheet();
        compile('style { .a { animation: pulse 1s } @keyframes pulse { from { opacity: 0 } } }\ncomponent A { <p class="a">a</p> }');
        compile('style { .b { animation: pulse 2s } @keyframes pulse { from { opacity: 1 } } }\ncomponent B { <p class="b">b</p> }');

        const sheet = collectStyleSheet();
        expect(sheet.match(/@keyframes pulse /g)).toHaveLength(2);
        expect(sheet).toContain('@keyframes pulse { from { opacity: 0 } }');
        expect(sheet).toContain('@keyframes pulse { from { opacity: 1 } }');
    });
});
