// Offset-fixture tests for context-aware completion: each case opens a small
// document, places the caret at a position found by searching the source, and
// asserts the vocabulary offered there - component props, DOM events, HTML
// attributes, TS expression members, css`` properties, and the scaffold
// snippets. Plus a focused mapping round-trip suite, since every TS-backed
// answer depends on the offset mapping being exact.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    AzerothLanguageService,
    LineIndex,
    CompletionItemKind,
    generateVirtualCode,
    pathToUri,
    registerCompletionSource,
    clearCompletionSources,
    type Position,
    type CompletionSource
} from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

/** A position located by searching the source for `needle`. */
function at(source: string, needle: string, offsetInNeedle = 0): Position
{
    return new LineIndex(source).positionAt(source.indexOf(needle) + offsetInNeedle);
}

let ls: AzerothLanguageService;

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
});

function open(name: string, source: string): string
{
    const uri = pathToUri(path.join(ROOT, name));
    ls.didOpen(uri, source);
    return uri;
}

describe('completion by caret context', () =>
{
    it('offers camelCase DOM event handlers in host attribute position', () =>
    {
        const src = 'const x = <button >click</button>;';
        const uri = open('Events.azeroth', src);

        const items = ls.getCompletions(uri, at(src, '<button >', '<button '.length));
        const onClick = items.find(i => i.label === 'onClick');

        expect(onClick).toBeTruthy();
        expect(onClick!.insertText).toBe('onClick={$0}');
        // The lowercase HTML form must not appear alongside it.
        expect(items.some(i => i.label === 'onclick')).toBe(false);
    });

    it('offers HTML attributes with documentation on a host element', () =>
    {
        const src = 'const x = <input />;';
        const uri = open('Attrs.azeroth', src);

        const labels = ls.getCompletions(uri, at(src, '<input />', '<input '.length)).map(i => i.label);

        expect(labels).toContain('placeholder');
        expect(labels).toContain('type');
    });

    it('offers a component\'s typed props with ={...} snippet inserts', () =>
    {
        const src = [
            'function Card(props: { title: string; body: string })',
            '{',
            '    return <div>{props.title}</div>;',
            '}',
            'const x = <Card />;'
        ].join('\n');
        const uri = open('Props.azeroth', src);

        const items = ls.getCompletions(uri, at(src, '<Card />', '<Card '.length));
        const title = items.find(i => i.label === 'title');
        const body = items.find(i => i.label === 'body');

        expect(title).toBeTruthy();
        expect(body).toBeTruthy();
        expect(title!.insertText).toBe('title={$0}');
        expect(title!.insertTextFormat).toBe(2);
    });

    it('carries commit characters on typed props, and preselects an exact-prefix match', () =>
    {
        // `=`/space accept the highlighted prop and continue the edit; with `ti`
        // typed only `title` matches, so it is the clear winner to pre-select.
        const src = [
            'function Card(props: { title: string; body: string })',
            '{',
            '    return <div>{props.title}</div>;',
            '}',
            'const x = <Card ti />;'
        ].join('\n');
        const uri = open('PropCommit.azeroth', src);

        const items = ls.getCompletions(uri, at(src, '<Card ti', '<Card ti'.length));
        const title = items.find(i => i.label === 'title');

        expect(title).toBeTruthy();
        expect(title!.commitCharacters).toContain('=');
        expect(title!.commitCharacters).toContain(' ');
        expect(title!.preselect).toBe(true);
        // `body` does not match the `ti` prefix, so it stays unselected.
        expect(items.find(i => i.label === 'body')!.preselect).toBeUndefined();
    });

    it('offers a getter-backed prop, not just plain field props', () =>
    {
        // An interface getter compiles to a get-accessor member, so the prop
        // filter must accept accessor kinds alongside plain fields. The leading
        // `id` attribute forces the props-object completion path (not the
        // empty-call signature path) where that filter runs.
        const src = [
            'interface CardProps',
            '{',
            '    readonly id: string;',
            '    get label(): string;',
            '}',
            'function Card(props: CardProps)',
            '{',
            '    return <div>{props.label}</div>;',
            '}',
            'const x = <Card id="a" />;'
        ].join('\n');
        const uri = open('AccessorProps.azeroth', src);

        const items = ls.getCompletions(uri, at(src, 'id="a" ', 'id="a" '.length));
        const label = items.find(i => i.label === 'label');

        expect(label).toBeTruthy();
        expect(label!.insertText).toBe('label={$0}');
    });

    it('offers in-scope signals inside an expression hole', () =>
    {
        const src = [
            "import { createSignal } from '@azerothjs/core';",
            'export default function View()',
            '{',
            '    const [count, setCount] = createSignal(0);',
            '    return <p>{c}</p>;',
            '}'
        ].join('\n');
        const uri = open('Hole.azeroth', src);

        const labels = ls.getCompletions(uri, at(src, '{c}', '{c'.length)).map(i => i.label);

        expect(labels).toContain('count');
        expect(labels).toContain('setCount');
    });

    it('offers member completion on a store object inside a hole', () =>
    {
        const src = [
            "const store = { user: () => 'me', logout: () => undefined };",
            'const x = <p>{store.}</p>;'
        ].join('\n');
        const uri = open('Store.azeroth', src);

        const labels = ls.getCompletions(uri, at(src, '{store.}', '{store.'.length)).map(i => i.label);

        expect(labels).toContain('user');
        expect(labels).toContain('logout');
    });

    it('offers CSS properties inside a css`` template', () =>
    {
        const src = [
            "import { css } from '@azerothjs/core';",
            'const s = css`.card { padd }`;'
        ].join('\n');
        const uri = open('Css.azeroth', src);

        const labels = ls.getCompletions(uri, at(src, 'padd }', 'padd'.length)).map(i => i.label);

        expect(labels).toContain('padding');
        // TS identifiers must not bleed into the stylesheet context.
        expect(labels).toContain('padding-left');
    });

    it('hovers CSS properties inside a css`` template', () =>
    {
        const src = [
            "import { css } from '@azerothjs/core';",
            'const s = css`.card { padding: 1rem; }`;'
        ].join('\n');
        const uri = open('CssHover.azeroth', src);

        const hover = ls.getHover(uri, at(src, 'padding', 2));

        expect(hover).not.toBeNull();
        expect(hover!.contents.toLowerCase()).toContain('padding');
    });

    it('offers the component and signal scaffolds in script position', () =>
    {
        const src = 'const a = 1;\n';
        const uri = open('Scaffold.azeroth', src);

        const items = ls.getCompletions(uri, new LineIndex(src).positionAt(src.length));
        const component = items.find(i => i.label === 'azeroth-component');
        const signal = items.find(i => i.label === 'azeroth-signal');

        expect(component).toBeTruthy();
        expect(component!.insertText).toContain('export default function');
        expect(signal).toBeTruthy();
        expect(signal!.insertText).toContain('createSignal');
    });

    it('offers built-in components (as snippets) after <', () =>
    {
        const src = 'const x = <';
        const uri = open('Tags.azeroth', src);

        const items = ls.getCompletions(uri, new LineIndex(src).positionAt(src.length));
        const show = items.find(i => i.label === 'Show');
        const forItem = items.find(i => i.label === 'For');

        expect(show).toBeTruthy();
        expect(forItem).toBeTruthy();
        // Built-ins expand to their control-flow shape, not just the name.
        expect(show!.insertText).toContain('when={');
        expect(forItem!.insertText).toContain('each={');
    });
});

