// Hover, routed by caret context:
//   - expression / script / text -> TypeScript quick-info at the mapped offset
//     (authoritative signatures + JSDoc, full type inference);
//   - a built-in component tag/prop -> the framework's documentation table;
//   - a user component tag -> TypeScript quick-info (the tag is mapped 1:1);
//   - a host element tag/attribute/value -> the HTML language service's
//     MDN-backed hover.
//
// Context is decided first (not the offset map) so a host tag never shows a
// stray TS result even when the surrounding markup is mid-edit.

import ts from 'typescript';
import { skipBalanced, skipString, skipTemplate, isWhitespace, isIdentPart } from '@azerothjs/compiler';
import type { Hover, Range } from '../protocol.ts';
import { classifyPosition, enclosingElement } from '../markup-model.ts';
import { BUILTIN_COMPONENT_MAP, attributeDocumentation, type BuiltinComponent } from '../language-data.ts';
import { htmlHover, eventDocumentation } from './html-service.ts';
import { cssHover, cssTemplateHover, inCssTemplate } from './css-service.ts';
import { spanToRange, toGenerated, type RequestContext } from '../request.ts';

/** Hover content for the caret at `offset`, or null. */
export function getHover(ctx: RequestContext, offset: number): Hover | null
{
    const context = classifyPosition(ctx.source, offset);
    const position = ctx.lineIndex.positionAt(offset);

    switch (context.kind)
    {
        case 'expression':
        case 'script':
        case 'text':
            // Inside a css`` template the content is an opaque string to
            // TypeScript; the CSS engine has the docs.
            if (inCssTemplate(ctx.source, offset))
            {
                return cssTemplateHover(ctx.source, offset, ctx.lineIndex);
            }
            return tsHover(ctx, offset);

        case 'tagName':
        {
            const name = fullTagName(ctx, offset);
            const builtin = BUILTIN_COMPONENT_MAP.get(name);
            if (builtin)
            {
                return builtinHover(ctx, offset, builtin);
            }
            if (isComponentName(name))
            {
                // A user component: render its JSDoc + props table from the real
                // TS types, falling back to plain quick-info when unresolvable.
                return userComponentHover(ctx, offset, name) ?? tsHover(ctx, offset);
            }
            return htmlHover(ctx.source, position);
        }

        case 'attributeName':
        {
            const attribute = fullAttributeName(ctx, offset);

            // Component prop: read its type/JSDoc from the component's props
            // type, falling back to the built-in table.
            if (isComponentName(context.tag) || BUILTIN_COMPONENT_MAP.has(context.tag))
            {
                const typed = typedPropHover(ctx, offset, attribute);
                if (typed)
                {
                    return typed;
                }
                const prop = BUILTIN_COMPONENT_MAP.get(context.tag)?.props.find(candidate => candidate.name === attribute);
                return prop
                    ? { contents: `**${ prop.name }** - \`<${ context.tag }>\` prop${ prop.required ? ' (required)' : '' }\n\n${ prop.doc }` }
                    : null;
            }

            // AzerothJS binds camelCase events; the HTML engine only knows the
            // lowercase form, so look its MDN docs up explicitly.
            if (/^on[A-Z]/.test(attribute))
            {
                const doc = eventDocumentation(attribute);
                return { contents: `**${ attribute }** - DOM event handler${ doc ? `\n\n${ doc }` : '' }` };
            }
            // The HTML engine first; fall back to our docs for the common
            // element attributes the standard dataset leaves undocumented.
            const html = htmlHover(ctx.source, position);
            if (html)
            {
                return html;
            }
            const fallback = attributeDocumentation(attribute);
            return fallback ? { contents: `**${ attribute }** - attribute\n\n${ fallback }` } : null;
        }

        case 'attributeValue':
            if (isComponentName(context.tag))
            {
                return null;
            }
            return context.attribute === 'style'
                ? cssHover(ctx.source, offset, ctx.lineIndex)
                : htmlHover(ctx.source, position);
    }
}

/**
 * Rich hover for a built-in component tag, assembled from its language-data
 * entry: a bold signature line, the doc paragraph, and a fenced `azeroth` usage
 * example (the entry's `detail` already carries the canonical call shape). The
 * range is mapped to the tag name so the editor highlights just the `<Show`.
 */
