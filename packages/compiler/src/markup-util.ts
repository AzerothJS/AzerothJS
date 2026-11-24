/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The small shared EMITTER helpers (codegen and the type projection consult them). Language
 * FACTS - the event namespace, content properties, factory props, builtins - live in
 * `azerothjs/semantics`, the one owner every backend imports; this module keeps only the
 * emission mechanics:
 *   - wrapDynamic   - the reactivity-shape heuristic (wrap a computed expression in a getter; leave a
 *                     bare getter / fn-literal / collection verbatim);
 *   - isFunctionLiteral / isBareReference / isLiteralValue - the expression-shape predicates the
 *                     reactive-wrapping heuristic is built from (shared by codegen, the IR lowerer, and
 *                     the type projection so all three classify `{expr}` identically);
 *   - loneFunctionChild - the child the IR lowerer passes through as a tag's children function
 *                     (shared with the diagnostics so the refusal matches the lowering);
 *   - withoutSpacing - the children of a one-element builtin once the same-line spacing beside its
 *                     child is dropped (shared with the diagnostics the same way);
 *   - quoteString   - string-literal quoting;
 *   - objectKey     - object-key quoting;
 *   - alreadyImports - whether a module already names-imports a symbol (used by both emitters before they
 *                     inject runtime imports);
 *   - walkComponentTags - walk a markup tree's component tags.
 *
 * All of these are compiler-internal EXCEPT {@link walkComponentTags}, which is re-exported from the
 * package index.
 */

import * as ts from 'typescript';
import { blankMarkupRegions } from './markup-parser.ts';
import { parseExpressionSlice } from './ts-slice.ts';
import type {
    MarkupChild,
    MarkupElement,
    MarkupExpression,
    MarkupFragment
} from './types.ts';

/**
 * Classify the whole expression. Looking only at its opening token makes a join,
 * index or immediately invoked function look like a value to pass through.
 */
function literalKind(code: string): 'callback' | 'thunk' | 'collection' | undefined
{
    const text = code.trim();
    // Most expressions are simple reads or calls. Avoid parsing those a second time.
    if (!/^[([{</]/.test(text) && !/^(?:async|function)\b/.test(text) && !text.includes('=>'))
    {
        return undefined;
    }
    const input = text.includes('<') ? blankMarkupRegions(text, 0, text.length) : text;
    const { sourceFile } = parseExpressionSlice(input, 0);
    const statement = sourceFile.statements[0];
    if (sourceFile.statements.length !== 1 || statement === undefined || !ts.isExpressionStatement(statement)
        || !ts.isParenthesizedExpression(statement.expression))
    {
        return undefined;
    }
    let expr = statement.expression.expression;
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)
        || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr))
    {
        expr = expr.expression;
    }
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr))
    {
        return expr.parameters.length > 0 ? 'callback' : 'thunk';
    }
    // Grouped collections have always requested a computed binding. Preserve that
    // spelling, including on an expression with an erased TypeScript assertion.
    if ((text.startsWith('[') && ts.isArrayLiteralExpression(expr))
        || (text.startsWith('{') && ts.isObjectLiteralExpression(expr)))
    {
        return 'collection';
    }
    return undefined;
}

/** True for a function value, including a render callback containing markup. */
export function isFunctionLiteral(code: string): boolean
{
    if (!code.includes('=>') && !/\bfunction\b/.test(code))
    {
        return false;
    }
    const kind = literalKind(code);
    return kind === 'callback' || kind === 'thunk';
}

/** A callback with parameters receives contextual types from its component. */
export function isRenderCallback(code: string): boolean
{
    return literalKind(code) === 'callback';
}

/** A comment-led hole can be a thunk inside a generated let= branch. */
export function isDirectFunctionChild(code: string): boolean
{
    return /^\s*\/(?:\*|\/)/.test(code) ? isRenderCallback(code) : isFunctionLiteral(code);
}

/** Whole function and bare collection values pass through to the runtime. */
export function isLiteralValue(code: string): boolean
{
    return literalKind(code) !== undefined;
}

/**
 * The child a component tag receives as its children function: the only child, when it is a
 * function literal. Whitespace text counts, so a same-line padded function is not lone.
 *
 * @example
 * ```ts
 * loneFunctionChild(parseMarkup('<Show>{ () => <p/> }</Show>', 0).node.children); // the expression
 * loneFunctionChild(parseMarkup('<Show> { () => <p/> } </Show>', 0).node.children); // undefined
 * ```
 */
export function loneFunctionChild(children: MarkupChild[]): MarkupExpression | undefined
{
    const only = children[0];
    return children.length === 1 && only?.kind === 'expression' && isDirectFunctionChild(only.code) ? only : undefined;
}

