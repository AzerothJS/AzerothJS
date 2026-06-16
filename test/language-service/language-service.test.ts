// End-to-end tests of the AzerothLanguageService facade - the same surface the
// LSP server exposes. They open in-memory `.azeroth` documents (resolved
// against the repo's tsconfig, so `@azerothjs/core` types load) and assert the
// compiler-aware behaviour: type inference in markup, navigation, diagnostics,
// and context-aware completion.

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri, type Position, type TextEdit } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

/** A position located by searching the source for `needle`. */
function at(source: string, needle: string, offsetInNeedle = 0): Position
{
    return new LineIndex(source).positionAt(source.indexOf(needle) + offsetInNeedle);
}

/** Applies LSP text edits to a source string (descending order, so offsets hold). */
function applyEdits(source: string, edits: TextEdit[]): string
{
    const idx = new LineIndex(source);
    const ordered = [...edits].sort((a, b) => idx.offsetAt(b.range.start) - idx.offsetAt(a.range.start));
    let out = source;
    for (const edit of ordered)
    {
        const start = idx.offsetAt(edit.range.start);
        const end = idx.offsetAt(edit.range.end);
        out = out.slice(0, start) + edit.newText + out.slice(end);
    }
    return out;
}

const COUNTER = [
    "import { createSignal } from '@azerothjs/core';",
    'export default function Counter() {',
    '    const [count, setCount] = createSignal(0);',
    '    return <button onClick={() => setCount(count() + 1)}>Count: {count()}</button>;',
    '}'
].join('\n');

let ls: AzerothLanguageService;
// Canonical URI (same percent-encoding the service produces), so URIs returned
// by navigation/rename compare equal to the one we opened.
const uri = pathToUri(path.join(ROOT, 'Counter.azeroth'));

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
    ls.didOpen(uri, COUNTER);
});

describe('hover & type inference inside markup', () =>
{
    it('infers the type of a signal read in an expression hole', () =>
    {
        const pos = at(COUNTER, 'Count: {count()}', 'Count: {'.length);
        const hover = ls.getHover(uri, pos);
        expect(hover).not.toBeNull();
        expect(hover!.contents).toContain('count');
        expect(hover!.contents).toContain('number');
    });

    it('shows MDN docs on a host element tag (via the HTML engine)', () =>
    {
        const u = uri.replace('Counter', 'HostHover');
        const src = 'const x = <img src="/a.png"/>;';
        ls.didOpen(u, src);
        const hover = ls.getHover(u, at(src, 'img', 1));
        expect(hover).not.toBeNull();
        expect(hover!.contents.length).toBeGreaterThan(0);
    });

    it('documents common form attributes the HTML dataset omits (value/type/placeholder)', () =>
    {
        const u = uri.replace('Counter', 'AttrDocs');
        const src = 'const x = <input type="text" placeholder="hi"/>;';
        ls.didOpen(u, src);
        const typeHover = ls.getHover(u, at(src, 'type="text"', 1));
        const phHover = ls.getHover(u, at(src, 'placeholder=', 1));
        expect(typeHover?.contents).toContain('control');
        expect(phHover?.contents).toContain('Hint text');
    });

    it('shows framework docs on a built-in component tag', () =>
    {
        const u = uri.replace('Counter', 'ShowHover');
        const src = 'const x = <Show when={a}><p>hi</p></Show>;';
        ls.didOpen(u, src);
        const hover = ls.getHover(u, at(src, 'Show', 1));
        expect(hover).not.toBeNull();
        expect(hover!.contents).toContain('built-in component');
    });
});

