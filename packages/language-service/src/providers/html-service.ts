// Thin wrapper over `vscode-html-languageservice` - the same HTML engine VS
// Code ships - applied to the embedded HTML view of a `.azeroth` file
// (html-source.ts). It answers host-element completion (tags, attributes, and
// crucially attribute *values* like `<input type="...">`) and MDN-backed hover.
//
// Offsets are shared with the original source (the embedded view is space-for-
// space the same length), so positions and result ranges need no translation.
// The AzerothJS-specific layer - built-in components, camelCase events,
// component prop types - is added by the completion/hover providers on top of
// what this returns.

import {
    getLanguageService,
    getDefaultHTMLDataProvider,
    type HTMLDocument,
    type LanguageService,
    type CompletionItem as HtmlCompletionItem,
    type MarkupContent,
    type MarkedString
} from 'vscode-html-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { generateHtmlSource } from '../html-source.ts';
import {
    CompletionItemKind,
    type CompletionItem,
    type Hover,
    type Position,
    type Range
} from '../protocol.ts';

let service: LanguageService | null = null;

const html = (): LanguageService => (service ??= getLanguageService());

/** Cache the parsed embedded document so completion + hover on the same edit reuse it. */
let cache: { source: string; doc: TextDocument; parsed: HTMLDocument } | null = null;

/**
 * The parsed HTML view of `source` that the html-languageservice works against,
 * served from {@link cache} when the source is unchanged since the last call.
 */
function embeddedDocument(source: string): { doc: TextDocument; parsed: HTMLDocument }
{
    if (cache && cache.source === source)
    {
        return cache;
    }
    const doc = TextDocument.create('embedded://azeroth.html', 'html', 0, generateHtmlSource(source));
    const parsed = html().parseHTMLDocument(doc);
    cache = { source, doc, parsed };
    return cache;
}

/** Host-element completion (tags / attributes / attribute values) with docs. */
export function htmlCompletions(source: string, position: Position): CompletionItem[]
{
    const { doc, parsed } = embeddedDocument(source);
    const list = html().doComplete(doc, position, parsed);
    return list.items.map(toCompletionItem);
}

/** MDN-backed hover for a host element / attribute / value. */
export function htmlHover(source: string, position: Position): Hover | null
{
    const { doc, parsed } = embeddedDocument(source);
    const hover = html().doHover(doc, position, parsed);
    if (!hover)
    {
        return null;
    }
    return {
        contents: markupToString(hover.contents),
        range: hover.range as Range | undefined
    };
}

/**
 * MDN documentation (description + reference links) for a DOM event, keyed by
 * AzerothJS's camelCase name. The HTML data stores events lowercase
 * (`onclick`), so `onClick` is matched case-insensitively - giving the same
 * MDN docs the HTML engine shows for the lowercase form.
 */
let eventDocs: Map<string, string> | null = null;

function buildEventDocs(): Map<string, string>
{
    const map = new Map<string, string>();
    for (const attr of getDefaultHTMLDataProvider().provideAttributes('div'))
    {
        if (!/^on/i.test(attr.name))
        {
            continue;
        }
        const description = markupToString(attr.description);
        const references = (attr.references ?? []).map(reference => `[${ reference.name }](${ reference.url })`).join(' | ');
        const markdown = [description, references].filter(Boolean).join('\n\n');
        if (markdown)
        {
            map.set(attr.name.toLowerCase(), markdown);
        }
    }
    return map;
}

/** MDN documentation for a camelCase DOM event (`onClick`), or undefined. */
export function eventDocumentation(camelName: string): string | undefined
{
    eventDocs ??= buildEventDocs();
    return eventDocs.get(camelName.toLowerCase());
}

/** Maps an HTML-service completion entry to our protocol's CompletionItem. */
function toCompletionItem(item: HtmlCompletionItem): CompletionItem
{
    const insertText = item.textEdit && 'newText' in item.textEdit
        ? item.textEdit.newText
        : item.insertText ?? item.label;
    return {
        label: item.label,
        kind: ((item.kind as number | undefined) ?? CompletionItemKind.Property) as CompletionItem['kind'],
        detail: item.detail,
        documentation: markupToString(item.documentation),
        insertText,
        insertTextFormat: (item.insertTextFormat as 1 | 2 | undefined) ?? 1,
        sortText: item.sortText,
        filterText: item.filterText
    };
}

/** Flattens the HTML service's documentation/hover content into Markdown. */
function markupToString(
    content: string | MarkupContent | MarkedString | MarkedString[] | undefined
): string
{
    if (content === undefined)
    {
        return '';
    }
    if (typeof content === 'string')
    {
        return content;
    }
    if (Array.isArray(content))
    {
        return content.map(markupToString).join('\n\n');
    }
    if ('kind' in content)
    {
        return content.value;
    }
    if ('value' in content)
    {
        return content.value;
    }
    return '';
}
