// CSS intelligence for inline `style="..."` values, via `vscode-css-languageservice`
// (the engine behind VS Code's CSS support). An inline style is a declaration
// list, not a full stylesheet, so we wrap it in a synthetic rule `*{ ... }` and
// shift positions by the 2-character prefix - the same trick VS Code uses for
// embedded styles. Only static `style="..."` values reach here; `style={...}` is a
// JavaScript expression handled by the TypeScript bridge.

import { getCSSLanguageService, type LanguageService, type CompletionItem as CssCompletionItem, type Color as CssColor, type Range as CssRange } from 'vscode-css-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    CompletionItemKind,
    type Color,
    type ColorInformation,
    type ColorPresentation,
    type CompletionItem,
    type Hover,
    type Range
} from '../protocol.ts';
import type { LineIndex } from '../text.ts';

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
    const quote = source[i];
    if (i < 0 || (quote !== '"' && quote !== '\''))
    {
        return null;
    }
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

/** Maps css-language-service completion items to our protocol shape. */
function mapCssItems(items: CssCompletionItem[]): CompletionItem[]
{
    return items.map(item => ({
        label: item.label,
        kind: (item.kind as number | undefined ?? CompletionItemKind.Property) as CompletionItem['kind'],
        detail: item.detail,
        documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
        insertText: item.textEdit && 'newText' in item.textEdit ? item.textEdit.newText : item.insertText ?? item.label,
        insertTextFormat: (item.insertTextFormat) ?? 1,
        sortText: item.sortText
    }));
}

/** CSS property/value completion inside an inline `style="..."`. */
export function cssCompletions(source: string, offset: number): CompletionItem[]
{
    const wrapped = wrap(source, offset);
    if (wrapped === null)
    {
        return [];
    }
    const stylesheet = css().parseStylesheet(wrapped.doc);
    const list = css().doComplete(wrapped.doc, wrapped.doc.positionAt(wrapped.caret), stylesheet);
    return mapCssItems(list.items);
}

// styleMap({ ... }) support: the object keys are CSS property names (camelCase)
// and string values are CSS values. These two helpers expose the CSS engine's
// property/value vocabulary so a dedicated provider can offer it on the object
// keys and inside value strings. The engine speaks kebab-case CSS; the provider
// translates to/from the camelCase the object literal uses.

/** All CSS property names (kebab-case) as completion items, with MDN docs. */
export function cssPropertyCompletions(): CompletionItem[]
{
    const doc = TextDocument.create('inline://props.css', 'css', 0, `${ WRAP_PREFIX }}`);
    const stylesheet = css().parseStylesheet(doc);
    // The caret sits right after `*{`, where the engine offers property names.
    const list = css().doComplete(doc, doc.positionAt(WRAP_PREFIX.length), stylesheet);
    return mapCssItems(list.items).filter(item => item.kind === CompletionItemKind.Property);
}

/**
 * CSS value completions for `property` (kebab-case) given the value text typed
 * so far and the caret's offset within it (e.g. property `font-weight`, value
 * `bo` -> `bold`). Wraps the declaration in a synthetic rule so the engine sees
 * a real value position.
 */
export function cssValueCompletions(property: string, valueText: string, caretInValue: number): CompletionItem[]
{
    const prefix = `${ WRAP_PREFIX }${ property }:`;
    const doc = TextDocument.create('inline://value.css', 'css', 0, `${ prefix }${ valueText }}`);
    const stylesheet = css().parseStylesheet(doc);
    const list = css().doComplete(doc, doc.positionAt(prefix.length + caretInValue), stylesheet);
    return mapCssItems(list.items);
}

// css`` tagged templates. Their content is a real stylesheet (selectors and
// all), not a declaration list, so unlike style="..." it parses without the
// synthetic-rule wrap. The TypeScript bridge sees the template as an opaque
// string, so this is the only source of intelligence inside it.

/**
 * The `[start, end)` of the css`` template content around `offset`, or null
 * when the caret isn't inside one. Interpolations are rare in scoped css;
 * the scan only skips escaped backticks.
 */
function cssTemplateSpan(source: string, offset: number): { start: number; end: number } | null
{
    const open = /\bcss\s*`/g;
    let match: RegExpExecArray | null;
    while ((match = open.exec(source)) !== null)
    {
        const start = match.index + match[0].length;
        let i = start;
        while (i < source.length && source[i] !== '`')
        {
            if (source[i] === '\\')
            {
                i++;
            }
            i++;
        }
        if (offset >= start && offset <= i)
        {
            return { start, end: i };
        }
        open.lastIndex = i + 1;
    }
    return null;
}

/** Whether the caret sits inside a css`` template. */
export function inCssTemplate(source: string, offset: number): boolean
{
    return cssTemplateSpan(source, offset) !== null;
}

/** Builds the stylesheet document for the css`` template around `offset`. */
function templateDoc(source: string, offset: number): { doc: TextDocument; caret: number; contentStart: number } | null
{
    const span = cssTemplateSpan(source, offset);
    if (span === null)
    {
        return null;
    }
    const content = source.slice(span.start, span.end);
    const doc = TextDocument.create('inline://scoped.css', 'css', 0, content);
    return { doc, caret: offset - span.start, contentStart: span.start };
}

