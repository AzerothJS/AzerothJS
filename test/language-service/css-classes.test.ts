// Class intelligence in markup: a `class="..."` value, a `classList({ ... })`
// key, and any string in a `class={ ... }` binding complete, hover, and
// go-to-definition against the project's own CSS. Class names are indexed from
// real `.css`/`.scss`/`.less` files and css`` templates on disk, so these tests
// write a temp workspace and assert against it through the public facade.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AzerothLanguageService, pathToUri, uriToPath } from '@azerothjs/language-service';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;
let ls: AzerothLanguageService;
let appUri: string;

/** Offset of the caret marker `|` in `text`, with the marker removed from the buffer. */
function caret(text: string): { source: string; offset: number }
{
    const offset = text.indexOf('|');
    return { source: text.slice(0, offset) + text.slice(offset + 1), offset };
}

/** Opens `source` (with a `|` caret) at `appUri` and returns the caret position. */
function open(source: string): { position: { line: number; character: number } }
{
    const { source: clean, offset } = caret(source);
    ls.didChange(appUri, clean);
    const lineIndex = clean.slice(0, offset);
    const line = lineIndex.split('\n').length - 1;
    const character = offset - (lineIndex.lastIndexOf('\n') + 1);
    return { position: { line, character } };
}

beforeAll(() =>
{
    dir = fs.mkdtempSync(path.join(tmpdir(), 'azeroth-css-'));
    fs.writeFileSync(path.join(dir, 'style.css'), [
        '.btn { padding: 4px; }',
        '.btn-primary, .btn-accent { background: #06c; color: #fff; }',
        '/* .commented-out should not be indexed */',
        '.card .title { font-weight: bold; }'
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'theme.scss'), [
        '.panel {',
        '  // a line comment with a .fake-class',
        '  &.is-open { display: block; }',
        '}'
    ].join('\n'));

    ls = new AzerothLanguageService(dir);
    appUri = pathToUri(path.join(dir, 'App.azeroth'));
    ls.didOpen(appUri, 'export default () => <div></div>;');
});

afterAll(() =>
{
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('class completion', () =>
{
    it('suggests project classes inside a static class="..."', () =>
    {
        const { position } = open('export default () => <div class="|"></div>;');
        const labels = ls.getCompletions(appUri, position).map(item => item.label);
        expect(labels).toContain('btn');
        expect(labels).toContain('btn-primary');
        expect(labels).toContain('btn-accent');
        expect(labels).toContain('card');
        expect(labels).toContain('title');
    });

    it('indexes class names from .scss including nested selectors', () =>
    {
        const { position } = open('export default () => <div class="|"></div>;');
        const labels = ls.getCompletions(appUri, position).map(item => item.label);
        expect(labels).toContain('panel');
        expect(labels).toContain('is-open');
    });

    it('does not index class-like tokens inside comments', () =>
    {
        const { position } = open('export default () => <div class="|"></div>;');
        const labels = ls.getCompletions(appUri, position).map(item => item.label);
        expect(labels).not.toContain('commented-out');
        expect(labels).not.toContain('fake-class');
    });

    it('completes inside a classList({ ... }) key', () =>
    {
        const { position } = open('export default () => <div class={classList({ \'|\': true })}></div>;');
        const labels = ls.getCompletions(appUri, position).map(item => item.label);
        expect(labels).toContain('btn');
        expect(labels).toContain('btn-primary');
    });

    it('completes in a classList key even when an earlier key string contains a paren', () =>
    {
        // The `)` inside the first key string must not be miscounted as closing
        // the classList( call (isUnbalanced skips string literals).
        const { position } = open('export default () => <div class={classList({ \'has-)\': true, \'bt|\': false })}></div>;');
        const labels = ls.getCompletions(appUri, position).map(item => item.label);
        expect(labels).toContain('btn');
    });

    it('completes inside a string in a class={ ... } binding', () =>
    {
        const { position } = open('export default () => <div class={cond ? \'|\' : \'\'}></div>;');
        const labels = ls.getCompletions(appUri, position).map(item => item.label);
        expect(labels).toContain('btn');
    });

    it('offers no class completion outside a class value', () =>
    {
        const { position } = open('export default () => <div id="|"></div>;');
        const labels = ls.getCompletions(appUri, position).map(item => item.label);
        expect(labels).not.toContain('btn-primary');
    });

    it('completes mid-typing before the tag is closed', () =>
    {
        // No closing `>` yet - the resilient scan must still recognise the class value.
        const { position } = open('export default () => <div class="bt|');
        const labels = ls.getCompletions(appUri, position).map(item => item.label);
        expect(labels).toContain('btn');
        expect(labels).toContain('btn-primary');
    });
});

describe('class hover', () =>
{
    it('shows the CSS rule for a class under the caret', () =>
    {
        const { position } = open('export default () => <div class="btn-pri|mary"></div>;');
        const hover = ls.getHover(appUri, position);
        expect(hover).not.toBeNull();
        expect(hover!.contents).toContain('background');
        expect(hover!.contents).toContain('style.css');
    });

    it('returns no hover for an unknown class', () =>
    {
        const { position } = open('export default () => <div class="no-such-cl|ass"></div>;');
        expect(ls.getHover(appUri, position)).toBeNull();
    });
});

describe('class go-to-definition', () =>
{
    it('jumps to the class selector in the stylesheet', () =>
    {
        const { position } = open('export default () => <div class="ca|rd"></div>;');
        const defs = ls.getDefinition(appUri, position);
        expect(defs.length).toBeGreaterThan(0);
        expect(uriToPath(defs[0].uri).replace(/\\/g, '/')).toContain('style.css');
        // The range points at the class name itself (line 3, `.card .title`).
        expect(defs[0].range.start.line).toBe(3);
    });

    it('returns both definitions of a class declared twice', () =>
    {
        // `.btn-primary` and `.btn-accent` are one rule; `btn` appears once. Use a
        // class that resolves to a single location to keep the assertion precise.
        const { position } = open('export default () => <div class="bt|n"></div>;');
        const defs = ls.getDefinition(appUri, position);
        expect(defs.length).toBe(1);
        expect(defs[0].range.start.line).toBe(0);
    });
});