describe('navigation', () =>
{
    it('jumps to the definition of a symbol used in markup', () =>
    {
        const pos = at(COUNTER, 'Count: {count()}', 'Count: {'.length);
        const defs = ls.getDefinition(uri, pos);
        expect(defs.length).toBeGreaterThan(0);
        expect(defs[0].uri).toBe(uri);
    });

    it('jumps to the type definition of a symbol', () =>
    {
        const u = uri.replace('Counter', 'TypeDef');
        // `user` is typed by a locally-declared interface, so its type definition
        // maps back into this same source (uri + the `interface User` range).
        const src = 'interface User { id: number; }\nconst user: User = { id: 1 };\nconst x = <p>{user.id}</p>;';
        ls.didOpen(u, src);
        const defs = ls.getTypeDefinition(u, at(src, '{user.id}', 1));
        expect(defs.length).toBeGreaterThan(0);
        expect(defs[0].uri).toBe(u);
        const idx = new LineIndex(src);
        const offset = idx.offsetAt(defs[0].range.start);
        expect(src.slice(offset, offset + 'User'.length)).toBe('User');
    });

    it('finds every reference to a signal (declaration + reads)', () =>
    {
        const pos = at(COUNTER, 'const [count', 'const ['.length);
        expect(ls.getReferences(uri, pos).length).toBeGreaterThanOrEqual(2);
    });

    it('renames a symbol everywhere, including inside markup', () =>
    {
        const pos = at(COUNTER, 'const [count', 'const ['.length);
        const edit = ls.getRenameEdits(uri, pos, 'tally');
        expect(edit).not.toBeNull();
        const edits = edit!.changes[uri];
        expect(edits.length).toBeGreaterThanOrEqual(2);
        expect(edits.every(e => e.newText === 'tally')).toBe(true);
    });
});

describe('diagnostics', () =>
{
    it('reports a markup parse error from the compiler', () =>
    {
        const u = uri.replace('Counter', 'Bad');
        ls.didOpen(u, 'const x = <a></b>;');
        const diags = ls.getDiagnostics(u);
        expect(diags.length).toBeGreaterThan(0);
        expect(diags[0].source).toBe('azeroth');
        expect(diags[0].message).toMatch(/closing tag/i);
    });

    it('reports a real TypeScript type error mapped to the source', () =>
    {
        const u = uri.replace('Counter', 'TypeErr');
        ls.didOpen(u, 'const n: number = "oops";\nconst x = <p>{n}</p>;');
        const diags = ls.getDiagnostics(u);
        expect(diags.some(d => /not assignable/.test(d.message))).toBe(true);
    });

    it('reports nothing for a valid document', () =>
    {
        expect(ls.getDiagnostics(uri)).toEqual([]);
    });
});

describe('completion', () =>
{
    it('offers HTML elements and components in tag position', () =>
    {
        const u = uri.replace('Counter', 'Tag');
        ls.didOpen(u, 'const x = <di');
        const items = ls.getCompletions(u, at('const x = <di', '<di', 3));
        const labels = items.map(i => i.label);
        expect(labels).toContain('div');
        expect(labels).toContain('Show');
    });

    it('offers attributes and events in attribute position', () =>
    {
        const u = uri.replace('Counter', 'Attr');
        const src = 'const x = <button cla';
        ls.didOpen(u, src);
        const labels = ls.getCompletions(u, at(src, 'cla', 3)).map(i => i.label);
        expect(labels).toContain('class');
        expect(labels).toContain('onClick');
    });

    it('offers type-aware members inside an expression hole', () =>
    {
        const u = uri.replace('Counter', 'Expr');
        const src = "const s = 'hi';\nconst x = <p>{s.}</p>;";
        ls.didOpen(u, src);
        const labels = ls.getCompletions(u, at(src, '{s.}', 3)).map(i => i.label);
        expect(labels).toContain('toUpperCase');
    });

    it('offers documented props for a built-in component', () =>
    {
        const u = uri.replace('Counter', 'Show');
        const src = 'const x = <Show wh';
        ls.didOpen(u, src);
        const labels = ls.getCompletions(u, at(src, 'wh', 2)).map(i => i.label);
        expect(labels).toContain('when');
    });

    it('offers HTML attribute-value enums on host elements (via the HTML engine)', () =>
    {
        const u = uri.replace('Counter', 'Value');
        const src = 'const x = <input type="">';
        ls.didOpen(u, src);
        const labels = ls.getCompletions(u, at(src, 'type="', 6)).map(i => i.label);
        expect(labels).toContain('checkbox');
        expect(labels).toContain('email');
    });

    it('keeps camelCase events and drops lowercase HTML ones on host elements', () =>
    {
        const u = uri.replace('Counter', 'Events');
        const src = 'const x = <button on';
        ls.didOpen(u, src);
        const labels = ls.getCompletions(u, at(src, ' on', 3)).map(i => i.label);
        expect(labels).toContain('onClick');
        expect(labels).not.toContain('onclick');
    });

    it('attaches MDN documentation to camelCase events', () =>
    {
        const u = uri.replace('Counter', 'EventDocs');
        const src = 'const x = <button on';
        ls.didOpen(u, src);
        const onClick = ls.getCompletions(u, at(src, ' on', 3)).find(i => i.label === 'onClick');
        expect(onClick?.documentation).toBeTruthy();
    });
});

