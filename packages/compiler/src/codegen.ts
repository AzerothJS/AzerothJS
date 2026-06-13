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
export function quoteString(value: string): string
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

// Template-cloning emission (the `dom` compile target).
//
// For a region whose entire subtree is host elements (no components, no
// fragments), the static structure is emitted ONCE as an HTML string and
// instantiated per use with cloneNode - the per-element createElement +
// applyProps work h() does becomes a single native clone. Dynamic parts
// (expression holes, event handlers, reactive/spread/DOM-property
// attributes) are bound into the clone by walking firstChild/nextSibling
// paths computed here at compile time. Holes leave a `<!--$-->` comment in
// the template (comments never merge with neighboring text the way a text
// placeholder would); bindHole() swaps the marker for the live node.
//
// Each region is emitted as BOTH forms behind a render-mode guard:
//
//     isStringMode() || isHydrating() ? h(...) : (clone + bind)
//
// SSR and hydration ride the universal h() machinery - the server output
// and adoption walk stay byte-identical to the default target - while
// every fresh client creation (post-hydration rows, branch swaps, CSR)
// takes the clone path. The walk paths computed below never run against
// server DOM, whose hole anchors would shift them. Costs one mode check
// per instantiation and the duplicated region code in the bundle.
//
// Regions that contain components or fragments fall back to the universal
// h() emission alone - composition crosses function boundaries the
// template can't see across.

/**
 * Static attributes h() sets as DOM PROPERTIES, not attributes. In a
 * template they must go through bindProps to keep h()'s semantics (an
 * attribute only sets the initial state; the property is the live state).
 *
 * @internal
 */
const DOM_PROPERTY_ATTRS = new Set(['value', 'checked', 'selected', 'innerHTML', 'textContent']);

