// Documentation extraction. Renders a GitHub-flavoured markdown
// API reference for the component a `.azeroth` file exports, read from the file's
// REAL TypeScript types: the same engine hover/symbols query. We resolve the
// exported component symbol in the file's virtual module, take the first
// parameter of its call signature (the props object), and enumerate that type's
// properties - so the table's names, types, optionality, and per-prop summaries
// are whatever the compiler actually sees, not a re-parse of the source.
//
// Every step is best-effort: a missing program, an un-typed component, or a
// props parameter that isn't an object simply yields a thinner doc. Nothing here
// throws - a documentation pass over a half-typed file must degrade, not crash.

import ts from 'typescript';
import { AzerothLanguageService } from './service.ts';
import { toVirtualFile } from './ts-project.ts';
import { uriToPath } from './uri.ts';

/** One row of the rendered **Props** table. */
export interface PropDoc
{
    name: string;
    type: string;
    optional: boolean;
    /** First-paragraph JSDoc summary for the prop, or '' when undocumented. */
    summary: string;
}

/** The extracted shape a `.azeroth` component exposes, before rendering. */
export interface ComponentDoc
{
    name: string;
    /** The component's own JSDoc/doc comment, or '' when undocumented. */
    summary: string;
    props: PropDoc[];
    /** False when the component declares no props parameter at all. */
    hasProps: boolean;
}

/**
 * Renders a markdown API reference for the component exported by `uri`. Returns
 * a best-effort document (at minimum a heading) and never throws.
 */
export function generateComponentDocs(service: AzerothLanguageService, uri: string): string
{
    let doc: ComponentDoc | null;
    try
    {
        doc = extractComponentDoc(service, uri);
    }
    catch
    {
        // A documentation pass must never break the caller; fall back below.
        doc = null;
    }
    return render(doc ?? { name: fallbackName(uri), summary: '', props: [], hasProps: false });
}

/**
 * Reaches the TypeScript program behind the service and extracts the exported
 * component's doc shape, or null when the file/program can't be resolved.
 */
function extractComponentDoc(service: AzerothLanguageService, uri: string): ComponentDoc | null
{
    const program = service.getProgram();
    if (!program)
    {
        return null;
    }

    const virtualFile = toVirtualFile(uriToPath(uri));
    const sourceFile = findSourceFile(program, virtualFile);
    if (!sourceFile)
    {
        return null;
    }

    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol)
    {
        return null;
    }

    const component = resolveComponentSymbol(checker, moduleSymbol);
    if (!component)
    {
        return null;
    }

    const name = component.exportName ?? component.symbol.getName();
    const summary = ts.displayPartsToString(component.symbol.getDocumentationComment(checker));
    const propsType = componentPropsType(checker, component.symbol);

    if (propsType === null)
    {
        return { name, summary, props: [], hasProps: false };
    }

    return { name, summary, props: propRows(checker, propsType), hasProps: true };
}

/** The exported component symbol plus the name it was exported under. */
interface ResolvedComponent
{
    symbol: ts.Symbol;
    /** 'default' export reports the declared name; a named export keeps its key. */
    exportName?: string;
}

/**
 * Picks the component to document from a module's exports: the default export
 * first (the convention for `.azeroth` components), then the first
 * PascalCase-named function/variable export. Aliases are followed to the real
 * declaration so its type and JSDoc resolve.
 */
function resolveComponentSymbol(checker: ts.TypeChecker, moduleSymbol: ts.Symbol): ResolvedComponent | null
{
    const exports = checker.getExportsOfModule(moduleSymbol);

    const defaultExport = exports.find(symbol => symbol.getName() === 'default');
    if (defaultExport)
    {
        const resolved = unalias(checker, defaultExport);
        return { symbol: resolved, exportName: declaredName(resolved) ?? 'default' };
    }

    for (const symbol of exports)
    {
        const resolved = unalias(checker, symbol);
        if (/^[A-Z]/.test(symbol.getName()) && isCallable(checker, resolved))
        {
            return { symbol: resolved, exportName: symbol.getName() };
        }
    }

    return null;
}

/**
 * The author-given name of a default-exported component. The export key is
 * `default`, so the readable heading comes from the declaration's own
 * identifier (`export default function Greeting` -> `Greeting`); an anonymous
 * default export has none.
 */