/** CSS completion (selectors, properties, values) inside a css`` template. */
export function cssTemplateCompletions(source: string, offset: number): CompletionItem[]
{
    const wrapped = templateDoc(source, offset);
    if (wrapped === null)
    {
        return [];
    }
    const stylesheet = css().parseStylesheet(wrapped.doc);
    const list = css().doComplete(wrapped.doc, wrapped.doc.positionAt(wrapped.caret), stylesheet);
    return mapCssItems(list.items);
}

/** CSS hover inside a css`` template. */
export function cssTemplateHover(source: string, offset: number, lineIndex: LineIndex): Hover | null
{
    const wrapped = templateDoc(source, offset);
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
        range = lineIndex.rangeAt(
            wrapped.doc.offsetAt(hover.range.start) + wrapped.contentStart,
            wrapped.doc.offsetAt(hover.range.end) + wrapped.contentStart
        );
    }
    return { contents, range };
}

/** CSS hover (property/value docs) inside an inline `style="..."`. */
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

// Document colors: render a swatch next to every CSS color literal so the
// editor can show (and pick from) it. Both a style="..." value and a css``
// template are handled by the same engine; they differ only in framing - a
// style value is a declaration list wrapped in a synthetic `*{ ... }` rule (so
// css-doc offsets carry the 2-char prefix), a template is already a stylesheet.

/** A style/css region: its content and where that content begins in the source. */
interface CssRegion
{
    /** The CSS text fed to the language service. */
    content: string;
    /** Original-source offset of the content's first character. */
    contentStart: number;
    /** The synthetic prefix prepended to make `content` parse (`''` for templates). */
    prefix: string;
}

/** css-doc offset back to original source, undoing the synthetic prefix shift. */
function toSourceOffset(region: CssRegion, doc: TextDocument, position: { line: number; character: number }): number
{
    return doc.offsetAt(position) - region.prefix.length + region.contentStart;
}

/** Maps a css-doc range to an original-source range within `region`. */
function regionRange(region: CssRegion, doc: TextDocument, range: CssRange, lineIndex: LineIndex): Range
{
    return lineIndex.rangeAt(
        toSourceOffset(region, doc, range.start),
        toSourceOffset(region, doc, range.end)
    );
}

/** css-language-service Color -> our protocol Color (identical shape, re-typed). */
function mapColor(color: CssColor): Color
{
    return { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha };
}

/**
 * Color swatches across the given style/css regions. Runs findDocumentColors
 * over each region's wrapped document and maps every color's range back to the
 * original source. Never throws; a region that fails to parse contributes none.
 */
export function cssColors(_source: string, regions: CssRegion[], lineIndex: LineIndex): ColorInformation[]
{
    const out: ColorInformation[] = [];
    for (const region of regions)
    {
        const doc = TextDocument.create('inline://color.css', 'css', 0, `${ region.prefix }${ region.content }${ region.prefix ? '}' : '' }`);
        const stylesheet = css().parseStylesheet(doc);
        for (const info of css().findDocumentColors(doc, stylesheet))
        {
            out.push({ range: regionRange(region, doc, info.range, lineIndex), color: mapColor(info.color) });
        }
    }
    return out;
}

/**
 * The presentation choices (e.g. `#ff0000`, `rgb(255, 0, 0)`, `hsl(...)`) for a
 * picked `color` at `range`. Delegates to getColorPresentations over a throwaway
 * document whose text is just the color literal, since the presentations are the
 * spellings of the color itself and don't depend on the surrounding stylesheet.
 */
export function cssColorPresentations(color: Color, range: Range): ColorPresentation[]
{
    const doc = TextDocument.create('inline://present.css', 'css', 0, '*{color:}');
    const stylesheet = css().parseStylesheet(doc);
    const at: CssRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return css().getColorPresentations(doc, stylesheet, color, at).map(presentation => ({
        label: presentation.label,
        textEdit: presentation.textEdit
            ? { range, newText: presentation.textEdit.newText }
            : undefined
    }));
}

/** Builds a declaration-list region from a static `style="..."` value's span. */
export function styleRegion(source: string, valueStart: number, valueEnd: number): CssRegion
{
    return { content: source.slice(valueStart, valueEnd), contentStart: valueStart, prefix: WRAP_PREFIX };
}

/**
 * Builds a color-bearing region from a bare CSS *value* span (e.g. a styleMap
 * string value `#0080ff`). The value alone isn't a declaration, so it's framed
 * as `*{color:<value>}`; the longer prefix is accounted for when ranges are
 * mapped back to the source.
 */
export function valueColorRegion(source: string, valueStart: number, valueEnd: number): CssRegion
{
    return { content: source.slice(valueStart, valueEnd), contentStart: valueStart, prefix: `${ WRAP_PREFIX }color:` };
}

/** Builds a stylesheet region from a css`` template's content span. */
export function templateRegion(source: string, contentStart: number, contentEnd: number): CssRegion
{
    return { content: source.slice(contentStart, contentEnd), contentStart, prefix: '' };
}

/** The content spans of every css`` template in the source (start/end offsets). */
export function cssTemplateSpans(source: string): { start: number; end: number }[]
{
    const open = /\bcss\s*`/g;
    const spans: { start: number; end: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = open.exec(source)) !== null)
    {
        const start = match.index + match[0].length;
        let i = start;
        while (i < source.length && source[i] !== '`')
        {
            if (source[i] === '\\')
            {
                i++;
            }
            i++;
        }
        spans.push({ start, end: i });
        open.lastIndex = i + 1;
    }
    return spans;
}

export type { CssRegion };
