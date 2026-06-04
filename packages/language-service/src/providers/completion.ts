// Context-aware completion. The markup model says where the caret is; that
// decides which vocabulary to offer:
//   - tag name      -> HTML elements, built-in components, and in-scope
//                      PascalCase identifiers (user components, via TS);
//   - attribute name -> the tag's attributes + DOM events (or a component's
//                      documented props);
//   - expression/script/text -> delegate to TypeScript at the mapped offset
//                      (full type-aware completion), plus tag suggestions right
//                      after a `<`.
// TypeScript-sourced items carry a `data` payload so documentation/detail can
// be fetched lazily on resolve.

import ts from 'typescript';
import {
    CompletionItemKind,
    type CompletionItem,
    type CompletionItemKindValue
} from '../protocol.ts';
import { classifyPosition, enclosingElement } from '../markup-model.ts';
import {
    BUILTIN_COMPONENTS,
    BUILTIN_COMPONENT_MAP,
    DOM_EVENTS,
    attributeDocumentation
} from '../language-data.ts';
import { htmlCompletions, eventDocumentation } from './html-service.ts';
import { cssCompletions } from './css-service.ts';
import { toGenerated, type RequestContext } from '../request.ts';

/** Payload attached to TS-sourced items so `resolveCompletion` can fill detail. */
export interface CompletionData
{
    virtualFile: string;
    generatedOffset: number;
    name: string;
    source?: string;
    tsData?: unknown;
}

/** Toggles for which completion sources contribute. All on by default. */
export interface CompletionOptions
{
    /** Suggest not-yet-imported symbols (and add the import on accept). */
    autoImports?: boolean;
    /** Expand built-in components to snippet bodies (`<For …>{…}</For>`). */
    componentSnippets?: boolean;
}

/** Produces completion items for the caret at `offset`. */
export function getCompletions(ctx: RequestContext, offset: number, options: CompletionOptions = {}): CompletionItem[]
{
    const context = classifyPosition(ctx.source, offset);

    const position = ctx.lineIndex.positionAt(offset);

    switch (context.kind)
    {
        case 'tagName':
            return tagCompletions(ctx, offset, options);

        case 'attributeName':
            return isComponentTag(context.tag)
                ? componentAttributeCompletions(ctx, offset, context.tag)
                // HTML attributes (with docs/value hints), minus the lowercase
                // `on*` events - AzerothJS binds camelCase handlers (`onClick`).
                // Fill in docs for common attributes the HTML dataset omits.
                : [
                    ...htmlCompletions(ctx.source, position)
                        .filter(i => !/^on[a-z]/.test(i.label))
                        .map(i => i.documentation ? i : { ...i, documentation: attributeDocumentation(i.label) }),
                    ...eventCompletions()
                ];

        case 'attributeValue':
            if (isComponentTag(context.tag))
            {
                return [];
            }
            // `style="…"` is CSS; everything else gets HTML value enums
            // (`type="text|email|…"`, booleans, …) from the HTML engine.
            return context.attribute === 'style'
                ? cssCompletions(ctx.source, offset)
                : htmlCompletions(ctx.source, position);

        case 'expression':
        case 'script':
        case 'text':
        {
            const items = tsCompletions(ctx, offset, options);
            // After a `<`, markup can begin even in plain expression position.
            if (ctx.source[offset - 1] === '<')
            {
                items.push(...tagCompletions(ctx, offset, options));
            }
            return items;
        }
    }
}

/** True for a component tag (PascalCase, dotted, or a known built-in). */
function isComponentTag(tag: string): boolean
{
    return /^[A-Z]/.test(tag) || tag.includes('.') || BUILTIN_COMPONENT_MAP.has(tag);
}

/**
 * Tag-position completion: HTML elements (from the HTML language service, with
 * MDN docs) plus the framework's built-in components and in-scope user
 * components.
 */