describe('symbols, signature help, semantic tokens, folding', () =>
{
    it('lists the document outline', () =>
    {
        expect(ls.getDocumentSymbols(uri).map(s => s.name)).toContain('Counter');
    });

    it('gives signature help with parameter types', () =>
    {
        const pos = at(COUNTER, 'setCount(count()', 'setCount('.length);
        const help = ls.getSignatureHelp(uri, pos);
        expect(help).not.toBeNull();
        expect(help!.signatures[0].label).toContain('newValue');
    });

    it('emits semantic tokens for the markup (multiple of 5 ints)', () =>
    {
        const data = ls.getSemanticTokens(uri).data;
        expect(data.length).toBeGreaterThan(0);
        expect(data.length % 5).toBe(0);
    });

    it('produces a folding range for the multi-line element', () =>
    {
        const u = uri.replace('Counter', 'Fold');
        ls.didOpen(u, 'const x = <ul>\n  <li>a</li>\n  <li>b</li>\n</ul>;');
        expect(ls.getFoldingRanges(u).length).toBeGreaterThan(0);
    });

    it('folds a TS span to its closing-brace line, not the trailing newline', () =>
    {
        const u = uri.replace('Counter', 'FoldEnd');
        // Closing brace on line 3, then a trailing newline (line 4). The outlining span's
        // end offset is exclusive, so the fold must stop on the brace line, never line 4.
        ls.didOpen(u, 'function f()\n{\n    return 1;\n}\n');
        const fold = ls.getFoldingRanges(u).find(r => r.kind === 'region');
        expect(fold).toBeDefined();
        expect(fold!.endLine).toBe(3);
    });
});

describe('JSX-style editing behaviours', () =>
{
    it('auto-closes a tag when the opening > is typed', () =>
    {
        const u = uri.replace('Counter', 'Close');
        // Document state immediately after typing the `>` of `<div>`.
        ls.didOpen(u, 'const x = <div>');
        const snippet = ls.getAutoCloseTag(u, at('const x = <div>', '<div>', 5));
        expect(snippet).toBe('$0</div>');
    });

    it('auto-closes a nested tag', () =>
    {
        const u = uri.replace('Counter', 'Nested');
        ls.didOpen(u, 'const x = <ul><li>');
        const snippet = ls.getAutoCloseTag(u, at('const x = <ul><li>', '<li>', 4));
        expect(snippet).toBe('$0</li>');
    });

    it('does not auto-close a self-closing tag or a void element', () =>
    {
        const u = uri.replace('Counter', 'Self');
        ls.didOpen(u, 'const x = <br/>');
        expect(ls.getAutoCloseTag(u, at('const x = <br/>', '<br/>', 5))).toBeNull();
    });

    it('is not fooled by a < inside an attribute expression', () =>
    {
        const u = uri.replace('Counter', 'Attr2');
        const src = 'const x = <div title={a < b}>';
        ls.didOpen(u, src);
        expect(ls.getAutoCloseTag(u, { line: 0, character: src.length })).toBe('$0</div>');
    });

    it('reports linked editing ranges for an open/close tag pair', () =>
    {
        const u = uri.replace('Counter', 'Linked');
        const src = 'const x = <section>hi</section>;';
        ls.didOpen(u, src);
        const ranges = ls.getLinkedEditingRanges(u, at(src, '<section>', 2));
        expect(ranges).not.toBeNull();
        expect(ranges!.length).toBe(2);
    });
});