describe('external completion sources', () =>
{
    // The registry is a process-wide global; clear it after each case so a
    // registered source never leaks into the other completion tests.
    afterEach(() =>
    {
        clearCompletionSources();
    });

    it('appends items from a registered source, context-aware', () =>
    {
        const src = 'const x = <input />;';
        const uri = open('AiSource.azeroth', src);

        let seenKind = '';
        const source: CompletionSource =
        {
            provide(args)
            {
                seenKind = args.context.kind;
                return [{ label: 'ai-suggestion', kind: CompletionItemKind.Text }];
            }
        };
        registerCompletionSource(source);

        const items = ls.getCompletions(uri, at(src, '<input />', '<input '.length));
        const sentinel = items.find(i => i.label === 'ai-suggestion');

        expect(sentinel).toBeTruthy();
        // The classified context is passed through to the source.
        expect(seenKind).toBe('attributeName');
        // Native items still come along.
        expect(items.some(i => i.label === 'placeholder')).toBe(true);
    });

    it('a throwing source never breaks native completion', () =>
    {
        const src = 'const x = <input />;';
        const uri = open('AiThrows.azeroth', src);

        registerCompletionSource({
            provide()
            {
                throw new Error('backend offline');
            }
        });

        const labels = ls.getCompletions(uri, at(src, '<input />', '<input '.length)).map(i => i.label);

        expect(labels).toContain('placeholder');
        expect(labels).toContain('type');
    });

    it('unregister and clear remove a source', () =>
    {
        const src = 'const x = <input />;';
        const uri = open('AiUnregister.azeroth', src);

        const source: CompletionSource = { provide: () => [{ label: 'ai-suggestion', kind: CompletionItemKind.Text }] };
        const unregister = registerCompletionSource(source);

        const at1 = at(src, '<input />', '<input '.length);
        expect(ls.getCompletions(uri, at1).some(i => i.label === 'ai-suggestion')).toBe(true);

        unregister();
        expect(ls.getCompletions(uri, at1).some(i => i.label === 'ai-suggestion')).toBe(false);

        // clearCompletionSources also drops everything.
        registerCompletionSource(source);
        clearCompletionSources();
        expect(ls.getCompletions(uri, at1).some(i => i.label === 'ai-suggestion')).toBe(false);
    });
});