/**
 * `children` without the same-line spacing the parser marked. A character reference or a
 * non-ASCII space is text and stays.
 *
 * @example
 * ```ts
 * withoutSpacing(parseMarkup('<For> { () => <li/> } </For>', 0).node.children); // [the expression]
 * ```
 */
export function withoutSpacing(children: MarkupChild[]): MarkupChild[]
{
    return children.filter(child => !(child.kind === 'text' && child.spacing === true));
}

/**
 * True when `code` is a single bare identifier or dotted path (e.g. `draft`, `props.x`).
 *
 * @example
 * ```ts
 * isBareReference('props.value'); // true
 * isBareReference('a + b');       // false
 * ```
 */
export function isBareReference(code: string): boolean
{
    return /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(code.trim());
}

/**
 * Decides how a dynamic `{expr}` is emitted. Passed through verbatim when it's
 * already the right shape for the runtime:
 *   - an event handler,
 *   - a function literal (handler / render fn / key fn),
 *   - a bare reference (a signal getter, a component, props.x),
 *   - an array/object literal (e.g. `on={[res]}`, a props bag).
 * Everything else is a computed value, wrapped in a getter so h() (and
 * reactive props like `when`/`each`) stay fine-grained.
 *
 * @example
 * ```ts
 * wrapDynamic('a + b', false);   // '() => (a + b)' (computed -> wrapped)
 * wrapDynamic('count', false);   // 'count' (bare reference -> verbatim)
 * wrapDynamic('save()', true);   // 'save()' (event handler -> verbatim)
 * ```
 */
export function wrapDynamic(code: string, isEventHandler: boolean): string
{
    const compiled = code.trim();
    if (
        isEventHandler ||
        isBareReference(compiled) ||
        isLiteralValue(compiled)
    )
    {
        return compiled;
    }
    return `() => (${ compiled })`;
}

/**
 * Escape for every character that cannot appear RAW inside an emitted single-quoted literal. The four
 * line terminators are the load-bearing ones: a raw CR reaches the emitter from `<style>`/`<script>`
 * CDATA, a static attribute value, a folded constant, and `&#13;`, and a CRLF checkout puts one in
 * front of every newline - unescaped, each terminates the literal and the emitted module is a syntax
 * error attributed to the author's markup.
 */
const LITERAL_ESCAPES: Readonly<Record<string, string>> =
{
    '\\': '\\\\',
    '\'': '\\\'',
    '\n': '\\n',
    '\r': '\\r',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029'
};

/**
 * Escapes a literal string for emission inside single quotes.
 *
 * @example
 * ```ts
 * quoteString('a\'b'); // "'a\\'b'" (the inner quote is escaped)
 * ```
 */
export function quoteString(value: string): string
{
    return `'${ value.replace(/[\\'\n\r\u2028\u2029]/g, ch => LITERAL_ESCAPES[ch] ?? ch) }'`;
}

/**
 * Quotes an object key when it isn't a valid bare identifier.
 *
 * @example
 * ```ts
 * objectKey('class');   // 'class' (bare identifier, unquoted)
 * objectKey('data-id'); // "'data-id'" (hyphen -> quoted)
 * ```
 */
export function objectKey(name: string): string
{
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${ name }'`;
}

/**
 * True when the module source already names-imports `name` (so an emitter must not re-declare it when
 * injecting runtime imports). Shared by the runtime codegen and the type projection.
 *
 * @example
 * ```ts
 * alreadyImports("import { h } from 'x'", 'h'); // true
 * alreadyImports("import { h } from 'x'", 'Show'); // false
 * ```
 */
export function alreadyImports(source: string, name: string): boolean
{
    return new RegExp(`import\\s*\\{[^}]*\\b${ name }\\b[^}]*\\}\\s*from`).test(source);
}

/**
 * Visits the markup element tree (NOT expression holes) and calls `visit` with the tag of every
 * component (capitalised/dotted) element. Use it to discover which components/built-ins a markup tree
 * references - e.g. to drive auto-import. Expression holes are handled by the caller's own recursion.
 *
 * @param node - The markup element or fragment to walk.
 * @param visit - Called once per component tag encountered (in source order).
 * @returns Nothing; results are delivered through `visit`.
 * @example
 * ```ts
 * const { node } = parseMarkup('<Show><p>hi</p></Show>', 0);
 * const tags: string[] = [];
 * walkComponentTags(node, (tag) => tags.push(tag));
 * tags; // ['Show'] (the lowercase <p> host element is skipped)
 * ```
 */
export function walkComponentTags(node: MarkupElement | MarkupFragment, visit: (tag: string) => void): void
{
    if (node.kind === 'element' && node.isComponent)
    {
        visit(node.tag);
    }
    for (const child of node.children)
    {
        if (child.kind === 'element' || child.kind === 'fragment')
        {
            walkComponentTags(child, visit);
        }
    }
}