describe('component props, highlights, auto-import', () =>
{
    const COMP = [
        'function Row(props: { id: number; label: string; onPick: (id: number) => void }) {',
        '  return <li>{props.label}</li>;',
        '}',
        'export default function App() {',
        '  return <Row id={1} label="x" onPick={() => {}} />;',
        '}'
    ].join('\n');

    it('suggests a component’s props from its type', () =>
    {
        const u = uri.replace('Counter', 'Props');
        const src = COMP.replace('<Row id={1} label="x" onPick={() => {}} />', '<Row />');
        ls.didOpen(u, src);
        const labels = ls.getCompletions(u, at(src, '<Row />', 5)).map(i => i.label);
        expect(labels).toEqual(expect.arrayContaining(['id', 'label', 'onPick']));
    });

    it('hovers a component prop with its type', () =>
    {
        const u = uri.replace('Counter', 'PropHover');
        ls.didOpen(u, COMP);
        const hover = ls.getHover(u, at(COMP, 'label="x"', 0));
        expect(hover?.contents).toContain('label: string');
    });

    it('reports document highlights for a symbol', () =>
    {
        const u = uri.replace('Counter', 'Hi');
        ls.didOpen(u, COMP);
        expect(ls.getDocumentHighlights(u, at(COMP, 'props.label', 0)).length).toBeGreaterThanOrEqual(2);
    });

    it('gives built-in components a snippet body', () =>
    {
        const u = uri.replace('Counter', 'Snip');
        const src = 'const x = <For';
        ls.didOpen(u, src);
        const forItem = ls.getCompletions(u, at(src, '<For', 1)).find(i => i.label === 'For');
        expect(forItem?.insertTextFormat).toBe(2);
        expect(forItem?.insertText).toContain('each=');
    });

    it('resolves an auto-import completion into an import edit (no crash)', () =>
    {
        const u = uri.replace('Counter', 'AutoImp');
        const src = "import { createSignal } from '@azerothjs/core';\nconst y = createEffect";
        ls.didOpen(u, src);
        const item = ls.getCompletions(u, { line: 1, character: src.split('\n')[1].length }).find(i => i.label === 'createEffect');
        expect(item).toBeTruthy();
        const resolved = ls.resolveCompletion(u, item!);
        expect(resolved.additionalTextEdits?.[0].newText).toContain('createEffect');
    });

    it('produces inlay hints (parameter names / inferred types)', () =>
    {
        const u = uri.replace('Counter', 'Inlay');
        const src = 'function add(a: number, b: number) { return a + b; }\nconst total = add(1, 2);\nconst x = <p>{total}</p>;';
        ls.didOpen(u, src);
        const idx = new LineIndex(src);
        const hints = ls.getInlayHints(u, { start: { line: 0, character: 0 }, end: idx.positionAt(src.length) });
        expect(hints.length).toBeGreaterThan(0);
        // parameter-name hints for add(1, 2)
        expect(hints.some(h => h.label.includes('a') || h.label.includes('b'))).toBe(true);
    });

    it('honours completion + inlay-hint option toggles', () =>
    {
        const u = uri.replace('Counter', 'Opts');
        const src = "import { createSignal } from '@azerothjs/core';\nconst y = createEffect\nconst x = <For";
        ls.didOpen(u, src);
        const idx = new LineIndex(src);
        const pos = { line: 1, character: src.split('\n')[1].length };
        // auto-imports toggle
        expect(ls.getCompletions(u, pos).some(i => i.label === 'createEffect')).toBe(true);
        expect(ls.getCompletions(u, pos, { autoImports: false }).some(i => i.label === 'createEffect')).toBe(false);
        // component snippet toggle
        const forOn = ls.getCompletions(u, { line: 2, character: 14 }).find(i => i.label === 'For');
        const forOff = ls.getCompletions(u, { line: 2, character: 14 }, { componentSnippets: false }).find(i => i.label === 'For');
        expect(forOn?.insertTextFormat).toBe(2);
        expect(forOff?.insertTextFormat).toBe(1);
        // inlay hints master switch
        const full = { start: { line: 0, character: 0 }, end: idx.positionAt(src.length) };
        expect(ls.getInlayHints(u, full, { enabled: false })).toEqual([]);
    });

    it('offers refactors whose edits map back to source', () =>
    {
        const u = uri.replace('Counter', 'Refactor');
        const src = 'export function f() {\n  const n = 1 + 2 + 3;\n  return n;\n}';
        ls.didOpen(u, src);
        const idx = new LineIndex(src);
        const exprStart = src.indexOf('1 + 2 + 3');
        const range = { start: idx.positionAt(exprStart), end: idx.positionAt(exprStart + '1 + 2 + 3'.length) };
        const refactors = ls.getCodeActions(u, range, []).filter(a => a.kind === 'refactor');
        expect(refactors.length).toBeGreaterThan(0);
        expect(Object.keys(refactors[0].edit!.changes).length).toBeGreaterThan(0);
    });
});