function tagCompletions(ctx: RequestContext, offset: number, options: CompletionOptions): CompletionItem[]
{
    const snippets = options.componentSnippets !== false;
    const items: CompletionItem[] = htmlCompletions(ctx.source, ctx.lineIndex.positionAt(offset));

    for (const component of BUILTIN_COMPONENTS)
    {
        const snippet = snippets ? BUILTIN_SNIPPETS[component.name] : undefined;
        items.push({
            label: component.name,
            kind: CompletionItemKind.Class,
            detail: component.detail,
            documentation: component.doc,
            insertText: snippet ?? component.name,
            insertTextFormat: snippet ? 2 : 1,
            sortText: `0_${ component.name }`
        });
    }

    // In-scope PascalCase value identifiers are likely user components; entries
    // that aren't yet imported carry a code action so resolve adds the import.
    const generatedOffset = mappedOrAnchor(ctx, offset);
    if (generatedOffset !== null)
    {
        for (const entry of rawTsEntries(ctx, generatedOffset))
        {
            if (isLikelyComponent(entry))
            {
                const autoImport = entry.source !== undefined || entry.hasAction === true;
                if (autoImport && options.autoImports === false)
                {
                    continue;
                }
                items.push({
                    label: entry.name,
                    kind: CompletionItemKind.Class,
                    detail: autoImport ? `component — import from ${ entry.source ?? 'module' }` : 'component',
                    sortText: `${ autoImport ? '2' : '1' }_${ entry.name }`,
                    data: completionData(ctx, generatedOffset, entry)
                });
            }
        }
    }

    return items;
}

/** Snippet bodies for the control-flow built-ins (the `<` is already typed). */
const BUILTIN_SNIPPETS: Record<string, string> = {
    Show: 'Show when={$1}>$0</Show>',
    For: 'For each={$1} key={$2}>{($3) => $0}</For>',
    Switch: 'Switch>\n\t<Match when={$1}>$0</Match>\n</Switch>',
    Match: 'Match when={$1}>$0</Match>',
    Suspense: 'Suspense on={[$1]} fallback={$2}>$0</Suspense>',
    Portal: 'Portal>$0</Portal>',
    ErrorBoundary: 'ErrorBoundary fallback={(err, reset) => $1}>$0</ErrorBoundary>',
    Transition: 'Transition when={$1}>$0</Transition>'
};

/**
 * Attribute completion for a component: prop names derived from the component's
 * actual props type (via TypeScript), falling back to the built-in table when
 * the type can't be resolved (e.g. the tag isn't fully formed yet). Plus events.
 */
function componentAttributeCompletions(ctx: RequestContext, offset: number, tag: string): CompletionItem[]
{
    const items = typedPropCompletions(ctx, offset);

    if (items.length === 0)
    {
        const builtin = BUILTIN_COMPONENT_MAP.get(tag);
        for (const prop of builtin?.props ?? [])
        {
            items.push({
                label: prop.name,
                kind: CompletionItemKind.Property,
                detail: `${ tag } prop${ prop.required ? ' (required)' : '' }`,
                documentation: prop.doc,
                insertText: `${ prop.name }={$0}`,
                insertTextFormat: 2 as const,
                sortText: `0_${ prop.name }`
            });
        }
    }

    items.push(...eventCompletions());
    return items;
}

/**
 * Props of the component whose opening tag holds the caret, read from its props
 * type. Works by querying TypeScript inside the generated `Tag({ … })` call's
 * object literal, where the expected properties are exactly the props.
 */
