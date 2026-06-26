/**
 * MODULE: compiler/ts-slice - slice parsing for the semantic pass
 *
 * The inner JS/TS of a component body is parsed by TypeScript, NOT a hand-written parser. This parses
 * ONE slice at a time (a declaration, an effect block, or a markup hole/attribute expression) rather
 * than projecting the whole body.
 *
 * `ts.createSourceFile` is parser-only (no Program, no type checker) and is error-tolerant: it never
 * throws on malformed input, returning a tree with error nodes instead. Each helper also returns
 * `mapPos`, which translates a position inside the parsed slice back to an offset in the original
 * source - a CONSTANT shift, because the slice is parsed verbatim or wrapped in a fixed-length prefix.
 *
 * @see {@link parseExpressionSlice}
 * @see {@link parseDeclarationSlice}
 * @internal Compiler analysis support; not part of the package's public API.
 */

import * as ts from 'typescript';

import type { StateDecl, DerivedDecl, DeferredDecl, ResourceDecl, StreamDecl, StoreDecl, SelectorDecl, FormDecl } from './ast.ts';

import { RUNTIME_FN, type FactoryKind } from './keyword-spec.ts';

/** A parsed slice plus the map from slice positions back to source offsets. */
export interface ParsedSlice
{
    /** The TypeScript AST of the slice (parser-only; may contain error nodes). */
    sourceFile: ts.SourceFile;

    /** Translates a position within the slice to an offset in the original source. */
    mapPos: (posInSlice: number) => number;
}

/** A parsed reactive declaration: the name and the TS nodes for its type/initializer. */
export interface ParsedDeclaration extends ParsedSlice
{
    /** The declared name, as TypeScript parsed it. */
    name: string;

    /** The type annotation node, when present (`state x: T = ...`). */
    type: ts.TypeNode | undefined;

    /** The initializer expression node, when present. */
    initializer: ts.Expression | undefined;
}

