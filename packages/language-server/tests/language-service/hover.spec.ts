// @vitest-environment node
//
// AzerothJS authoring keywords (`component`, `state`, `derived`, `deferred`, `effect`, `watch`,
// and the reactive wrappers) compile away, so TypeScript has no symbol to describe them and
// hovering one returns nothing. The hover provider supplies their docs from language-data.
// These guard that keyword forms get docs while member accesses / calls fall through to TypeScript.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../../src/language-service/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const SOURCE = [
    'export default component Counter',          // 0  `component` at col 15
    '{',                                          // 1
    '    state count = 0 with { name: \'count\' };', // 2  `state` at col 4, `with` at col 20
    '    derived doubled = count() * 2;',         // 3  `derived` at col 4
    '    effect',                                 // 4  `effect` at col 4 (brace on next line)
    '    {',                                       // 5
    '        document.title = String(doubled());',// 6  `document` (a real global) at col 8
    '    }',                                       // 7
    '    <button onClick={() => count(count() + 1)}>{doubled()}</button>', // 8
    '}',                                          // 9
    ''
].join('\n');

const LIFECYCLE_SOURCE = [
    'export default component Widget',            // 0
    '{',                                           // 1
    '    state count = 0;',                        // 2
    '    mount',                                   // 3  `mount` at col 4 (brace on next line)
    '    {',                                        // 4
    '        console.log(\'connected\');',          // 5
    '    }',                                        // 6
    '    effect (count) (value, previous)',        // 7  the explicit-dependency form, `effect` at col 4
    '    {',                                        // 8
    '        console.log(previous, value);',       // 9
    '    }',                                        // 10
    '    <p>{count()}</p>',                        // 11
    '}',                                           // 12
    ''
].join('\n');

function lifecycleHoverAt(line: number, character: number): string | null
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'Widget.azeroth')).href;
    service.didOpen(uri, LIFECYCLE_SOURCE);
    const hover = service.getHover(uri, { line, character });
    return hover && typeof hover.contents === 'string' ? hover.contents : null;
}

function hoverAt(line: number, character: number): string | null
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'Counter.azeroth')).href;
    service.didOpen(uri, SOURCE);
    const hover = service.getHover(uri, { line, character });
    return hover && typeof hover.contents === 'string' ? hover.contents : null;
}

describe('hover: AzerothJS keywords', () =>
{
    it('documents `component`', () => expect(hoverAt(0, 17)).toContain('AzerothJS component'));
    it('documents `state`', () => expect(hoverAt(2, 6)).toContain('reactive state'));
    it('documents `derived`', () => expect(hoverAt(3, 6)).toContain('computed value'));
    it('documents `effect` even with the brace on the next line', () => expect(hoverAt(4, 6)).toContain('reactive side effect'));
    it('documents the `with` clause contextually for its owning keyword (state)', () => expect(hoverAt(2, 22)).toContain('`state` options'));
    it('lists a keyword\'s own `with` options in its hover (state -> equals)', () => expect(hoverAt(2, 6)).toContain('equals'));
    it('includes a `with` usage example in the keyword hover (state)', () => expect(hoverAt(2, 6)).toContain('termsAccepted'));
    it('omits the options section for a keyword that takes none (component)', () => expect(hoverAt(0, 17)).not.toContain('options'));

    it('does NOT treat a real symbol (`document`) as a keyword', () =>
    {
        // `document` is a DOM global, not an Azeroth keyword - hover must be TypeScript's, not a keyword doc.
        const contents = hoverAt(6, 10);
        expect(contents).not.toContain('AzerothJS component');
        expect(contents).not.toContain('reactive state');
    });

    it('documents `mount` (brace on the next line)', () => expect(lifecycleHoverAt(3, 6)).toContain('connected'));

    it('serves the explicit-dependency doc for `effect (deps)`, not the auto-tracked one', () =>
    {
        const contents = lifecycleHoverAt(7, 6);
        expect(contents).toContain('explicit');
        expect(contents).not.toContain('reactive side effect');
    });
});