function declaredName(symbol: ts.Symbol): string | undefined
{
    const named = symbol.getName();
    if (named && named !== 'default')
    {
        return named;
    }
    for (const declaration of symbol.declarations ?? [])
    {
        const identifier = (declaration as { name?: ts.Node }).name;
        if (identifier && ts.isIdentifier(identifier))
        {
            return identifier.text;
        }
    }
    return undefined;
}

/** Resolves an export alias to the symbol it points at, leaving others as-is. */
function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol
{
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** True when the symbol's type has at least one call signature. */
function isCallable(checker: ts.TypeChecker, symbol: ts.Symbol): boolean
{
    const type = symbolType(checker, symbol);
    return type !== null && type.getCallSignatures().length > 0;
}

/**
 * The component's props type - the first parameter of its call signature - or
 * null when the component is parameterless (a no-props component) or isn't a
 * function at all.
 */
function componentPropsType(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | null
{
    const type = symbolType(checker, symbol);
    if (type === null)
    {
        return null;
    }
    const signature = type.getCallSignatures()[0];
    if (!signature)
    {
        return null;
    }
    const parameter = signature.getParameters()[0];
    if (!parameter)
    {
        return null;
    }
    return checker.getTypeOfSymbolAtLocation(parameter, declarationOf(parameter));
}

/** One table row per apparent property of the props type. */
function propRows(checker: ts.TypeChecker, propsType: ts.Type): PropDoc[]
{
    return checker.getApparentType(propsType).getProperties().map(member =>
    {
        const declaration = declarationOf(member);
        const memberType = checker.getTypeOfSymbolAtLocation(member, declaration);
        return {
            name: member.getName(),
            type: checker.typeToString(memberType),
            optional: (member.getFlags() & ts.SymbolFlags.Optional) !== 0,
            summary: ts.displayPartsToString(member.getDocumentationComment(checker))
        };
    });
}

/** The type of a symbol at its declaration, or null when it has none. */
function symbolType(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | null
{
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    return declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : null;
}

/**
 * A declaration node to anchor a `getTypeOfSymbolAtLocation` query. The checker
 * tolerates a best-effort node for synthetic members; the source file is a safe
 * fallback when a symbol carries no declaration of its own.
 */
function declarationOf(symbol: ts.Symbol): ts.Node
{
    return symbol.valueDeclaration ?? symbol.declarations?.[0] ?? (undefined as unknown as ts.Node);
}

/** Locates the virtual source file by name, tolerant of path normalization. */
function findSourceFile(program: ts.Program, virtualFile: string): ts.SourceFile | undefined
{
    const direct = program.getSourceFile(virtualFile);
    if (direct)
    {
        return direct;
    }
    const target = virtualFile.replace(/\\/g, '/');
    return program.getSourceFiles().find(file => file.fileName.replace(/\\/g, '/') === target);
}

/** A heading name derived from the file when no component can be resolved. */
function fallbackName(uri: string): string
{
    const base = uriToPath(uri).replace(/\\/g, '/').split('/').pop() ?? 'Component';
    return base.replace(/\.azeroth$/, '') || 'Component';
}

/** Renders the extracted doc as GitHub-flavoured markdown. */
function render(doc: ComponentDoc): string
{
    const lines: string[] = [`# ${ doc.name }`];

    if (doc.summary)
    {
        lines.push('', doc.summary);
    }

    lines.push('', '## Props');

    // Either a component with no declared props, or one whose props type resolved
    // to no members - both render the same "no props" note.
    if (!doc.hasProps || doc.props.length === 0)
    {
        lines.push('', 'This component takes no props.');
        return lines.join('\n') + '\n';
    }

    lines.push(
        '',
        '| Name | Type | Optional | Description |',
        '| --- | --- | --- | --- |'
    );
    for (const prop of doc.props)
    {
        lines.push(`| ${ prop.name } | ${ cell(prop.type) } | ${ prop.optional ? 'Yes' : 'No' } | ${ cell(prop.summary) } |`);
    }

    return lines.join('\n') + '\n';
}

/** Escapes a value for a one-line markdown table cell. */
function cell(value: string): string
{
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '-';
}