/** Common parse options - latest syntax, parent pointers on (so `getText` works). */
function parse(text: string): ts.SourceFile
{
    return ts.createSourceFile('azeroth-slice.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Parses a `.azeroth` expression slice (a markup hole or attribute value). The
 * code is wrapped in parentheses so a leading `{` is read as an object literal,
 * not a block.
 *
 * @param code - The raw expression source
 * @param codeStart - The offset of `code` in the original source
 * @returns The parsed slice (`(code)`) plus its slice->source position mapper
 * @internal
 *
 * @example
 * ```ts
 * const { sourceFile, mapPos } = parseExpressionSlice('count + 1', 10);
 * sourceFile.text; // '(count + 1)'
 * mapPos(1);       // 10 - the 'c' of 'count' (slice index 1) maps back to source
 * ```
 */
export function parseExpressionSlice(code: string, codeStart: number): ParsedSlice
{
    return {
        sourceFile: parse(`(${ code })`),
        // The wrapping '(' shifts the code one character right in the slice.
        mapPos: (p: number): number => codeStart + p - 1
    };
}

/**
 * Parses a statement-list slice (an `effect` block's interior).
 *
 * @param code - The raw statements source (block interior)
 * @param codeStart - The offset of `code` in the original source
 * @returns The parsed slice plus its slice->source position mapper
 * @internal
 *
 * @example
 * ```ts
 * const { mapPos } = parseStatementsSlice('log(n);', 5);
 * mapPos(0); // 5 - the slice starts at the source offset
 * ```
 */
export function parseStatementsSlice(code: string, codeStart: number): ParsedSlice
{
    return {
        sourceFile: parse(code),
        mapPos: (p: number): number => codeStart + p
    };
}

/**
 * Parses a reactive declaration (`state`/`derived`) by substituting the keyword
 * with an equal-length JS keyword (`state`->`let  `, `derived`->`const  `) so all
 * inner offsets are preserved, then letting TypeScript split the name, type, and
 * initializer. Returns null if the projection did not parse as a variable
 * statement.
 *
 * @param source - The original `.azeroth` source
 * @param decl - The declaration node (its `start..end` spans `keyword ... ;`)
 * @returns The parsed declaration (name/type/initializer + mappers), or null if it didn't parse as a variable statement
 * @internal
 *
 * @example
 * ```ts
 * // For `derived d = n * 2;` at some offset, TypeScript yields:
 * //   name === 'd', initializer is the `n * 2` expression node
 * ```
 */
export function parseDeclarationSlice(
    source: string,
    decl: StateDecl | DerivedDecl | DeferredDecl | ResourceDecl | StreamDecl | StoreDecl | SelectorDecl | FormDecl
): ParsedDeclaration | null
{
    // The kind IS the keyword text (`state`/`derived`/`deferred`/`resource`/`stream`/`store`/`selector`).
    // Equal-length replacements (`let`/`const` padded to the keyword's length) keep every following offset
    // identical, so the parsed name/type/initializer positions map straight back to the source.
    const keyword = decl.kind;
    // The replacement only exists to recover the name/type/initializer SPANS, so `let` vs `const` is
    // irrelevant - but it MUST be the keyword's length to keep offsets aligned. `const` (5) does not fit
    // `form` (4), so `form` uses `let` (padded to 4) like `state`; every other keyword is >= 5 chars.
    const replacement = (decl.kind === 'state' || decl.kind === 'form' ? 'let' : 'const').padEnd(keyword.length);
    // Slice the value part only - a trailing `with { ... }` options clause is not valid TS here, so it
    // is excluded (valueEnd sits just before `with`, or equals `end` when there is no clause).
    const raw = source.slice(decl.start, decl.valueEnd);
    const text = replacement + raw.slice(keyword.length);

    const sourceFile = parse(text);
    const mapPos = (p: number): number => decl.start + p;

    const statement = sourceFile.statements[0];
    if (statement === undefined || !ts.isVariableStatement(statement))
    {
        return null;
    }
    const declaration = statement.declarationList.declarations[0];
    if (declaration === undefined)
    {
        return null;
    }

    return {
        sourceFile,
        mapPos,
        name: declaration.name.getText(sourceFile),
        type: declaration.type,
        initializer: declaration.initializer
    };
}

/**
 * The field-key set of a `form NAME = { ...initial } ...` declaration: the property names of its
 * `initial` object literal. These are the names that read as `NAME.field` (rewritten to
 * `NAME.values().field`) and write via `NAME.field = v` / `bind:value={NAME.field}`. Returns an empty
 * array when the initial is not a plain object literal (the form then has no field sugar - access stays
 * explicit via `NAME.values()`).
 *
 * @internal
 */
export function formFieldKeys(source: string, decl: FormDecl): string[]
{
    const parsed = parseDeclarationSlice(source, decl);
    const init = parsed?.initializer;
    if (init === undefined || !ts.isObjectLiteralExpression(init))
    {
        return [];
    }
    const keys: string[] = [];
    for (const property of init.properties)
    {
        const name = property.name;
        if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)))
        {
            keys.push(name.text);
        }
    }
    return keys;
}

/**
 * Splits a factory `with { ... }` options object into its `source` property (the signal that drives a
 * `resource`/`stream` refetch) and the REST of the options. Returns each as TypeScript source TEXT - no
 * offset mapping, since a `source`/option expression is almost always a single signal read. `source` is
 * null when the clause has no `source` key; `rest` is null when nothing else remains.
 *
 * @param optionsText - The `with` clause's `{ ... }` object-literal text (braces included).
 * @returns `{ source, rest }` as source text (either may be null).
 * @internal
 */