describe('hover: a keyword, and a method or a value named like one', () =>
{
    const MEMBERS = [
        'export default component Members',
        '{',
        '    state n = 0;',
        '    const o = { effect(v: number) { return v + 1; } };',
        '    class K { effect(v: number) { return v + 1; } }',
        '    function go(): void { batch { n = n + o.effect(1) + new K().effect(1); } }',
        '    <b title={ String({ effect(v: number) { return v; } }.effect(1)) } onClick={ () => { untrack { go(); } } }>t</b>',
        '}',
        ''
    ].join('\n');
    const SHAPES = [
        'export default component Shapes',
        '{',
        '    state as = 1;',
        '    form login = { email: "" } with { onSubmit: { effect(v: unknown) { return v; } }.effect };',
        '    state s = 1 with { equals: { effect(a: number, b: number) { return a === b; } }.effect };',
        '    class Box<F extends () => { size: number }> { effect(v: number) { return v + 1; } }',
        '    <p title={ { effect(v: number) { return String(v); } }.effect(1) }>{ as + s }{ login.values.email }{ new Box().effect(1) }</p>',
        '}',
        ''
    ].join('\n');
    const AFTER_MARKUP = [
        'export default component AfterMarkup',
        '{',
        '    state n = 0;',
        '    <p>{ n }</p>',
        '    effect { console.log(n); }',
        '}',
        ''
    ].join('\n');
    const FORM_VALUE = [
        'export default component FormValue',
        '{',
        '    const form: unknown = new Map();',
        '    form as = { email: "" };',
        '    form instanceof Map && console.log(as.values().email);',
        '    <b>{ form instanceof Map ? as.values().email : "b" }</b>',
        '}',
        ''
    ].join('\n');
    const UNPARSED = [
        'export default component Unparsed',
        '{',
        '    form login = { email: "" };',
        '    const store: unknown = new Map();',
        '    const seen = store instanceof Map;',
        '    <p>{ login.values.email }</b>',
        '}',
        ''
    ].join('\n');
    const NESTED_FORM = [
        'export default component NestedForm',
        '{',
        '    form login = { email: "" };',
        '    function reset(): void { form draft = { email: "" }; console.log(draft); }',
        '    <p onClick={ reset }>{ login.values.email }</p>',
        '}',
        ''
    ].join('\n');
    const COMMENTED = [
        'export default component Commented',
        '{',
        '    state /* kept */ n = 0;',
        '    form // rows',
        '        as[];',
        '    <p>{ n }{ String(as.rows().length) }</p>',
        '}',
        ''
    ].join('\n');
    const RETURNED = [
        'export default component Returned',
        '{',
        '    state n = 0;',
        '    const row = () => <button onClick={ () => { batch { n = 1; } } }>go</button>;',
        '    <p>{ n }</p>',
        '}',
        ''
    ].join('\n');
    const MODULE_RETURNED = [
        'function row(go: () => void)',
        '{',
        '    return <button onClick={ () => { batch { go(); } } }>go</button>;',
        '}',
        'export default component ModuleReturned',
        '{',
        '    state n = 0;',
        '    <p>{ n }</p>',
        '}',
        ''
    ].join('\n');
    // The component's own markup, as its one root: text, then a hole.
    const rooted = (text: string, hole: string): string =>
        ['export default component Rooted', '{', '    state n = 0;', `    <p>${ text } { ${ hole } }</p>`, '}', ''].join('\n');
    const METHOD = '{ effect() { return n; } }.effect()';
    const KEYWORD = '(() => { batch { n = n + 1; } return n; })()';

    function hoverOn(line: number, word: string, source = MEMBERS): string | null
    {
        const service = new AzerothLanguageService(fixtures, tsconfig);
        const uri = pathToFileURL(path.join(fixtures, 'Members.azeroth')).href;
        service.didOpen(uri, source);
        const character = (source.split('\n')[line] as string).indexOf(word) + 1;
        const hover = service.getHover(uri, { line, character });
        return hover && typeof hover.contents === 'string' ? hover.contents : null;
    }

    it('an object method named `effect` is a method', () => expect(hoverOn(3, 'effect(')).not.toContain('explicit'));
    it('a class method named `effect` is a method', () => expect(hoverOn(4, 'effect(')).not.toContain('explicit'));
    it('an object method in a markup expression is a method', () => expect(hoverOn(6, 'effect(')).not.toContain('explicit'));
    it('describes the member through TypeScript', () => expect(hoverOn(3, 'effect(')).toContain('(method)'));
    it('documents `batch` in a function body', () => expect(hoverOn(5, 'batch')).toContain('batched writes'));
    it('documents `untrack` in a markup handler', () => expect(hoverOn(6, 'untrack')).toContain('read without tracking'));
    it('documents `state` before a name spelled like an operator word', () => expect(hoverOn(2, 'state', SHAPES)).toContain('reactive state'));
    it('a method in a form `with` option is a method', () => expect(hoverOn(3, 'effect(', SHAPES)).toContain('(method)'));
    it('a method in a state `with` option is not the keyword', () => expect(hoverOn(4, 'effect(', SHAPES) ?? '').not.toContain('explicit'));
    it('a method in a class whose type parameter holds a type literal is a method', () => expect(hoverOn(5, 'effect(', SHAPES)).toContain('(method)'));
    it('a method in an object that opens a markup expression is a method', () => expect(hoverOn(6, 'effect(', SHAPES)).toContain('(method)'));
    it('documents `form` before a name spelled like an operator word', () => expect(hoverOn(3, 'form', FORM_VALUE)).toContain('reactive form'));
    it('a value named `form` that starts a statement is a value', () => expect(hoverOn(4, 'form', FORM_VALUE)).toContain('const form'));
    it('a value named `form` in a markup expression is a value', () => expect(hoverOn(5, 'form', FORM_VALUE)).toContain('const form'));
    it('documents `form` in a module that does not parse', () => expect(hoverOn(2, 'form', UNPARSED)).toContain('reactive form'));
    it('documents `effect` right after the markup', () => expect(hoverOn(4, 'effect', AFTER_MARKUP)).toContain('reactive side effect'));
    it('a value named `store` in a module that does not parse is a value', () => expect(hoverOn(4, 'store', UNPARSED) ?? '').not.toContain('per-render store'));
    it('documents `state` before a comment and its name', () => expect(hoverOn(2, 'state', COMMENTED)).toContain('reactive state'));
    it('documents `form` before a bare array form named `as`', () => expect(hoverOn(3, 'form', COMMENTED)).toContain('reactive form'));
    it('a `form` in a function is no declaration of the component', () => expect(hoverOn(3, 'form', NESTED_FORM) ?? '').not.toContain('reactive form'));
    it('documents `batch` in markup a function of the body returns', () => expect(hoverOn(3, 'batch', RETURNED)).toContain('batched writes'));
    it('documents `batch` in markup a module function returns', () => expect(hoverOn(2, 'batch', MODULE_RETURNED)).toContain('batched writes'));

    // Markup text that opens with a parenthesized group and a colon, or an arrow, is text.
    for (const [name, text] of Object.entries({ groupAndColon: '(n):', groupAndArrow: '(a) => b', apostrophe: '(hint): don\'t wait', plainText: 'n:' }))
    {
        it(`a method in a hole after ${ name } is a method`, () => expect(hoverOn(3, 'effect(', rooted(text, METHOD))).toContain('(method)'));
        it(`documents \`batch\` in a hole after ${ name }`, () => expect(hoverOn(3, 'batch', rooted(text, KEYWORD))).toContain('batched writes'));
    }
    it('a method in an attribute beside such text is a method', () =>
        expect(hoverOn(3, 'effect(', rooted('(optional):', 'n').replace('<p>', `<p title={ String(${ METHOD }) }>`))).toContain('(method)'));
    it('a word in markup text is no keyword', () => expect(hoverOn(3, 'state', rooted('(n): a; state x = 1; b', 'n')) ?? '').not.toContain('reactive state'));
});

describe('hover: imported framework APIs carry their JSDoc', () =>
{
    // The orphaned-doc regression: createResource's house block once sat detached from its
    // function (an interface slid between them), so hovering the import showed NOTHING while
    // the types were fine. This pins the doc at the layer a user experiences it.
    const IMPORT_SOURCE = [
        "import { createResource } from 'azerothjs';",  // 0  `createResource` at col 9
        'export default component Loader',               // 1
        '{',                                             // 2
        "    resource user = fetch('/u').then((response) => response.json());", // 3
        '    <p>{user.loading() ? \'...\' : \'done\'}</p>', // 4
        '}',                                             // 5
        ''
    ].join('\n');

    it('hover on a symbol imported from azerothjs renders its documentation', () =>
    {
        const service = new AzerothLanguageService(fixtures, tsconfig);
        const uri = pathToFileURL(path.join(fixtures, 'Loader.azeroth')).href;
        service.didOpen(uri, IMPORT_SOURCE);
        const hover = service.getHover(uri, { line: 0, character: 12 });
        const contents = hover && typeof hover.contents === 'string' ? hover.contents : '';
        expect(contents).toContain('Wraps an async fetcher');
    });
});
