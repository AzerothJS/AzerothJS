// ============================================================================
// AZEROTHJS COMPILER — Code Generator
// ============================================================================
//
// Turns a markup AST node into a `h()` (or component-call) source
// string. The reactivity rule:
//
//   - Event handlers (on*)         → passed through verbatim.
//   - Function / bare-identifier   → passed through verbatim
//     expressions                    (already a getter, handler,
//                                     or component reference).
//   - Any other dynamic expression → wrapped as `() => (expr)` so
//                                     h() treats it as reactive.
//   - Static "string" attributes   → kept as string literals.
//
// Expression holes can contain nested markup; we recompile their
// source via the `compileExpression` callback the caller passes in
// (which loops back to compile.ts), so `{cond && <p/>}` works.
//
// ============================================================================

import type {
    MarkupElement,
    MarkupFragment,
    MarkupChild,
    MarkupAttribute
} from './types.ts';

/** Recompiles arbitrary JS that may contain nested markup. */
export type ExpressionCompiler = (code: string) => string;

/** True when `code` is an arrow/function literal — pass it through unwrapped. */
function isFunctionLiteral(code: string): boolean
{
    const t = code.trim();
    if (/^async\s+function\b/.test(t) || /^function\b/.test(t))
    {
        return true;
    }
    // Arrow: `x => …`, `(…) => …`, `async x => …`, `async (…) => …`.
    return /^(async\s+)?(\([^]*?\)|[A-Za-z_$][\w$]*)\s*=>/.test(t);
}

/** True when `code` is a single bare identifier or dotted path (e.g. `draft`, `props.x`). */
function isBareReference(code: string): boolean
{
    return /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(code.trim());
}

/** True when `code` is an array or object literal (`[…]` / `{…}`). */
function isCollectionLiteral(code: string): boolean
{
    const t = code.trim();
    return t.startsWith('[') || t.startsWith('{');
}

/**
 * Decides how a dynamic `{expr}` is emitted. Passed through verbatim
 * when it's already the right shape for the runtime:
 *   - an event handler,
 *   - a function literal (handler / render fn / key fn),
 *   - a bare reference (a signal getter, a component, props.x),
 *   - an array/object literal (e.g. `on={[res]}`, a props bag).
 * Everything else is a computed value, wrapped in a getter so h()
 * (and reactive props like `when`/`each`) stay fine-grained.
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

/** Quotes an object key when it isn't a valid bare identifier. */
function objectKey(name: string): string
{
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${ name }'`;
}

function isEventName(name: string): boolean
{
    return name.length > 2 && name.startsWith('on') && name[2] === name[2].toUpperCase();
}

/** Escapes a literal string for emission inside single quotes. */
function quoteString(value: string): string
{
    return `'${ value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\n/g, '\\n') }'`;
}

/** Emits one attribute as a `key: value` entry (or a `...spread`). */
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

/** Builds the `{ … }` props object literal for an element/component. */
function generateProps(attrs: MarkupAttribute[], compileExpression: ExpressionCompiler, extra?: string): string
{
    const parts = attrs.map(a => generateAttribute(a, compileExpression));
    if (extra)
    {
        parts.push(extra);
    }
    return `{ ${ parts.join(', ') } }`;
}

/** Emits a single child as an argument to h() / an array element. */
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
 * Generates the `children` entry for a COMPONENT from its markup
 * children. A lone function-hole child becomes the function itself
 * (e.g. `<For>{(item) => …}</For>`); anything else becomes a thunk
 * returning the child (or an array of children).
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
 * @returns A source string: `h(…)`, `Component({…})`, or for a
 *          fragment, an array `[…]`.
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
        const props = generateProps(node.attributes, compileExpression, childrenEntry ?? undefined);
        return `${ node.tag }(${ props })`;
    }

    // Host element → h('tag', props, …children).
    const props = generateProps(node.attributes, compileExpression);
    const children = node.children.map(c => generateChild(c, compileExpression));
    const args = [`'${ node.tag }'`, props, ...children];
    return `h(${ args.join(', ') })`;
}

/**
 * Visits the markup ELEMENT tree (not expression holes) and calls
 * `visit` with the tag of every component (capitalised/dotted)
 * element. Used by compile() to auto-import the built-in components
 * a file references. Holes are handled by the caller's recursion.
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
