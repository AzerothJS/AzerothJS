// CSS intelligence for inline `style="…"` values, via `vscode-css-languageservice`
// (the engine behind VS Code's CSS support). An inline style is a declaration
// list, not a full stylesheet, so we wrap it in a synthetic rule `*{ … }` and
// shift positions by the 2-character prefix - the same trick VS Code uses for
// embedded styles. Only static `style="…"` values reach here; `style={…}` is a
// JavaScript expression handled by the TypeScript bridge.

import { getCSSLanguageService, type LanguageService } from 'vscode-css-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    CompletionItemKind,
    type CompletionItem,
    type Hover,
    type Range
} from '../protocol.ts';
import { LineIndex } from '../text.ts';

/** The `*{` we prepend so the declaration list parses as a stylesheet. */
const WRAP_PREFIX = '*{';

let service: LanguageService | null = null;
const css = (): LanguageService => (service ??= getCSSLanguageService());

/** The `[start, end)` of the style value's content around `offset`, or null. */
function styleValueSpan(source: string, offset: number): { start: number; end: number; quote: string } | null
{
    let i = offset - 1;
    while (i >= 0 && source[i] !== '"' && source[i] !== '\'' && source[i] !== '<' && source[i] !== '>')
    {
        i--;
    }
    if (i < 0 || (source[i] !== '"' && source[i] !== '\''))
    {
        return null;
    }
    const quote = source[i];
    const start = i + 1;
    let j = offset;
    while (j < source.length && source[j] !== quote && source[j] !== '<' && source[j] !== '>')
    {
        j++;
    }
    return { start, end: j, quote };
}

/** Builds the wrapped CSS document and the caret offset within it. */
function wrap(source: string, offset: number): { doc: TextDocument; caret: number; contentStart: number } | null
{
    const span = styleValueSpan(source, offset);
    if (span === null)
    {
        return null;
    }
    const content = source.slice(span.start, span.end);
    const doc = TextDocument.create('inline://style.css', 'css', 0, `${ WRAP_PREFIX }${ content }}`);
    return { doc, caret: WRAP_PREFIX.length + (offset - span.start), contentStart: span.start };
}

/** CSS property/value completion inside an inline `style="…"`. */
export function cssCompletions(source: string, offset: number): CompletionItem[]
{
    const wrapped = wrap(source, offset);
    if (wrapped === null)
    {
        return [];
    }
    const stylesheet = css().parseStylesheet(wrapped.doc);
    const list = css().doComplete(wrapped.doc, wrapped.doc.positionAt(wrapped.caret), stylesheet);
    return list.items.map(item => ({
        label: item.label,
        kind: (item.kind as number | undefined ?? CompletionItemKind.Property) as CompletionItem['kind'],
        detail: item.detail,
        documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
        insertText: item.textEdit && 'newText' in item.textEdit ? item.textEdit.newText : item.insertText ?? item.label,
        insertTextFormat: (item.insertTextFormat as 1 | 2 | undefined) ?? 1,
        sortText: item.sortText
    }));
}

/** CSS hover (property/value docs) inside an inline `style="…"`. */
export function cssHover(source: string, offset: number, lineIndex: LineIndex): Hover | null
{
    const wrapped = wrap(source, offset);
    if (wrapped === null)
    {
        return null;
    }
    const stylesheet = css().parseStylesheet(wrapped.doc);
    const hover = css().doHover(wrapped.doc, wrapped.doc.positionAt(wrapped.caret), stylesheet);
    if (!hover)
    {
        return null;
    }
    const contents = typeof hover.contents === 'string'
        ? hover.contents
        : Array.isArray(hover.contents)
            ? hover.contents.map(part => (typeof part === 'string' ? part : part.value)).join('\n\n')
            : (hover.contents as { value: string }).value;

    let range: Range | undefined;
    if (hover.range)
    {
        // Map the css-doc range back to the original source.
        const startOffset = wrapped.doc.offsetAt(hover.range.start) - WRAP_PREFIX.length + wrapped.contentStart;
        const endOffset = wrapped.doc.offsetAt(hover.range.end) - WRAP_PREFIX.length + wrapped.contentStart;
        range = lineIndex.rangeAt(startOffset, endOffset);
    }
    return { contents, range };
}