describe('typed event handlers', () =>
{
    it('infers the DOM event type for an un-annotated handler param (no error)', () =>
    {
        const u = uri.replace('Counter', 'Ev');
        const src = 'const x = <button onClick={(e) => e.clientX}>x</button>;';
        ls.didOpen(u, src);
        const idx = new LineIndex(src);
        expect(ls.getDiagnostics(u)).toEqual([]);
        const hover = ls.getHover(u, idx.positionAt(src.indexOf('(e)') + 1));
        expect(hover?.contents).toMatch(/MouseEvent|PointerEvent/);
    });

    it('completes members of the inferred event (e.key on keydown)', () =>
    {
        const u = uri.replace('Counter', 'Ev2');
        const src = 'const x = <input onKeyDown={(e) => e.}/>;';
        ls.didOpen(u, src);
        const idx = new LineIndex(src);
        expect(ls.getCompletions(u, idx.positionAt(src.indexOf('e.') + 2)).map(i => i.label)).toContain('key');
    });
});

describe('selection ranges & on-type formatting', () =>
{
    it('produces a nested selection-range chain', () =>
    {
        const u = uri.replace('Counter', 'Sel');
        const src = 'function f() {\n  const n = (1 + 2) * 3;\n  return n;\n}';
        ls.didOpen(u, src);
        const idx = new LineIndex(src);
        const sr = ls.getSelectionRanges(u, [idx.positionAt(src.indexOf('1 + 2') + 2)]);
        let depth = 0;
        let node: typeof sr[0] | undefined = sr[0];
        while (node)
        {
            depth++; node = node.parent;
        }
        expect(depth).toBeGreaterThanOrEqual(3);
    });

    it('gives CSS completion and hover inside inline style="…"', () =>
    {
        const u = uri.replace('Counter', 'Css');
        const src = 'const x = <div style="col"></div>;';
        ls.didOpen(u, src);
        const idx = new LineIndex(src);
        expect(ls.getCompletions(u, idx.positionAt(src.indexOf('col') + 3)).map(i => i.label)).toContain('color');
        const src2 = 'const x = <div style="display: flex"></div>;';
        ls.didChange(u, src2);
        const idx2 = new LineIndex(src2);
        expect(ls.getHover(u, idx2.positionAt(src2.indexOf('display')))?.contents.length).toBeGreaterThan(0);
    });

    it('formats on type (after `}`)', () =>
    {
        const u = uri.replace('Counter', 'OnType');
        const src = 'function g(){const x=1;return x;}';
        ls.didOpen(u, src);
        const idx = new LineIndex(src);
        expect(ls.getOnTypeFormattingEdits(u, idx.positionAt(src.length), '}').length).toBeGreaterThan(0);
    });

    it('formats a whole document, touching only mapped regions', () =>
    {
        const u = uri.replace('Counter', 'Format');
        // Unindented, semicolon-less script wrapped around a markup return; the
        // formatter should reindent the script and insert semicolons, but the
        // edits over the markup hole don't map back, leaving its text verbatim.
        const src = 'function f()\n{\nconst x=1\nconst y=2\nreturn <div>{x}</div>\n}';
        ls.didOpen(u, src);
        const formatted = applyEdits(src, ls.getFormattingEdits(u));
        expect(formatted).toContain('    const x = 1;');
        expect(formatted).toContain('    const y = 2;');
        // The markup text itself survives untouched.
        expect(formatted).toContain('<div>{x}</div>');
    });
});

describe('cross-file intelligence', () =>
{
    it('completes a user component imported from another .azeroth file', () =>
    {
        const u = uri.replace('Counter', 'Host');
        const src = "import Panel from './Panel.azeroth';\nconst x = <Pan";
        ls.didOpen(u, src);
        const labels = ls.getCompletions(u, at(src, '<Pan', 4)).map(i => i.label);
        expect(labels).toContain('Panel');
    });
});
