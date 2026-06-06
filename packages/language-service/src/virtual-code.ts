// Turns a `.azeroth` source into a *virtual* TypeScript module the language
// service can type-check, while recording a precise offset mapping back to the
// original (see mapping.ts).
//
// It reuses the compiler's own scanner (to find markup regions) and parser (to
// build the markup AST), then walks that AST the same way @azerothjs/compiler's
// codegen does - emitting `h(...)` / component calls with the same reactive
// wrapping rules - so the virtual module matches what actually ships. The one
// difference from codegen: every user-authored span (the script between markup,
// the code inside `{ ... }` holes, attribute expressions, component tag names)
// is copied byte-for-byte and registered as a mapping segment. Generated
// scaffolding (`h('div', { `, quotes, getters) is emitted but not mapped.
//
// Because the markup-bearing portion of a `.azeroth` file is small relative to
// the surrounding TypeScript, the overwhelming majority of every file is copied
// 1:1 - which is why TS-powered features feel native across the whole document.

import { findMarkupStart, skipBalanced, isWhitespace } from '@azerothjs/compiler';
import { parseMarkup } from '@azerothjs/compiler';
import { walkComponentTags } from '@azerothjs/compiler';
import type {
    MarkupElement,
    MarkupFragment,
    MarkupChild,
    MarkupAttribute
} from '@azerothjs/compiler';
import { CodeMapping, type MappingSegment, type MappingKind } from './mapping.ts';

/** Module the auto-injected runtime imports point at (matches the compiler). */
const RUNTIME_MODULE = '@azerothjs/core';

/**
 * Built-in components the compiler auto-imports from the runtime when markup
 * uses them. Kept in sync with @azerothjs/compiler so the virtual module
 * resolves the same symbols the shipped module would.
 */
export const BUILTIN_COMPONENTS: readonly string[] =
[
    'Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic',
    'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'
];

const BUILTIN_SET = new Set(BUILTIN_COMPONENTS);

/** The virtual TS module plus its mapping back to the `.azeroth` source. */
export interface VirtualCode
{
    /** Compiled TypeScript the language service type-checks. */
    code: string;

    /** Bidirectional offset mapping (original <-> generated). */
    mapping: CodeMapping;
}

/** An inclusive/exclusive span of user code copied verbatim. */
interface Span
{
    start: number;
    end: number;
}

/**
 * Accumulates the virtual module while tracking which slices came verbatim
 * from the source.
 *
 * @internal
 */
class Builder
{
    public out = '';

    public readonly segments: MappingSegment[] = [];

    constructor(private readonly src: string)
    {}

    /** Appends generated scaffolding that has no original counterpart. */
    public emit(text: string): void
    {
        this.out += text;
    }

    /** Copies `[start, end)` from the source verbatim and records a mapping. */
    public copy(start: number, end: number, kind: MappingKind): void
    {
        if (end <= start)
        {
            return;
        }

        const generatedStart = this.out.length;
        this.out += this.src.slice(start, end);
        this.segments.push({
            sourceStart: start,
            sourceEnd: end,
            generatedStart,
            generatedEnd: this.out.length,
            kind
        });
    }
}

/**
 * Compiles a `.azeroth` source string into the virtual TS module the language
 * service operates on, plus the mapping needed to translate positions and
 * results in both directions.
 *
 * @example
 * ```ts
 * const { code, mapping } = generateVirtualCode('const x = <h1>{name()}</h1>;');
 * // `name()` appears verbatim in `code`; mapping.toOriginal points back at it.
 * ```
 */