function typedPropCompletions(ctx: RequestContext, offset: number): CompletionItem[]
{
    const element = enclosingElement(ctx.source, offset);
    if (!element || !element.isComponent)
    {
        return [];
    }
    const generatedTag = ctx.virtual.mapping.toGenerated(element.start + 1);
    if (generatedTag === null)
    {
        return [];
    }
    const brace = ctx.virtual.code.indexOf('{', generatedTag + element.tag.length);
    if (brace === -1)
    {
        return [];
    }

    return rawTsEntries(ctx, brace + 1)
        .filter(entry => entry.kind === ts.ScriptElementKind.memberVariableElement && entry.name !== 'children')
        .map(entry => ({
            label: entry.name,
            kind: CompletionItemKind.Property,
            detail: 'prop',
            insertText: `${ entry.name }={$0}`,
            insertTextFormat: 2 as const,
            sortText: `0_${ entry.name }`,
            data: completionData(ctx, brace + 1, entry)
        }));
}

/** DOM event handler attributes (`on*`). */
function eventCompletions(): CompletionItem[]
{
    return DOM_EVENTS.map(name => ({
        label: name,
        kind: CompletionItemKind.Event,
        detail: 'DOM event handler',
        documentation: eventDocumentation(name),
        insertText: `${ name }={$0}`,
        insertTextFormat: 2 as const,
        sortText: `3_${ name }`
    }));
}

/** Full type-aware completion from TypeScript at the mapped offset. */
function tsCompletions(ctx: RequestContext, offset: number, options: CompletionOptions): CompletionItem[]
{
    const generatedOffset = mappedOrAnchor(ctx, offset);
    if (generatedOffset === null)
    {
        return [];
    }

    return rawTsEntries(ctx, generatedOffset)
        .filter(entry => options.autoImports !== false || entry.source === undefined)
        .map(entry => ({
            label: entry.name,
            kind: tsKindToCompletionKind(entry.kind),
            insertText: entry.insertText,
            sortText: entry.sortText,
            filterText: entry.filterText,
            data: completionData(ctx, generatedOffset, entry)
        }));
}

/** Raw TypeScript completion entries at a virtual-module offset. */
function rawTsEntries(ctx: RequestContext, generatedOffset: number): ts.CompletionEntry[]
{
    const completions = ctx.project.service.getCompletionsAtPosition(
        ctx.virtualFile,
        generatedOffset,
        { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true }
    );
    return completions?.entries ?? [];
}

/** Builds the lazy-resolve payload for a TS entry. */
function completionData(ctx: RequestContext, generatedOffset: number, entry: ts.CompletionEntry): CompletionData
{
    return {
        virtualFile: ctx.virtualFile,
        generatedOffset,
        name: entry.name,
        source: entry.source,
        tsData: entry.data
    };
}

/**
 * True when a completion entry looks like a user component: a PascalCase value
 * (class/function/const/alias) that isn't an ambient global and isn't already a
 * built-in we list explicitly.
 */
function isLikelyComponent(entry: ts.CompletionEntry): boolean
{
    if (!/^[A-Z]/.test(entry.name) || BUILTIN_COMPONENT_MAP.has(entry.name))
    {
        return false;
    }
    const modifiers = entry.kindModifiers?.split(',') ?? [];
    if (modifiers.includes(ts.ScriptElementKindModifier.ambientModifier))
    {
        return false;
    }
    return entry.kind === ts.ScriptElementKind.classElement
        || entry.kind === ts.ScriptElementKind.functionElement
        || entry.kind === ts.ScriptElementKind.alias
        || entry.kind === ts.ScriptElementKind.constElement
        || entry.kind === ts.ScriptElementKind.variableElement
        || entry.kind === ts.ScriptElementKind.letElement;
}

/**
 * The mapped offset, or - when the caret is in markup scaffolding - the nearest
 * mapped offset to its left, so TypeScript can still answer with in-scope names
 * (used for component suggestions in a half-typed tag).
 */
function mappedOrAnchor(ctx: RequestContext, offset: number): number | null
{
    for (let o = offset; o >= 0; o--)
    {
        const generated = toGenerated(ctx, o);
        if (generated !== null)
        {
            return generated;
        }
    }
    return null;
}