/** Elements with no end tag (and no children). @internal */
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** Escapes text-node content for embedding in the template HTML. @internal */
function escapeTemplateText(text: string): string
{
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes an attribute value for embedding in the template HTML. @internal */
function escapeTemplateAttr(value: string): string
{
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** What a dom-target region emission used, so compile() imports only that. */
export interface DomRegion
{
    /** The expression replacing the markup region. */
    code: string;

    /** True when the emission calls bindHole(). */
    usesBindHole: boolean;

    /** True when the emission calls bindChild(). */
    usesBindChild: boolean;

    /** True when the emission calls bindProps(). */
    usesBindProps: boolean;
}

/**
 * True when every element in the subtree is a host element - the shape the
 * template path can serialize. Components and fragments bail to h().
 *
 * @internal
 */
function isHostOnly(el: MarkupElement): boolean
{
    if (el.isComponent)
    {
        return false;
    }
    if (VOID_ELEMENTS.has(el.tag) && el.children.length > 0)
    {
        return false;
    }
    for (const child of el.children)
    {
        if (child.kind === 'fragment')
        {
            return false;
        }
        if (child.kind === 'element' && !isHostOnly(child))
        {
            return false;
        }
    }
    return true;
}

/**
 * Emits a markup region as a cloned template plus dynamic bindings, or
 * returns null when the region isn't template-eligible (the caller falls
 * back to the h() emission).
 *
 * @param node - The region's root AST node
 * @param compileExpression - Recompiles nested-markup-bearing JS
 * @param allocateTemplate - Interns an HTML string, returning the hoisted
 *                           template const's name (deduplicated per module)
 *
 * @example
 * ```ts
 * // <li class="row">{name()}</li> becomes (hoisted)
 * //   const _tmpl$1 = tmpl('<li class="row"><!--$--></li>');
 * // and (in place)
 * //   (() => { const _r = _tmpl$1(); const _e$1 = _r.firstChild;
 * //            bindHole(_e$1, () => (name())); return _r; })()
 * ```
 */
export function generateDomRegion(
    node: MarkupElement | MarkupFragment,
    compileExpression: ExpressionCompiler,
    allocateTemplate: (html: string) => string
): DomRegion | null
{
    if (node.kind !== 'element' || !isHostOnly(node))
    {
        return null;
    }

    interface Op
    {
        path: number[];
        kind: 'hole' | 'child' | 'props';
        code: string;
    }
    const ops: Op[] = [];

    function buildElement(el: MarkupElement, path: number[]): string
    {
        let html = `<${ el.tag }`;

        const dynamicEntries: string[] = [];
        for (const attr of el.attributes)
        {
            if (attr.spread || attr.value.kind === 'expression' || DOM_PROPERTY_ATTRS.has(attr.name ?? ''))
            {
                dynamicEntries.push(generateAttribute(attr, compileExpression));
                continue;
            }
            html += attr.value.kind === 'none'
                ? ` ${ attr.name }`
                : ` ${ attr.name }="${ escapeTemplateAttr(attr.value.value) }"`;
        }
        html += '>';

        if (dynamicEntries.length > 0)
        {
            ops.push({ path, kind: 'props', code: `{ ${ dynamicEntries.join(', ') } }` });
        }

        if (VOID_ELEMENTS.has(el.tag))
        {
            return html;
        }

        // Sole-child hole (`<span>{x()}</span>`): no marker - the binding
        // appends straight into the empty parent. Saves a cloned comment
        // node and a replaceChild per instance; with one-binding leaf
        // elements (the dominant row shape) that is most of the work.
        if (el.children.length === 1 && el.children[0].kind === 'expression')
        {
            ops.push({
                path,
                kind: 'child',
                code: wrapDynamic(compileExpression(el.children[0].code), false)
            });
            return `${ html }</${ el.tag }>`;
        }

        let index = 0;
        for (const child of el.children)
        {
            if (child.kind === 'text')
            {
                html += escapeTemplateText(child.value);
            }
            else if (child.kind === 'expression')
            {
                html += '<!--$-->';
                ops.push({
                    path: [...path, index],
                    kind: 'hole',
                    code: wrapDynamic(compileExpression(child.code), false)
                });
            }
            else
            {
                html += buildElement(child as MarkupElement, [...path, index]);
            }
            index++;
        }

        return `${ html }</${ el.tag }>`;
    }

    const html = buildElement(node, []);
    const templateName = allocateTemplate(html);

    // The universal form for SSR/hydration - same output the default
    // target produces, selected by the runtime mode guard.
    const universal = generate(node, compileExpression);

    if (ops.length === 0)
    {
        return {
            code: `(isStringMode() || isHydrating() ? ${ universal } : ${ templateName }())`,
            usesBindHole: false,
            usesBindChild: false,
            usesBindProps: false
        };
    }

    // Walk variables: one const per distinct node a binding targets, shared
    // ancestor prefixes cached so each path segment is computed once.
    const decls: string[] = [];
    const varByPath = new Map<string, string>([['', '_r']]);
    let varId = 0;

    function varFor(path: number[]): string
    {
        const key = path.join('.');
        const existing = varByPath.get(key);
        if (existing !== undefined)
        {
            return existing;
        }
        const parent = varFor(path.slice(0, -1));
        const name = `_e$${ ++varId }`;
        decls.push(`const ${ name } = ${ parent }.firstChild${ '.nextSibling'.repeat(path[path.length - 1]) };`);
        varByPath.set(key, name);
        return name;
    }

    let usesBindHole = false;
    let usesBindChild = false;
    let usesBindProps = false;
    const stmts = ops.map((op) =>
    {
        const target = varFor(op.path);
        if (op.kind === 'hole')
        {
            usesBindHole = true;
            return `bindHole(${ target }, ${ op.code });`;
        }
        if (op.kind === 'child')
        {
            usesBindChild = true;
            return `bindChild(${ target }, ${ op.code });`;
        }
        usesBindProps = true;
        return `bindProps(${ target }, ${ op.code });`;
    });

    const body = [`const _r = ${ templateName }();`, ...decls, ...stmts, 'return _r;'].join(' ');
    return {
        code: `(isStringMode() || isHydrating() ? ${ universal } : (() => { ${ body } })())`,
        usesBindHole,
        usesBindChild,
        usesBindProps
    };
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