export function generateVirtualCode(source: string): VirtualCode
{
    const builder = new Builder(source);
    const usedBuiltins = new Set<string>();

    const collect = (node: MarkupElement | MarkupFragment): void =>
        walkComponentTags(node, (tag) =>
        {
            if (BUILTIN_SET.has(tag))
            {
                usedBuiltins.add(tag);
            }
        });

    /**
     * Emits a slice of source that is an expression (a `{ ... }` hole body or
     * attribute value), expanding any nested markup it contains and copying the
     * rest verbatim - the same recursion the compiler performs for holes.
     */
    const emitExpression = (start: number, end: number, kind: MappingKind): void =>
    {
        let j = start;
        for (;;)
        {
            const m = findMarkupStart(source, j);
            if (m === -1 || m >= end)
            {
                builder.copy(j, end, kind);
                break;
            }
            builder.copy(j, m, kind);
            let parsed: { node: MarkupElement | MarkupFragment; end: number };
            try
            {
                parsed = parseMarkup(source, m);
            }
            catch
            {
                // Incomplete markup mid-edit: copy the remainder verbatim so the
                // rest of the module stays analysable (the diagnostics provider
                // surfaces the markup error from the parser separately).
                builder.copy(m, end, kind);
                break;
            }
            collect(parsed.node);
            emitNode(parsed.node);
            j = parsed.end;
        }
    };

    /** Emits a dynamic `{expr}`, mirroring the compiler's getter-wrapping. */
    const emitDynamic = (span: Span, isEventHandler: boolean, kind: MappingKind): void =>
    {
        const code = source.slice(span.start, span.end).trim();
        if (
            isEventHandler ||
            isFunctionLiteral(code) ||
            isBareReference(code) ||
            isCollectionLiteral(code)
        )
        {
            emitExpression(span.start, span.end, kind);
            return;
        }
        builder.emit('() => (');
        emitExpression(span.start, span.end, kind);
        builder.emit(')');
    };

    const emitAttribute = (attr: MarkupAttribute, isHost: boolean): void =>
    {
        if (attr.spread)
        {
            builder.emit('...');
            emitExpression(spreadSpan(source, attr).start, spreadSpan(source, attr).end, 'attribute');
            return;
        }

        const name = attr.name as string;
        builder.emit(`${ objectKey(name) }: `);

        if (attr.value.kind === 'none')
        {
            builder.emit('true');
            return;
        }
        if (attr.value.kind === 'static')
        {
            builder.emit(quoteString(attr.value.value));
            return;
        }

        const span = attrExprSpan(source, attr);
        // Host event handlers: contextually type the handler so `(e) => …`
        // infers the right DOM event. Only for inline functions (a reference's
        // type is the author's business and must not be second-guessed).
        if (isHost && isEventName(name) && isFunctionLiteral(source.slice(span.start, span.end).trim()))
        {
            builder.emit('(');
            emitExpression(span.start, span.end, 'attribute');
            builder.emit(`) satisfies AzerothHandler<'${ name }'>`);
            return;
        }
        emitDynamic(span, isEventName(name), 'attribute');
    };

    const emitProps = (attrs: MarkupAttribute[], childrenEntry: (() => void) | null, isHost: boolean): void =>
    {
        builder.emit('{ ');
        attrs.forEach((attr, index) =>
        {
            if (index > 0)
            {
                builder.emit(', ');
            }
            emitAttribute(attr, isHost);
        });
        if (childrenEntry)
        {
            if (attrs.length > 0)
            {
                builder.emit(', ');
            }
            childrenEntry();
        }
        builder.emit(' }');
    };

    const emitChild = (child: MarkupChild): void =>
    {
        if (child.kind === 'text')
        {
            builder.emit(quoteString(child.value));
            return;
        }
        if (child.kind === 'expression')
        {
            emitDynamic({ start: child.start + 1, end: child.end - 1 }, false, 'expression');
            return;
        }
        emitNode(child);
    };

    /** Mirrors codegen.generateComponentChildren as a side-effecting emit. */
    const emitComponentChildren = (children: MarkupChild[]): (() => void) | null =>
    {
        if (children.length === 0)
        {
            return null;
        }
        return () =>
        {
            builder.emit('children: ');
            if (children.length === 1)
            {
                const only = children[0];
                if (only.kind === 'expression')
                {
                    const span = { start: only.start + 1, end: only.end - 1 };
                    const code = source.slice(span.start, span.end).trim();
                    if (isFunctionLiteral(code))
                    {
                        emitExpression(span.start, span.end, 'expression');
                    }
                    else
                    {
                        builder.emit('() => (');
                        emitExpression(span.start, span.end, 'expression');
                        builder.emit(')');
                    }
                    return;
                }
                builder.emit('() => ');
                emitChild(only);
                return;
            }
            builder.emit('() => [');
            children.forEach((child, index) =>
            {
                if (index > 0)
                {
                    builder.emit(', ');
                }
                emitChild(child);
            });
            builder.emit(']');
        };
    };

    function emitNode(node: MarkupElement | MarkupFragment): void
    {
        if (node.kind === 'fragment')
        {
            builder.emit('[');
            node.children.forEach((child, index) =>
            {
                if (index > 0)
                {
                    builder.emit(', ');
                }
                emitChild(child);
            });
            builder.emit(']');
            return;
        }

        if (node.isComponent)
        {
            // Copy the tag identifier verbatim so go-to-definition, hover, and
            // rename resolve the component symbol through TypeScript.
            const tagStart = node.start + 1;
            builder.copy(tagStart, tagStart + node.tag.length, 'tag');
            // Always emit the `({ ... })` props object - even when empty - so
            // attribute completion can query TypeScript inside it for the
            // component's prop names. The shipped compiler emits a bare `Comp()`
            // for the attribute-less case (Bug 2); the difference is invisible
            // here because the generated `{ }` is unmapped scaffolding, so the
            // "Expected 0 arguments" arity error it could provoke maps back to
            // nothing and is dropped by the diagnostics provider.
            builder.emit('(');
            emitProps(node.attributes, emitComponentChildren(node.children), false);
            builder.emit(')');
            return;
        }

        builder.emit(`h(${ quoteString(node.tag) }, `);
        emitProps(node.attributes, null, true);
        for (const child of node.children)
        {
            builder.emit(', ');
            emitChild(child);
        }
        builder.emit(')');
    }

    // Top-level transform: copy verbatim script, expand each markup region.
    let i = 0;
    for (;;)
    {
        const start = findMarkupStart(source, i);
        if (start === -1)
        {
            builder.copy(i, source.length, 'script');
            break;
        }
        builder.copy(i, start, 'script');
        let parsed: { node: MarkupElement | MarkupFragment; end: number };
        try
        {
            parsed = parseMarkup(source, start);
        }
        catch
        {
            // Half-typed markup: keep the tail verbatim rather than throwing, so
            // the language service degrades gracefully while the author types.
            builder.copy(start, source.length, 'script');
            break;
        }
        collect(parsed.node);
        emitNode(parsed.node);
        i = parsed.end;
    }

    return finalize(builder, source, usedBuiltins);
}