/** Maps a TS completion entry kind to an LSP CompletionItemKind. */
function tsKindToCompletionKind(kind: string): CompletionItemKindValue
{
    switch (kind)
    {
        case ts.ScriptElementKind.functionElement:
        case ts.ScriptElementKind.localFunctionElement:
            return CompletionItemKind.Function;
        case ts.ScriptElementKind.memberFunctionElement:
            return CompletionItemKind.Method;
        case ts.ScriptElementKind.memberVariableElement:
        case ts.ScriptElementKind.memberGetAccessorElement:
        case ts.ScriptElementKind.memberSetAccessorElement:
            return CompletionItemKind.Field;
        case ts.ScriptElementKind.classElement:
            return CompletionItemKind.Class;
        case ts.ScriptElementKind.interfaceElement:
            return CompletionItemKind.Interface;
        case ts.ScriptElementKind.enumElement:
            return CompletionItemKind.Enum;
        case ts.ScriptElementKind.enumMemberElement:
            return CompletionItemKind.Enum;
        case ts.ScriptElementKind.moduleElement:
            return CompletionItemKind.Module;
        case ts.ScriptElementKind.typeParameterElement:
            return CompletionItemKind.TypeParameter;
        case ts.ScriptElementKind.constElement:
            return CompletionItemKind.Constant;
        case ts.ScriptElementKind.variableElement:
        case ts.ScriptElementKind.letElement:
        case ts.ScriptElementKind.parameterElement:
            return CompletionItemKind.Variable;
        case ts.ScriptElementKind.keyword:
            return CompletionItemKind.Keyword;
        default:
            return CompletionItemKind.Text;
    }
}

/** Formatter settings TypeScript needs to render an auto-import edit. */
const RESOLVE_FORMAT_OPTIONS: ts.FormatCodeSettings = {
    indentSize: 4,
    tabSize: 4,
    convertTabsToSpaces: true,
    newLineCharacter: '\n',
    insertSpaceAfterCommaDelimiter: true,
    semicolons: ts.SemicolonPreference.Insert
};

/**
 * Fills in detail/documentation for a TS-sourced completion item lazily.
 *
 * @returns the same item augmented, or unchanged for markup items.
 */
export function resolveCompletion(ctx: RequestContext, item: CompletionItem): CompletionItem
{
    const data = item.data as CompletionData | undefined;
    if (!data || data.virtualFile !== ctx.virtualFile)
    {
        return item;
    }

    const details = ctx.project.service.getCompletionEntryDetails(
        data.virtualFile,
        data.generatedOffset,
        data.name,
        RESOLVE_FORMAT_OPTIONS,
        data.source,
        undefined,
        data.tsData as ts.CompletionEntryData | undefined
    );
    if (!details)
    {
        return item;
    }

    return {
        ...item,
        detail: ts.displayPartsToString(details.displayParts) || item.detail,
        documentation: ts.displayPartsToString(details.documentation) || item.documentation,
        // Auto-import: TS returns the import insertion as a code action; surface
        // it as additional edits, mapped back to the original document.
        additionalTextEdits: importEdits(ctx, details.codeActions) ?? item.additionalTextEdits
    };
}

/** Maps a completion's import code action to original-document text edits. */
function importEdits(ctx: RequestContext, actions: ts.CodeAction[] | undefined): CompletionItem['additionalTextEdits']
{
    if (!actions || actions.length === 0)
    {
        return undefined;
    }
    const edits: NonNullable<CompletionItem['additionalTextEdits']> = [];
    for (const action of actions)
    {
        for (const change of action.changes)
        {
            if (change.fileName !== ctx.virtualFile)
            {
                continue;
            }
            for (const textChange of change.textChanges)
            {
                const mapped = ctx.virtual.mapping.toOriginalRange(
                    textChange.span.start,
                    textChange.span.start + textChange.span.length
                );
                if (mapped === null)
                {
                    continue;
                }
                edits.push({ range: ctx.lineIndex.rangeAt(mapped.start, mapped.end), newText: textChange.newText });
            }
        }
    }
    return edits.length > 0 ? edits : undefined;
}
