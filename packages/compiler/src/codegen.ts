// Turns a markup AST node into an h() (or component-call) source string. The
// reactivity rule for how each expression is emitted:
//
//   - Event handlers (on*): passed through verbatim.
//   - Function / bare-identifier expressions: passed through verbatim - they
//     are already a getter, handler, or component reference.
//   - Any other dynamic expression: wrapped as `() => (expr)` so h() treats it
//     as reactive.
//   - Static "string" attributes: kept as string literals.
//
// Expression holes can contain nested markup; we recompile their source via
// the `compileExpression` callback the caller passes in (which loops back to
// compile.ts), so `{cond && <p/>}` works.

import type {
    MarkupElement,
    MarkupFragment,
    MarkupChild,
    MarkupAttribute
} from './types.ts';

/**
 * Recompiles arbitrary JS that may contain nested markup.
 *
 * @example
 * ```ts
 * // The identity compiler leaves plain expressions untouched.
 * const identity: ExpressionCompiler = (code) => code;
 * identity('count()'); // 'count()'
 * ```
 */
export type ExpressionCompiler = (code: string) => string;

/**
 * True when `code` is an arrow/function literal - pass it through unwrapped.
 *
 * @example
 * ```ts
 * isFunctionLiteral('(item) => item.name'); // true
 * isFunctionLiteral('count() + 1');         // false
 * ```
 */