/**
 * Prepends the same runtime import the compiler injects (only when markup was
 * emitted) and shifts every mapping segment past it. With no markup the source
 * is reproduced 1:1, so the language service sees a plain TS module.
 */
function finalize(builder: Builder, source: string, usedBuiltins: Set<string>): VirtualCode
{
    const hasMarkup = builder.segments.some(segment => segment.kind !== 'script') || builder.out !== source;

    if (!hasMarkup)
    {
        return { code: builder.out, mapping: new CodeMapping(builder.segments) };
    }

    const names = ['h', ...usedBuiltins].filter(name => !alreadyImports(source, name));
    const prefix = names.length > 0
        ? `import { ${ names.join(', ') } } from '${ RUNTIME_MODULE }';\n`
        : '';

    const shift = prefix.length;
    const segments = builder.segments.map(segment => ({
        ...segment,
        generatedStart: segment.generatedStart + shift,
        generatedEnd: segment.generatedEnd + shift
    }));

    return { code: prefix + builder.out, mapping: new CodeMapping(segments) };
}

/** True when the module already imports `name` via a named import. */
function alreadyImports(source: string, name: string): boolean
{
    return new RegExp(`import\\s*\\{[^}]*\\b${ name }\\b[^}]*\\}\\s*from`).test(source);
}

/** Trimmed inner span of an attribute whose value is `{expr}`. */
function attrExprSpan(source: string, attr: MarkupAttribute): Span
{
    const open = source.indexOf('{', attr.start);
    return trimSpan(source, open + 1, attr.end - 1);
}

/** Trimmed span of the argument of a `{...spread}` attribute. */
function spreadSpan(source: string, attr: MarkupAttribute): Span
{
    const open = source.indexOf('{', attr.start);
    const close = skipBalanced(source, open);
    const inner = trimSpan(source, open + 1, close - 1);
    // Skip a leading `...` so the mapped span covers just the expression.
    if (source.startsWith('...', inner.start))
    {
        return trimSpan(source, inner.start + 3, inner.end);
    }
    return inner;
}

/** Narrows `[start, end)` to exclude surrounding whitespace. */
function trimSpan(source: string, start: number, end: number): Span
{
    let s = start;
    let e = end;
    while (s < e && isWhitespace(source[s]))
    {
        s++;
    }
    while (e > s && isWhitespace(source[e - 1]))
    {
        e--;
    }
    return { start: s, end: e };
}

// --- Emission predicates, ported from @azerothjs/compiler's codegen so the
// --- virtual module's reactive wrapping matches the shipped output exactly. ---

/** True when `code` is an arrow/function literal - emitted unwrapped. */
function isFunctionLiteral(code: string): boolean
{
    const t = code.trim();
    if (/^async\s+function\b/.test(t) || /^function\b/.test(t))
    {
        return true;
    }
    return /^(async\s+)?(\([^]*?\)|[A-Za-z_$][\w$]*)\s*=>/.test(t);
}

/** True for a bare identifier or dotted path (`draft`, `props.x`). */
function isBareReference(code: string): boolean
{
    return /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(code.trim());
}

/** True for an array/object literal (`[...]` / `{...}`). */
function isCollectionLiteral(code: string): boolean
{
    const t = code.trim();
    return t.startsWith('[') || t.startsWith('{');
}

/** True for an `on*` event attribute name (`on` + uppercase letter). */
function isEventName(name: string): boolean
{
    return name.length > 2 && name.startsWith('on') && name[2] === name[2].toUpperCase();
}

/** Quotes an object key when it isn't a valid bare identifier. */
function objectKey(name: string): string
{
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${ name }'`;
}

/** Escapes a literal string for emission inside single quotes. */
function quoteString(value: string): string
{
    return `'${ value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\n/g, '\\n') }'`;
}