function builtinHover(ctx: RequestContext, offset: number, builtin: BuiltinComponent): Hover
{
    const contents = [
        `**<${ builtin.name }>** - built-in component`,
        `\`${ builtin.detail }\``,
        builtin.doc,
        '```azeroth\n' + builtin.detail + '\n```'
    ].join('\n\n');
    return { contents, range: tagNameRange(ctx, offset) };
}

/**
 * Rich hover for a user component tag, assembled from its REAL TypeScript types:
 * a bold `**<Name>**` line, the component's own JSDoc, and a Props table (name /
 * type / optional) read off the first call-signature parameter - the same way
 * docgen renders its reference. Null when the component or its type can't be
 * resolved, so the caller can fall back to plain quick-info. The range is mapped
 * to the tag name so the editor highlights just the `<Card`.
 */
function userComponentHover(ctx: RequestContext, offset: number, name: string): Hover | null
{
    const element = enclosingElement(ctx.source, offset);
    if (!element || !element.isComponent)
    {
        return null;
    }
    const generatedTag = ctx.virtual.mapping.toGenerated(element.start + 1);
    if (generatedTag === null)
    {
        return null;
    }

    const program = ctx.project.service.getProgram();
    const sourceFile = program?.getSourceFile(ctx.virtualFile);
    if (!program || !sourceFile)
    {
        return null;
    }
    const checker = program.getTypeChecker();
    const token = tokenAt(sourceFile, generatedTag);
    if (!token)
    {
        return null;
    }

    const type = checker.getTypeAtLocation(token);
    const signature = type.getCallSignatures()[0];
    if (!signature)
    {
        return null;
    }

    const contents = [`**<${ name }>** - component`];
    const symbol = checker.getSymbolAtLocation(token);
    const doc = symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)) : '';
    if (doc)
    {
        contents.push(doc);
    }
    contents.push(propsTable(checker, signature, token));

    return { contents: contents.join('\n\n'), range: tagNameRange(ctx, offset) };
}

/**
 * Markdown Props table for a component's call signature: one row per apparent
 * property of its first parameter (the props object), each with the checker's
 * `typeToString` and an optional marker. The `children` prop is dropped (it's
 * supplied by nesting, not as an attribute). Returns 'No props.' when the
 * component takes none.
 */
function propsTable(checker: ts.TypeChecker, signature: ts.Signature, location: ts.Node): string
{
    const parameter = signature.getParameters()[0];
    const propsType = parameter ? checker.getTypeOfSymbolAtLocation(parameter, location) : null;
    const members = propsType
        ? checker.getApparentType(propsType).getProperties().filter(member => member.getName() !== 'children')
        : [];
    if (members.length === 0)
    {
        return 'No props.';
    }

    const rows = ['| Prop | Type | Optional |', '| --- | --- | --- |'];
    for (const member of members)
    {
        const memberType = checker.getTypeOfSymbolAtLocation(member, location);
        const optional = (member.getFlags() & ts.SymbolFlags.Optional) !== 0;
        rows.push(`| ${ member.getName() } | \`${ cell(checker.typeToString(memberType)) }\` | ${ optional ? 'Yes' : 'No' } |`);
    }
    return rows.join('\n');
}

/** The TS node whose span contains `pos` (deepest), for a checker query. */
function tokenAt(sourceFile: ts.SourceFile, pos: number): ts.Node | undefined
{
    const find = (node: ts.Node): ts.Node | undefined =>
    {
        if (pos < node.getStart(sourceFile) || pos >= node.getEnd())
        {
            return undefined;
        }
        return ts.forEachChild(node, find) ?? node;
    };
    return find(sourceFile);
}