function parseFactoryOptions(optionsText: string): { source: string | null; rest: string | null }
{
    const sf = parse(`const __o = ${ optionsText };`);
    const stmt = sf.statements[0];
    const init = stmt !== undefined && ts.isVariableStatement(stmt)
        ? stmt.declarationList.declarations[0]?.initializer
        : undefined;
    if (init === undefined || !ts.isObjectLiteralExpression(init))
    {
        // Not an object literal we can split (a malformed clause); keep it whole so nothing is dropped.
        return { source: null, rest: optionsText };
    }
    let sourceText: string | null = null;
    const rest: string[] = [];
    for (const prop of init.properties)
    {
        if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'source')
        {
            sourceText = prop.initializer.getText(sf);
        }
        else
        {
            rest.push(prop.getText(sf));
        }
    }
    return { source: sourceText, rest: rest.length > 0 ? `{ ${ rest.join(', ') } }` : null };
}

/**
 * True when a `store` initializer is ALREADY a function (an arrow or function expression), so it is passed
 * to `createStore` as-is; a bare object/value is wrapped in `() => (...)` instead. Shared by codegen and
 * the projection so both make the identical wrap decision.
 *
 * @param init - The parsed initializer node, or undefined when the declaration has none.
 * @returns True when `init` is a function the store factory can take directly.
 * @internal
 */
function isFactoryInitializer(init: ts.Node | undefined): boolean
{
    return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}

/**
 * The structural plan for emitting a factory keyword's `createX(...)` call - the ONE place that decides
 * argument shape, so codegen (runtime JS) and the projection (TS) build the identical call. It returns the
 * with-clause pieces as RAW text; each emitter renders the value itself and applies (codegen) or skips
 * (projection) the reactive rewrite on these pieces:
 *   - resource/stream: `fn([() => (source), ] value [, rest])` - `source` drives refetch, `rest` is the
 *     remaining stream options (resource ignores any rest);
 *   - selector: `fn(() => (value) [, opts])` - the value IS the source signal, the whole clause is options;
 *   - store: `fn(value)` when the value is already a factory function, else `fn(() => (value))`.
 *
 * @param kind - The factory keyword.
 * @param optsText - The `with { ... }` clause text (braces included), or null when absent.
 * @param initializer - The parsed value initializer node (used only for the store factory-vs-value check).
 * @returns The runtime fn name and the argument-shape decisions.
 * @internal
 */
export function factoryPlan(kind: FactoryKind, optsText: string | null, initializer: ts.Node | undefined): { fn: string; source: string | null; rest: string | null; opts: string | null; wrapValue: boolean }
{
    const fn = RUNTIME_FN[kind];
    if (kind === 'resource' || kind === 'stream')
    {
        const split = optsText !== null ? parseFactoryOptions(optsText) : { source: null, rest: null };
        return { fn, source: split.source, rest: kind === 'stream' ? split.rest : null, opts: null, wrapValue: false };
    }
    if (kind === 'selector')
    {
        return { fn, source: null, rest: null, opts: optsText, wrapValue: true };
    }
    // store: a bare object/value is wrapped in a factory arrow; an existing function is passed as-is.
    return { fn, source: null, rest: null, opts: null, wrapValue: !isFactoryInitializer(initializer) };
}

/** The structural split of a component parameter, recovered by the TypeScript parser. */
export interface ComponentParam
{
    /**
     * Absolute span of the TYPE annotation (the type after `:`), or null when the parameter is untyped.
     * Both a named interface (`props: ButtonProps`) and an inline object type (`props: { a?: X }`) land
     * here identically - it is just the TypeScript type node's range.
     */
    typeSpan: { start: number; end: number } | null;

    /**
     * Absolute span of the object-binding PATTERN (braces included) when the parameter destructures
     * (`{ a, b = d }: T`), or null when the parameter is a plain identifier (`props: T`).
     */
    patternSpan: { start: number; end: number } | null;
}

/** Wrapper around the parameter so its node offsets are a fixed shift from the source. */
const PARAM_WRAPPER_PREFIX = 'function __c(';