describe('mapping round-trips at completion-critical offsets', () =>
{
    it('round-trips every identifier offset inside holes and handlers', () =>
    {
        const src = 'const x = <button onClick={() => handle(count())}>Count: {count()}</button>;';
        const { code, mapping } = generateVirtualCode(src);

        for (const name of ['handle', 'count())', 'count()}<'])
        {
            const ident = name.replace(/[^A-Za-z].*$/, '');
            const sourceOffset = src.indexOf(name);
            for (let i = 0; i < ident.length; i++)
            {
                const generated = mapping.toGenerated(sourceOffset + i);
                expect(generated).not.toBeNull();
                expect(mapping.toOriginal(generated!)).toBe(sourceOffset + i);
            }
            const generatedStart = mapping.toGenerated(sourceOffset)!;
            expect(code.slice(generatedStart, generatedStart + ident.length)).toBe(ident);
        }
    });

    it('round-trips component tag and prop-value offsets', () =>
    {
        const src = 'const x = <Card title={user.name} />;';
        const { code, mapping } = generateVirtualCode(src);

        // The prop-value expression passes through verbatim: exact round-trip.
        const userOffset = src.indexOf('user');
        const userGenerated = mapping.toGenerated(userOffset);
        expect(userGenerated).not.toBeNull();
        expect(code.slice(userGenerated!, userGenerated! + 4)).toBe('user');
        expect(mapping.toOriginal(userGenerated!)).toBe(userOffset);

        // The tag's span starts at the `<` (dropped in `Card(...)` output), so
        // its round-trip lands at most one character left of the name.
        const cardOffset = src.indexOf('Card');
        const cardGenerated = mapping.toGenerated(cardOffset);
        expect(cardGenerated).not.toBeNull();
        expect(code.slice(cardGenerated!, cardGenerated! + 4)).toBe('Card');
        expect(mapping.toOriginal(cardGenerated!)).toBeGreaterThanOrEqual(cardOffset - 1);
        expect(mapping.toOriginal(cardGenerated!)).toBeLessThanOrEqual(cardOffset);
    });
});