/** Escapes a value for a one-line markdown table cell. */
function cell(value: string): string
{
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** Source range of the tag name under the caret (the `Show` in `<Show ...>`). */
function tagNameRange(ctx: RequestContext, offset: number): Range | undefined
{
    let start = offset;
    while (start > 0 && /[A-Za-z0-9_$.-]/.test(ctx.source[start - 1]) && ctx.source[start - 1] !== '<')
    {
        start--;
    }
    let end = offset;
    while (end < ctx.source.length && /[A-Za-z0-9_$.-]/.test(ctx.source[end]))
    {
        end++;
    }
    return ctx.lineIndex.rangeAt(start, end);
}

/**
 * Hover for a component prop, read from the component's props type (the same
 * generated `Tag({ ... })` object literal completion uses). Null when the type
 * can't be resolved.
 */
function typedPropHover(ctx: RequestContext, offset: number, prop: string): Hover | null
{
    const element = enclosingElement(ctx.source, offset);
    if (!element || !element.isComponent)
    {
        return null;
    }
    const generatedTag = ctx.virtual.mapping.toGenerated(element.start + 1);
    if (generatedTag === null)
    {
        return null;
    }
    const brace = ctx.virtual.code.indexOf('{', generatedTag + element.tag.length);
    if (brace === -1)
    {
        return null;
    }
    // Query the type at the generated property key (works whether or not other
    // props are present, unlike completion details which skip filled props).
    const key = propertyKeyOffset(ctx.virtual.code, brace, prop);
    if (key === -1)
    {
        return null;
    }
    const info = ctx.project.service.getQuickInfoAtPosition(ctx.virtualFile, key);
    if (!info)
    {
        return null;
    }
    const signature = ts.displayPartsToString(info.displayParts);
    const doc = ts.displayPartsToString(info.documentation);
    if (!signature && !doc)
    {
        return null;
    }
    return { contents: '```typescript\n' + signature + '\n```' + (doc ? `\n\n${ doc }` : '') };
}

/**
 * Finds the offset of `prop`'s key inside the generated object literal that
 * starts at `brace`, skipping over each entry's value (which may contain
 * commas, braces, strings). Returns -1 if not present.
 */
function propertyKeyOffset(code: string, brace: number, prop: string): number
{
    let i = brace + 1;
    while (i < code.length)
    {
        while (i < code.length && isWhitespace(code[i]))
        {
            i++;
        }
        if (code[i] === '}' || i >= code.length)
        {
            return -1;
        }
        const keyStart = i;
        while (i < code.length && isIdentPart(code[i]))
        {
            i++;
        }
        if (code.slice(keyStart, i) === prop)
        {
            return keyStart;
        }
        while (i < code.length && code[i] !== ':' && code[i] !== ',' && code[i] !== '}')
        {
            i++;
        }
        if (code[i] !== ':')
        {
            // A spread (`...x`) or malformed entry; advance to the next one.
            i = skipEntryValue(code, i);
            continue;
        }
        i = skipEntryValue(code, i + 1);
    }
    return -1;
}

/** Skips an object-literal entry's value, stopping at a top-level `,` or `}`. */
function skipEntryValue(code: string, start: number): number
{
    let i = start;
    while (i < code.length)
    {
        const ch = code[i];
        if (ch === ',')
        {
            return i + 1;
        }
        if (ch === '}')
        {
            return i;
        }
        if (ch === '"' || ch === '\'')
        {
            i = skipString(code, i);
            continue;
        }
        if (ch === '`')
        {
            i = skipTemplate(code, i);
            continue;
        }
        if (ch === '{' || ch === '(' || ch === '[')
        {
            i = skipBalanced(code, i);
            continue;
        }
        i++;
    }
    return i;
}

/** TypeScript quick-info at the mapped offset. */
function tsHover(ctx: RequestContext, offset: number): Hover | null
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return null;
    }
    const info = ctx.project.service.getQuickInfoAtPosition(ctx.virtualFile, generated);
    if (!info)
    {
        return null;
    }
    const signature = ts.displayPartsToString(info.displayParts);
    const doc = ts.displayPartsToString(info.documentation);
    const contents = '```typescript\n' + signature + '\n```' + (doc ? `\n\n${ doc }` : '');
    return { contents, range: spanToRange(ctx, info.textSpan) ?? undefined };
}

/** True for a component tag name (PascalCase or dotted). */
function isComponentName(name: string): boolean
{
    return /^[A-Z]/.test(name) || name.includes('.');
}

/** The full tag name under the caret (the model only knows the typed prefix). */
function fullTagName(ctx: RequestContext, offset: number): string
{
    let start = offset;
    while (start > 0 && /[A-Za-z0-9_$.-]/.test(ctx.source[start - 1]) && ctx.source[start - 1] !== '<')
    {
        start--;
    }
    let end = offset;
    while (end < ctx.source.length && /[A-Za-z0-9_$.-]/.test(ctx.source[end]))
    {
        end++;
    }
    return ctx.source.slice(start, end);
}

/** The full attribute name under the caret. */
function fullAttributeName(ctx: RequestContext, offset: number): string
{
    let start = offset;
    while (start > 0 && /[A-Za-z0-9_$:-]/.test(ctx.source[start - 1]))
    {
        start--;
    }
    let end = offset;
    while (end < ctx.source.length && /[A-Za-z0-9_$:-]/.test(ctx.source[end]))
    {
        end++;
    }
    return ctx.source.slice(start, end);
}