/**
 * Splits a component parameter into its TYPE annotation and (when it destructures) its binding PATTERN,
 * using the real TypeScript parser rather than any Azeroth-specific rules. The parameter is wrapped as
 * `function __c(<param>){}` and the first parameter's `name`/`type` nodes are read back; their offsets,
 * shifted by the (constant) wrapper prefix and `base`, are returned as ABSOLUTE source spans so callers
 * can `copy()` them with mapping. Every standard parameter form is handled uniformly: `props: T`,
 * `{ a, b = d }: T`, an inline object type in place of `T`, and an untyped or empty parameter (null spans).
 *
 * @param paramText - The verbatim parameter text (the trimmed interior of the signature's `( )`).
 * @param base - The absolute source offset of `paramText[0]`.
 * @returns The type span and, for a destructuring binding, the pattern span (both absolute, or null).
 * @internal
 */
export function parseComponentParam(paramText: string, base: number): ComponentParam
{
    if (paramText.trim() === '')
    {
        return { typeSpan: null, patternSpan: null };
    }
    const sf = parse(`${ PARAM_WRAPPER_PREFIX }${ paramText }){}`);
    const stmt = sf.statements[0];
    const param = stmt !== undefined && ts.isFunctionDeclaration(stmt) ? stmt.parameters[0] : undefined;
    if (param === undefined)
    {
        return { typeSpan: null, patternSpan: null };
    }
    const shift = base - PARAM_WRAPPER_PREFIX.length;
    const typeSpan = param.type !== undefined
        ? { start: param.type.getStart(sf) + shift, end: param.type.getEnd() + shift }
        : null;
    const patternSpan = ts.isObjectBindingPattern(param.name)
        ? { start: param.name.getStart(sf) + shift, end: param.name.getEnd() + shift }
        : null;
    return { typeSpan, patternSpan };
}

/**
 * Parses a `component Name({ ... }: P)` destructuring pattern into the reactive PROP ALIASES it
 * introduces: each local binding name maps to the expression a bare read of it lowers to - `props.<prop>`,
 * or `(props.<prop> ?? <default>)` for a defaulted binding. A rename `{ orig: local }` maps `local` ->
 * `props.orig`. Rest elements (`...rest`), nested patterns, computed keys, and non-identifier prop names
 * are skipped (not aliased) so they degrade rather than mis-lower.
 *
 * @param patternText - The `{ ... }` object-binding-pattern text (braces included).
 * @returns A map of local binding name -> the replacement expression.
 * @internal
 */
export function parsePropsPattern(patternText: string): Map<string, string>
{
    const aliases = new Map<string, string>();
    const sf = parse(`const ${ patternText } = __props;`);
    const stmt = sf.statements[0];
    const decl = stmt !== undefined && ts.isVariableStatement(stmt)
        ? stmt.declarationList.declarations[0]
        : undefined;
    if (decl === undefined || decl.name === undefined || !ts.isObjectBindingPattern(decl.name))
    {
        return aliases;
    }
    for (const element of decl.name.elements)
    {
        // Only simple `name` / `prop: name` / `name = default` bindings alias; rest/nested/computed do not.
        if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name))
        {
            continue;
        }
        const local = element.name.text;
        let prop = local;
        if (element.propertyName !== undefined)
        {
            if (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName) || ts.isNumericLiteral(element.propertyName))
            {
                prop = element.propertyName.text;
            }
            else
            {
                continue; // computed property name - cannot statically resolve the prop
            }
        }
        if (!/^[A-Za-z_$][\w$]*$/.test(prop))
        {
            continue; // non-identifier prop key - skip rather than emit invalid `props.<key>`
        }
        const read = `props.${ prop }`;
        const def = element.initializer !== undefined ? element.initializer.getText(sf) : null;
        aliases.set(local, def !== null ? `(${ read } ?? ${ def })` : read);
    }
    return aliases;
}