function isFunctionLiteral(code: string): boolean
{
    const t = code.trim();
    if (/^async\s+function\b/.test(t) || /^function\b/.test(t))
    {
        return true;
    }
    // Arrow: `x => ...`, `(...) => ...`, `async x => ...`, `async (...) => ...`.
    return /^(async\s+)?(\([^]*?\)|[A-Za-z_$][\w$]*)\s*=>/.test(t);
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
function isBareReference(code: string): boolean
{
    return /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(code.trim());
}

/**
 * True when `code` is an array or object literal (`[...]` / `{...}`).
 *
 * @example
 * ```ts
 * isCollectionLiteral('[resource]'); // true
 * isCollectionLiteral('count()');    // false
 * ```
 */
function isCollectionLiteral(code: string): boolean
{
    const t = code.trim();
    return t.startsWith('[') || t.startsWith('{');
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
function wrapDynamic(code: string, isEventHandler: boolean): string
{
    const compiled = code.trim();
    if (
        isEventHandler ||
        isFunctionLiteral(compiled) ||
        isBareReference(compiled) ||
        isCollectionLiteral(compiled)
    )
    {
        return compiled;
    }
    return `() => (${ compiled })`;
}

/**
 * Quotes an object key when it isn't a valid bare identifier.
 *
 * @example
 * ```ts
 * objectKey('class');     // 'class' (bare identifier, unquoted)
 * objectKey('data-id');   // "'data-id'" (hyphen -> quoted)
 * ```
 */
function objectKey(name: string): string
{
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${ name }'`;
}

/**
 * True for an `on*` event attribute name (`on` + uppercase letter).
 *
 * @example
 * ```ts
 * isEventName('onClick'); // true
 * isEventName('online');  // false (third char is lowercase)
 * ```
 */
function isEventName(name: string): boolean
{
    return name.length > 2 && name.startsWith('on') && name[2] === name[2].toUpperCase();
}

/**
 * Escapes a literal string for emission inside single quotes.
 *
 * @example
 * ```ts
 * quoteString('a\'b'); // "'a\\'b'" (the inner quote is escaped)
 * ```
 */
function quoteString(value: string): string
{
    return `'${ value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\n/g, '\\n') }'`;
}

/**
 * Emits one attribute as a `key: value` entry (or a spread).
 *
 * @example
 * ```ts
 * const id = (code: string) => code;
 * generateAttribute(
 *     { kind: 'attribute', name: 'id', value: { kind: 'static', value: 'app' }, spread: false },
 *     id
 * );
 * // "id: 'app'"
 * ```
 */
function generateAttribute(attr: MarkupAttribute, compileExpression: ExpressionCompiler): string
{
    if (attr.spread)
    {
        return `...${ compileExpression((attr.value as { code: string }).code) }`;
    }

    const name = attr.name as string;
    const key = objectKey(name);

    if (attr.value.kind === 'none')
    {
        return `${ key }: true`;
    }
    if (attr.value.kind === 'static')
    {
        return `${ key }: ${ quoteString(attr.value.value) }`;
    }
    // Expression value.
    const compiled = compileExpression(attr.value.code);
    return `${ key }: ${ wrapDynamic(compiled, isEventName(name)) }`;
}

/**
 * Builds the props object literal for an element/component.
 *
 * @example
 * ```ts
 * const id = (code: string) => code;
 * generateProps(
 *     [{ kind: 'attribute', name: 'id', value: { kind: 'static', value: 'app' }, spread: false }],
 *     id
 * );
 * // "{ id: 'app' }"
 * ```
 */
function generateProps(attrs: MarkupAttribute[], compileExpression: ExpressionCompiler, extra?: string): string
{
    const parts = attrs.map(a => generateAttribute(a, compileExpression));
    if (extra)
    {
        parts.push(extra);
    }
    return `{ ${ parts.join(', ') } }`;
}

/**
 * Emits a single child as an argument to h() / an array element.
 *
 * @example
 * ```ts
 * const id = (code: string) => code;
 * generateChild({ kind: 'text', value: 'Hi', start: 0, end: 2 }, id); // "'Hi'"
 * generateChild({ kind: 'expression', code: 'a + b', start: 0, end: 5 }, id); // '() => (a + b)'
 * ```
 */
function generateChild(child: MarkupChild, compileExpression: ExpressionCompiler): string
{
    if (child.kind === 'text')
    {
        return quoteString(child.value);
    }
    if (child.kind === 'expression')
    {
        const compiled = compileExpression(child.code);
        return wrapDynamic(compiled, false);
    }
    return generate(child, compileExpression);
}

/**
 * Generates the `children` entry for a component from its markup children. A
 * lone function-hole child becomes the function itself (e.g.
 * `<For>{(item) => ...}</For>`); anything else becomes a thunk returning the
 * child (or an array of children).
 *
 * @example
 * ```ts
 * const id = (code: string) => code;
 * // A lone function hole becomes the render function itself.
 * generateComponentChildren([{ kind: 'expression', code: '(x) => x', start: 0, end: 8 }], id);
 * // 'children: (x) => x'
 * // Plain text becomes a thunk.
 * generateComponentChildren([{ kind: 'text', value: 'Hi', start: 0, end: 2 }], id);
 * // "children: () => 'Hi'"
 * ```
 */
function generateComponentChildren(children: MarkupChild[], compileExpression: ExpressionCompiler): string | null
{
    if (children.length === 0)
    {
        return null;
    }

    if (children.length === 1)
    {
        const only = children[0];
        if (only.kind === 'expression')
        {
            const compiled = compileExpression(only.code).trim();
            // A function child IS the render function (For/Match/etc.).
            if (isFunctionLiteral(compiled))
            {
                return `children: ${ compiled }`;
            }
            return `children: () => (${ compiled })`;
        }
        return `children: () => ${ generateChild(only, compileExpression) }`;
    }

    const items = children.map(c => generateChild(c, compileExpression));
    return `children: () => [${ items.join(', ') }]`;
}

/**
 * Generates code for a markup element or fragment.
 *
 * @param node - The element/fragment AST node
 * @param compileExpression - Recompiles nested-markup-bearing JS
 *
 * @returns A source string: `h(...)`, `Component({...})`, or for a fragment,
 *          an array `[...]`.
 *
 * @example
 * ```ts
 * const id = (code: string) => code;
 * const { node } = parseMarkup('<h1>Hi</h1>', 0);
 * generate(node, id); // "h('h1', {  }, 'Hi')"
 * ```
 */
export function generate(node: MarkupElement | MarkupFragment, compileExpression: ExpressionCompiler): string
{
    if (node.kind === 'fragment')
    {
        const items = node.children.map(c => generateChild(c, compileExpression));
        return `[${ items.join(', ') }]`;
    }

    if (node.isComponent)
    {
        const childrenEntry = generateComponentChildren(node.children, compileExpression);
        // No attributes and no children -> a zero-argument call. Emitting
        // `Comp({  })` instead would force every prop-less component to declare
        // a props parameter (and the language service would flag the call as
        // "Expected 0 arguments, but got 1").
        if (node.attributes.length === 0 && childrenEntry === null)
        {
            return `${ node.tag }()`;
        }
        const props = generateProps(node.attributes, compileExpression, childrenEntry ?? undefined);
        return `${ node.tag }(${ props })`;
    }

    // Host element -> h('tag', props, ...children).
    const props = generateProps(node.attributes, compileExpression);
    const children = node.children.map(c => generateChild(c, compileExpression));
    const args = [`'${ node.tag }'`, props, ...children];
    return `h(${ args.join(', ') })`;
}

/**
 * Visits the markup element tree (not expression holes) and calls `visit`
 * with the tag of every component (capitalised/dotted) element. Used by
 * compile() to auto-import the built-in components a file references. Holes
 * are handled by the caller's recursion.
 *
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
