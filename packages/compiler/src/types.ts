// AST for one markup region. The compiler transforms markup embedded in a
// JS/TS module into h() calls; these types describe what the parser produces.
// Everything outside markup is left as opaque source text (the scanner only
// carves out markup regions), so we never need a full JS grammar.
//
// Every node carries start/end byte offsets into the original source, so
// codegen can emit source maps and errors can point at the right place.

/** Offsets into the original source string. */
export interface Span
{
    /** Inclusive start offset. */
    start: number;
    /** Exclusive end offset. */
    end: number;
}

/**
 * A markup element: `<div class="x">...</div>`, `<Counter n={1} />`, or a
 * component. `isComponent` is true when the tag starts with an uppercase
 * letter or contains a dot (`<Foo.Bar/>`) - those compile to component calls
 * rather than `h('tag', ...)`.
 */
export interface MarkupElement extends Span
{
    kind: 'element';
    /** Tag name as written, e.g. `div`, `Counter`, `Foo.Bar`. */
    tag: string;
    /** True for components (capitalised / dotted tag). */
    isComponent: boolean;
    attributes: MarkupAttribute[];
    children: MarkupChild[];
}

/** A `<>...</>` fragment: a children list with no wrapper element. */
export interface MarkupFragment extends Span
{
    kind: 'fragment';
    children: MarkupChild[];
}

/** Literal text between tags. Whitespace-only text is dropped by the parser. */
export interface MarkupText extends Span
{
    kind: 'text';
    value: string;
}

/**
 * A `{ ... }` expression hole in element-child or attribute position. `code`
 * is the verbatim JS between the braces; any nested markup inside it is left
 * untouched here and expanded later by codegen.
 */
export interface MarkupExpression extends Span
{
    kind: 'expression';
    /** Raw JS source inside the braces, with nested markup left in place. */
    code: string;
}

/** Any node that can appear as a child of an element/fragment. */
export type MarkupChild = MarkupElement | MarkupFragment | MarkupText | MarkupExpression;

/** The value side of an attribute. */
export type MarkupAttributeValue =
    /** `name="literal"`: a plain string. */
    | { kind: 'static'; value: string }
    /** `name={expr}`: a JS expression. */
    | { kind: 'expression'; code: string }
    /** Bare `name`: a boolean-true attribute. */
    | { kind: 'none' };

/**
 * A single attribute on an element. A spread (`{...props}`) is
 * represented with `name === null` and an expression value holding
 * the spread argument.
 */
export interface MarkupAttribute extends Span
{
    kind: 'attribute';
    /** Attribute name, or `null` for a spread (`{...expr}`). */
    name: string | null;
    value: MarkupAttributeValue;
    /** True when this is a `{...spread}`. */
    spread: boolean;
}

/**
 * A markup region located by the scanner: the root markup node plus the span
 * it occupies in the source (so `compile()` can splice the generated code
 * back in).
 */
export interface MarkupRegion extends Span
{
    node: MarkupElement | MarkupFragment;
}
