/**
 * MODULE: compiler/project - the SINGLE Azeroth -> TypeScript projection.
 *
 * This is the one and only place a parsed `.azeroth` module is lowered to TypeScript. Every tool that
 * needs to see a `.azeroth` file as TypeScript - the type checker ({@link typeCheckModuleTS}), the editor
 * language service (virtual code), the TypeScript plugin, the ESLint processor, the declaration emitter -
 * goes through {@link generateVirtualCode}. There is deliberately no second implementation of this
 * lowering: a new language feature is taught here once and immediately works in every tool.
 *
 * WHAT IT PRODUCES: a virtual TypeScript module plus a {@link CodeMapping} back to the source. Each
 * component becomes a typed function (`component Name { ... }` -> `function Name(props: P) { ... }`); the
 * reactive keywords are rewritten to their type-equivalent forms (`state`->`let`, `derived`/`deferred`->
 * `const`, `effect`/wrappers->block, `watch (deps)`->`on([...getters...], ...)`) at ANY nesting depth (a
 * composable, a render callback, an effect body); markup becomes `h(...)` / component-call expressions with
 * the same reactive wrapping the runtime codegen uses; and the rendered markup is `return`ed so a
 * component's inferred type is its real `HTMLElement` return. Every user-authored span is copied
 * byte-for-byte and registered as a mapping segment; generated scaffolding is emitted unmapped.
 *
 * SELF-CONTAINED: the runtime bindings the projection references (`h`, `on`, the built-in control-flow
 * components) and the `AzerothHandler` event-typing helper are appended as ambient declarations, so the
 * virtual module type-checks in any `ts.Program` without external setup.
 */

import type { ComponentDecl, BodyItem } from './ast.ts';
import type { MarkupElement, MarkupFragment, MarkupChild, MarkupAttribute, Span } from './types.ts';

import { findMarkupStart, skipString, skipTemplate, skipLineComment, skipBlockComment, isWhitespace } from './scanner.ts';
import { parseMarkup } from './markup-parser.ts';
import {
    walkComponentTags,
    isEventName,
    FACTORY_ATTRS,
    isFunctionLiteral,
    isBareReference,
    isCollectionLiteral,
    objectKey,
    quoteString,
    alreadyImports
} from './markup-util.ts';
import { parseModule } from './parser.ts';
import { findConstructs } from './lower-reactive.ts';
import { parseDeclarationSlice, factoryPlan, parseComponentParam } from './ts-slice.ts';
import { RUNTIME_FN } from './keyword-spec.ts';
import { CodeMapping, type MappingSegment, type MappingKind } from './mapping.ts';

/** Module the auto-injected runtime bindings point at (matches the compiler's codegen). */
const RUNTIME_MODULE = 'azerothjs';

/**
 * Built-in control-flow components the compiler auto-imports from the runtime when markup uses them.
 * Kept in sync with codegen so the virtual module resolves the same symbols the shipped module would.
 */
export const BUILTIN_COMPONENTS: readonly string[] =
[
    'Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic',
    'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'
];

const BUILTIN_SET = new Set(BUILTIN_COMPONENTS);

/**
 * `AzerothHandler<'onClick'>` maps a camelCase event prop to the right DOM event (via lib.dom's
 * GlobalEventHandlersEventMap), so a host handler `<button onClick={(e) => ...}>` infers `e: MouseEvent`
 * without imposing strict attribute checking the permissive `h()` runtime doesn't.
 */
const AZEROTH_HANDLER_DECL =
    'type AzerothHandler<N extends string> = N extends `on${infer E}`'
    + ' ? (event: Lowercase<E> extends keyof GlobalEventHandlersEventMap'
    + ' ? GlobalEventHandlersEventMap[Lowercase<E>] : Event) => unknown'
    + ' : (event: Event) => unknown;';

/** Offset fields a {@link BodyItem} can carry; shifted in bulk when re-basing a nested-scan result. */
const OFFSET_FIELDS =
[
    'start', 'end', 'nameStart', 'nameEnd', 'valueEnd', 'bodyStart', 'bodyEnd',
    'depsStart', 'depsEnd', 'paramsStart', 'paramsEnd', 'optionsStart', 'optionsEnd',
    'membersStart', 'membersEnd'
] as const;

/** The virtual TS module plus its mapping back to the `.azeroth` source. */
export interface VirtualCode
{
    /** Compiled TypeScript the consumer type-checks. */
    code: string;

    /** Bidirectional offset mapping (original <-> generated). */
    mapping: CodeMapping;
}

/**
 * Accumulates the virtual module while tracking which slices came verbatim from the source.
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
 * Projects a `.azeroth` source string into the virtual TS module every tool operates on, plus the
 * mapping needed to translate positions and results in both directions.
 *
 * @example
 * ```ts
 * const { code, mapping } = generateVirtualCode('export default component App { <h1>{name()}</h1> }');
 * // `name()` appears verbatim in `code`; mapping.toOriginal points back at it.
 * ```
 */
export function generateVirtualCode(source: string): VirtualCode
{
    const module = parseModule(source);
    const builder = new Builder(source);
    const usedRuntime = new Set<string>();
    let usedHandler = false;
    let usedChildren = false;
    let usedRender = false;

    const collect = (node: MarkupElement | MarkupFragment): void =>
        walkComponentTags(node, (tag) =>
        {
            if (BUILTIN_SET.has(tag))
            {
                usedRuntime.add(tag);
            }
        });

    /**
     * Emits a region of user CODE: rewrites every reactive keyword construct in it (at this nesting
     * level) to its type-equivalent TS, and copies the gaps between them - expanding any markup they
     * contain - verbatim. Recurses into each construct's body, so nested keywords (composables, render
     * callbacks, effect bodies) lower exactly like top-level ones. This is the single entry every body,
     * initializer, hole, and opaque region flows through.
     */
    const emitCode = (start: number, end: number, kind: MappingKind = 'script'): void =>
    {
        const found = findConstructs(source.slice(start, end)).map((c) => shiftConstruct(c, start));
        // Keep only the constructs at THIS level; ones nested inside another are emitted by the recursive
        // emitCode over that construct's body.
        const top = found.filter((c) => !found.some((o) => o !== c && o.start <= c.start && c.end <= o.end));

        let pos = start;
        for (const c of top)
        {
            emitMarkup(pos, c.start, kind);
            emitConstruct(c);
            pos = c.end;
        }
        emitMarkup(pos, end, kind);
    };

    /**
     * Emits a slice that contains no reactive constructs: copies it verbatim, expanding any markup region
     * into `h()` / component-call expressions (the same recursion the runtime codegen performs).
     */
    const emitMarkup = (start: number, end: number, kind: MappingKind): void =>
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
                // Incomplete markup mid-edit: copy the remainder verbatim so the rest of the module stays
                // analysable (the diagnostics provider surfaces the markup error from the parser separately).
                builder.copy(m, end, kind);
                break;
            }
            collect(parsed.node);
            emitNode(parsed.node);
            j = parsed.end;
        }
    };

    /** Emits a dynamic `{expr}`, mirroring the codegen's getter-wrapping. */
    const emitDynamic = (span: Span, isEventHandler: boolean): void =>
    {
        const code = source.slice(span.start, span.end).trim();
        if (
            isEventHandler ||
            isFunctionLiteral(code) ||
            isBareReference(code) ||
            isCollectionLiteral(code)
        )
        {
            // A spread must stay bare (`(...x)` is not an expression); everything else is emitted in
            // GENERATED parens. The span is the verbatim inner text of the `{...}` hole - padding
            // included - and without the parens that padding abuts generated punctuation (`, label ,`),
            // where a style rule linting the virtual module (comma-spacing, ...) would "fix" the
            // user's markup padding through the byte-identical mapping. Parens insulate every side.
            if (code.startsWith('...'))
            {
                emitCode(span.start, span.end);
                return;
            }
            builder.emit('(');
            emitCode(span.start, span.end);
            builder.emit(')');
            return;
        }
        builder.emit('() => (');
        emitCode(span.start, span.end);
        builder.emit(')');
    };

    const emitAttribute = (attr: MarkupAttribute, isHost: boolean): void =>
    {
        if (attr.spread)
        {
            builder.emit('...');
            emitCode(spreadSpan(source, attr).start, spreadSpan(source, attr).end, 'attribute');
            return;
        }

        const name = attr.name as string;
        // A `bind:value={state}` on a COMPONENT projects to the two props it lowers to: the value prop and
        // the write-back callback (`onInput` for value, `onChange` for checked - the native event name).
        // This both type-checks the bound value against the prop type and requires the component to declare
        // a compatible callback; the `state = $event` assignment also rejects a non-writable target. Host
        // elements keep the permissive attribute projection below (the runtime applies `bind:` directly),
        // so this is component-only.
        if (!isHost && name.startsWith('bind:'))
        {
            const bindSpan = attrExprSpan(source, attr);
            const prop = name.slice(5);
            const event = prop === 'checked' ? 'Change' : 'Input';
            builder.emit(`${ objectKey(prop) }: (`);
            emitCode(bindSpan.start, bindSpan.end, 'attribute');
            builder.emit(`), on${ event }: ($event) => ((`);
            emitCode(bindSpan.start, bindSpan.end, 'attribute');
            builder.emit(') = $event)');
            return;
        }
        const key = objectKey(name);
        if (key === name)
        {
            // Copy the attribute name (mapped) so a prop-level diagnostic - e.g. an unknown prop on a
            // typed component tag - maps back to the original attribute instead of unmapped scaffolding.
            builder.copy(attr.start, attr.start + name.length, 'attribute');
            builder.emit(': ');
        }
        else
        {
            // Hyphenated/colon names (host attrs like `data-x`) can't be a bare key; emit a quoted key.
            builder.emit(`${ key }: `);
        }

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
        // Host event handlers: check the value IS a function via `satisfies AzerothHandler<'onX'>`, which
        // also contextually types an inline handler so `(e) => ...` infers the right DOM event. Applied to
        // every handler value (inline OR reference), so a non-function handler is rejected either way.
        if (isHost && isEventName(name))
        {
            usedHandler = true;
            builder.emit('(');
            emitCode(span.start, span.end, 'attribute');
            builder.emit(`) satisfies AzerothHandler<'${ name }'>`);
            return;
        }
        // A lazy-factory prop (e.g. `fallback`) is wrapped by codegen in `() => (value)`, so the author
        // supplies the INNER value; mirror the wrapping so it checks against the factory's return type. A
        // component's other props are auto-reactive via the runtime's getter, so the AUTHOR passes the
        // VALUE - the prop is checked against its value type directly (no getter wrap), which is what makes
        // a double-wrapped `prop={() => x}` (passing a function to a value prop) correctly surface.
        if (!isHost && FACTORY_ATTRS.has(name))
        {
            builder.emit('() => (');
            emitCode(span.start, span.end, 'attribute');
            builder.emit(')');
            return;
        }
        emitCode(span.start, span.end, 'attribute');
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
            emitDynamic({ start: child.start + 1, end: child.end - 1 }, false);
            return;
        }
        emitNode(child);
    };

    // A component's `children` prop is satisfied by the `any`-typed `...__children` spread: spread (not a
    // literal `children:` key) never trips excess-property checks on a component that doesn't declare
    // `children`, and `any` satisfies a specific `children` type without a mismatch - matching the runtime,
    // where children are always supplied and ignored if unused.
    const childrenSpread = (): void =>
    {
        usedChildren = true;
        builder.emit('...__children');
    };

    /**
     * Emits a component's MARKUP children as a function VALUE (a slot's content thunk, a `Show`/`Match` body)
     * handed to the type-neutral `__azRender(...)`. This is NOT the `children` prop (that is the sound
     * `...__children` spread); its purpose is to PROJECT the child markup - so imports used only inside
     * children count as used and the child gets IntelliSense - without checking it against the parent's
     * `children` type. A RENDER-CALLBACK child does not come here at all: `emitNode` passes it as the real
     * typed `children:` prop so its parameters infer from the component's signature (e.g. `For`'s
     * `(item, index)`). So the only values `__azRender` receives are no-arg markup thunks (`() => unknown`).
     */
    // When `guard` is set (a `Show`/`Match` `when` span), the children value is emitted under
    // `(<when>) ? (<children>) : null` so TypeScript NARROWS the guarded expression inside the children -
    // e.g. `<Show when={user}>{user.name}</Show>` checks with `user` narrowed to non-null, removing the
    // need for a `!` assertion. The same `when` is also emitted as the `when:` prop; both map to the one
    // source span. A render-callback child opts out (the guard cannot wrap a parameter binding).
    const emitChildrenRender = (children: MarkupChild[], guard: Span | null = null): void =>
    {
        const guardOpen = (): void =>
        {
            if (guard)
            {
                // `!!(...)` (not a bare `(...)`) so truthiness still narrows a value-typed `when`, while a
                // FUNCTION-typed `when` (the legitimate `when={thunk}` form, since `when` accepts
                // `boolean | (() => boolean)`) does NOT trip TS2774 "this condition is always true".
                builder.emit('!!(');
                emitCode(guard.start, guard.end);
                builder.emit(') ? (');
            }
        };
        const guardClose = (): void =>
        {
            if (guard)
            {
                builder.emit(') : null');
            }
        };

        if (children.length === 1)
        {
            const only = children[0];
            if (only.kind === 'expression')
            {
                // A single non-callback child (a value, a no-arg thunk, an IIFE `(() => ...)()`) is wrapped
                // in `() => (...)` so `__azRender` always receives a FUNCTION (a bare IIFE would otherwise
                // pass its element RESULT). A render-callback child never reaches here - `emitNode` passes it
                // as the typed `children:` prop instead.
                const span = { start: only.start + 1, end: only.end - 1 };
                builder.emit('() => (');
                guardOpen();
                emitCode(span.start, span.end);
                guardClose();
                builder.emit(')');
                return;
            }
            builder.emit('() => ');
            guardOpen();
            emitChild(only);
            guardClose();
            return;
        }
        builder.emit('() => ');
        guardOpen();
        builder.emit('[');
        children.forEach((child, index) =>
        {
            if (index > 0)
            {
                builder.emit(', ');
            }
            emitChild(child);
        });
        builder.emit(']');
        guardClose();
    };

    // A component whose ONLY child is a render callback (`{(item, i) => ...}`, e.g. `<For>`): returns the
    // callback's source span so it can be passed as the REAL typed `children:` prop. Returns null otherwise
    // (markup children, multiple children, a value/thunk), which stay on the type-neutral __azRender path.
    const onlyRenderCallback = (children: MarkupChild[]): Span | null =>
    {
        if (children.length !== 1)
        {
            return null;
        }
        const only = children[0]!;
        if (only.kind !== 'expression')
        {
            return null;
        }
        const span = { start: only.start + 1, end: only.end - 1 };
        return isRenderCallback(source.slice(span.start, span.end).trim()) ? span : null;
    };

    // The narrowing condition for a control-flow tag whose children type-check under it: the `when` span of
    // `Show`/`Match`. Returns null for any other tag or a `when` without an expression value, so ordinary
    // components project their children unguarded as before.
    const narrowingGuard = (node: MarkupElement): Span | null =>
    {
        if (node.tag !== 'Show' && node.tag !== 'Match')
        {
            return null;
        }
        const when = node.attributes.find(a => !a.spread && a.name === 'when' && a.value.kind === 'expression');
        return when ? attrExprSpan(source, when) : null;
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
            const hasChildren = node.children.length > 0;
            // Copy the tag identifier verbatim so go-to-definition, hover, and rename resolve the
            // component symbol through TypeScript.
            const tagStart = node.start + 1;

            // A single render-callback child is passed as the REAL `children:` prop so TypeScript contextually
            // types its parameters from the component's declared children signature (e.g. `For`'s
            // `(item: T, index) => HTMLElement`), instead of the type-neutral __azRender projection that widens
            // them to `any`. The callback BODY is still projected (imports register, IntelliSense works) since
            // it is emitted in place. A component that does not declare a callable `children` correctly rejects
            // a render-callback child. Markup children stay on the loose path below.
            const renderChild = hasChildren ? onlyRenderCallback(node.children) : null;
            if (renderChild)
            {
                builder.copy(tagStart, tagStart + node.tag.length, 'tag');
                builder.emit('(');
                emitProps(node.attributes, () =>
                {
                    builder.emit('children: ');
                    emitCode(renderChild.start, renderChild.end);
                }, false);
                builder.emit(')');
                return;
            }

            // Otherwise project the children through a type-neutral `__azRender(...)`, then the comma operator
            // keeps the component CALL as the expression's value: `(__azRender(<children>), Comp({ ... }))`.
            // For `Show`/`Match`, the `when` condition is threaded in as a NARROWING guard so the children
            // type-check with it narrowed (e.g. a `T | null` `when` is non-null inside).
            if (hasChildren)
            {
                usedRender = true;
                builder.emit('(__azRender(');
                emitChildrenRender(node.children, narrowingGuard(node));
                builder.emit('), ');
            }
            builder.copy(tagStart, tagStart + node.tag.length, 'tag');
            // Always a `Name({ ... })` call (never `Name()`), so a component with a REQUIRED props type is
            // checked: `<Card/>` -> `Card({})` surfaces the missing prop.
            builder.emit('(');
            emitProps(node.attributes, hasChildren ? childrenSpread : null, false);
            builder.emit(')');
            if (hasChildren)
            {
                builder.emit(')');
            }
            return;
        }

        usedRuntime.add('h');
        builder.emit(`h(${ quoteString(node.tag) }, `);
        emitProps(node.attributes, null, true);
        for (const child of node.children)
        {
            builder.emit(', ');
            emitChild(child);
        }
        builder.emit(')');
    }

    /** Rewrites one reactive keyword construct (top-level OR nested) to its type-equivalent TS form. */
    const emitConstruct = (c: BodyItem): void =>
    {
        switch (c.kind)
        {
            case 'state':
            {
                // `state` is a mutable, REACTIVE source: at runtime it is a signal accessor that reads the
                // CURRENT value (its full declared type), reassigned over time. Projected as a plain `let`,
                // though, TypeScript flow-narrows it to its INITIALIZER's type, so a synchronous read in
                // markup (e.g. an IIFE attribute value before any setter has run) would see only the
                // initial value's type - producing spurious "possibly undefined" / `never` diagnostics. So
                // a TYPED state is projected `let name: T = (init as T)`: the cast keeps the declared type
                // as the flow type, matching the reactive read. (An untyped `state x = v` widens naturally,
                // and a wrong initializer is still caught - `init as T` fails when they don't overlap.)
                const parsed = parseDeclarationSlice(source, c);
                if (parsed !== null && parsed.type !== undefined && parsed.initializer !== undefined)
                {
                    const typeText = parsed.type.getText(parsed.sourceFile);
                    builder.emit('let ');
                    builder.copy(c.nameStart, parsed.mapPos(parsed.type.getEnd()), 'script');
                    builder.emit(' = (');
                    emitCode(parsed.mapPos(parsed.initializer.getStart(parsed.sourceFile)), parsed.mapPos(parsed.initializer.getEnd()));
                    builder.emit(' as ' + typeText + ');\n');
                }
                else
                {
                    builder.emit('let ');
                    emitCode(c.nameStart, c.valueEnd);
                    builder.emit(';\n');
                }
                return;
            }
            case 'derived':
            case 'deferred':
                builder.emit('const ');
                emitCode(c.nameStart, c.valueEnd);
                builder.emit(';\n');
                return;
            case 'form':
            {
                // `form NAME = { ...initial } [with { validate, onSubmit }]` projects to
                // `Object.assign(createForm({ initial: { ...initial }, ...with }), { ...initial })`, typed
                // `FormApi<T> & T`. The `createForm` half gives the API (`NAME.errors()`, `NAME.handleSubmit`,
                // `NAME.submitting()`); the `& T` half (the initial object again) makes FIELD access
                // (`NAME.field`, and the `bind:` write `NAME.field = v`) type-check directly - the same
                // shape codegen produces by rewriting field reads/writes to values()/setValue. The projection
                // is type-check-only, so the doubled initial costs nothing at runtime.
                const parsed = parseDeclarationSlice(source, c);
                const initStart = parsed?.initializer ? parsed.mapPos(parsed.initializer.getStart(parsed.sourceFile)) : null;
                const initEnd = parsed?.initializer ? parsed.mapPos(parsed.initializer.getEnd()) : null;
                const emitInitial = (): void =>
                {
                    if (initStart !== null && initEnd !== null)
                    {
                        emitCode(initStart, initEnd);
                    }
                    else
                    {
                        builder.emit('{}');
                    }
                };
                if (c.isArray)
                {
                    // `form NAME[] = { ...blankRow } [with { ... }]` projects to
                    // `createFieldArray({ blank: () => ( ...blankRow ), <with-interior> })`, typed
                    // `FieldArrayApi<T>`. Like a factory it reads explicitly (NAME.rows()/NAME.append()),
                    // so there is no `& T` field-sugar half; row field access is sugared on the <For> row
                    // variable instead.
                    usedRuntime.add('createFieldArray');
                    builder.emit('const ');
                    builder.copy(c.nameStart, c.nameEnd, 'script');
                    // Wrap with __azRowForm (declared in finalize) so `NAME.rows()` types each row as
                    // `FieldArrayRow<R> & R`. Now that a `<For>` render-callback child is contextually typed
                    // from `ForProps<FieldArrayRow<R> & R>`, that `& R` half is what types the row variable's
                    // field access (`row.field`, `bind:value={row.field}`) - mirroring the runtime rewrite to
                    // `row.form.values().field`. The createFieldArray config still type-checks (it is wrapped).
                    builder.emit(' = __azRowForm(createFieldArray({ blank: () => (');
                    emitInitial();
                    builder.emit(')');
                    if (c.optionsStart !== null && c.optionsEnd !== null)
                    {
                        builder.emit(', ');
                        emitCode(c.optionsStart + 1, c.optionsEnd - 1);
                    }
                    builder.emit(' }));\n');
                    return;
                }
                usedRuntime.add('createForm');
                builder.emit('const ');
                builder.copy(c.nameStart, c.nameEnd, 'script');
                builder.emit(' = Object.assign(createForm({ initial: (');
                emitInitial();
                builder.emit(')');
                if (c.optionsStart !== null && c.optionsEnd !== null)
                {
                    // INLINE the with-clause interior as direct config properties (not a `...spread` of a
                    // separately-typed object) so `onSubmit`/`validate` get their `values` param contextually
                    // typed as the inferred field shape `T` from `FormConfig<T>`.
                    builder.emit(', ');
                    emitCode(c.optionsStart + 1, c.optionsEnd - 1);
                }
                builder.emit(' }), (');
                emitInitial();
                builder.emit('));\n');
                return;
            }
            case 'resource':
            case 'stream':
            case 'store':
            case 'selector':
            {
                // A factory reads explicitly (NAME.data() / NAME(key)), so it must be typed as what the
                // runtime returns - project the REAL createX(...) call so TypeScript infers Resource<T> /
                // Stream<T> / the store / the selector. (state/derived above instead type the VALUE,
                // because they read plain.) The value/fetcher is copied with mapping; the with-clause
                // source/options are emitted as text (a `source` is almost always one signal read, and
                // type errors there are rare). factoryPlan (ts-slice) owns the shared argument-shape
                // decision; here it is rendered as mapped TS.
                const parsed = parseDeclarationSlice(source, c);
                const optsText = c.optionsStart !== null && c.optionsEnd !== null ? source.slice(c.optionsStart, c.optionsEnd) : null;
                const plan = factoryPlan(c.kind, optsText, parsed?.initializer);
                usedRuntime.add(plan.fn);

                const valueStart = parsed?.initializer ? parsed.mapPos(parsed.initializer.getStart(parsed.sourceFile)) : c.nameEnd;
                const valueEnd = parsed?.initializer ? parsed.mapPos(parsed.initializer.getEnd()) : c.valueEnd;

                builder.emit('const ');
                builder.copy(c.nameStart, c.nameEnd, 'script');
                builder.emit(` = ${ plan.fn }(`);
                if (plan.source !== null)
                {
                    builder.emit(`() => (${ plan.source }), `);
                }
                if (plan.wrapValue)
                {
                    builder.emit('() => (');
                    emitCode(valueStart, valueEnd);
                    builder.emit(')');
                }
                else
                {
                    emitCode(valueStart, valueEnd);
                }
                if (plan.rest !== null)
                {
                    builder.emit(`, ${ plan.rest }`);
                }
                else if (plan.opts !== null)
                {
                    builder.emit(`, ${ plan.opts }`);
                }
                builder.emit(');\n');
                return;
            }
            case 'effect':
            case 'wrapper':
                // A reactive body (effect, or a batch/untrack/cleanup/dispose wrapper) type-checks its
                // statements in component scope. It is wrapped in an ARROW (not a bare block) so a `return`
                // inside - an early-return guard, or an effect's cleanup `return () => ...` - is scoped to the
                // callback exactly as the runtime wraps it (`createEffect(() => {...})`), and never leaks into
                // the component function's own return type.
                builder.emit('void (() => {');
                emitCode(c.bodyStart, c.bodyEnd);
                builder.emit('});\n');
                return;
            case 'watch':
            {
                // `watch (deps) [(params)] { body }` -> `on([() => (dep), ...], (params) => { body })`, so the
                // dependency types flow into `values`/`prev` exactly as the runtime `on` infers them.
                usedRuntime.add(RUNTIME_FN.watch);
                builder.emit(`;${ RUNTIME_FN.watch }([`);
                const deps = splitTopLevelCommaSpans(source, c.depsStart, c.depsEnd);
                deps.forEach((dep, index) =>
                {
                    if (index > 0)
                    {
                        builder.emit(', ');
                    }
                    builder.emit('() => (');
                    emitCode(dep.start, dep.end);
                    builder.emit(')');
                });
                builder.emit('], (');
                if (c.paramsStart !== null && c.paramsEnd !== null)
                {
                    builder.copy(c.paramsStart, c.paramsEnd, 'script');
                }
                builder.emit(') => {');
                emitCode(c.bodyStart, c.bodyEnd);
                builder.emit('});\n');
                return;
            }
            default:
                // props / markup / opaque-statements are never produced by findConstructs.
                return;
        }
    };

    /** Projects one component to a typed TS function with its reactive body rewritten and markup returned. */
    const projectComponent = (component: ComponentDecl): void =>
    {
        builder.emit('function ');
        builder.copy(component.nameStart, component.nameEnd, 'script');
        if (component.typeParams)
        {
            builder.copy(component.typeParams.start, component.typeParams.end, 'script');
        }

        // Props parameter: the type comes from the component's parameter annotation (a named interface or
        // an inline object type - both land in `param.typeSpan` identically). A prop-less component takes
        // no parameter (so `App()` / `<App/>` call with zero arguments). `props` is given a DEFAULT
        // (`= undefined as unknown as P`), which makes the parameter optional - a `.ts` caller of a
        // prop-less component can write `App()`, and `App` is assignable to a zero/one-arg component type -
        // WITHOUT typing `props` as `P | undefined` (so `props.x` reads in the body still type-check). A
        // required prop is still enforced because a `<Card/>` projects to `Card({})` and `{}` is checked
        // against the (required-membered) props type. Declaration emit turns the defaulted parameter into
        // `props?: P` in the `.d.ts`.
        const param = component.propsParam
            ? parseComponentParam(source.slice(component.propsParam.start, component.propsParam.end), component.propsParam.start)
            : { typeSpan: null, patternSpan: null };
        let propsTypeText: string;
        builder.emit('(props: ');
        if (param.typeSpan)
        {
            builder.copy(param.typeSpan.start, param.typeSpan.end, 'script');
            propsTypeText = source.slice(param.typeSpan.start, param.typeSpan.end);
        }
        else
        {
            builder.emit('{}');
            propsTypeText = '{}';
        }
        builder.emit(' = (undefined as unknown as ' + propsTypeText + ')) {\n');

        // A destructuring signature `component Name({ a, b }: P)` projects as a `const { a, b } = props;`
        // binding so the body's bare `a`/`b` type-check (the runtime rewrites them to `props.a`/`props.b`
        // instead, for reactivity). Copied with mapping so rename/hover/refs work on the destructured names.
        if (param.patternSpan)
        {
            builder.emit('const ');
            builder.copy(param.patternSpan.start, param.patternSpan.end, 'script');
            builder.emit(' = props;\n');
        }

        let lastMarkup = -1;
        component.body.forEach((item, index) =>
        {
            if (item.kind === 'markup')
            {
                lastMarkup = index;
            }
        });

        component.body.forEach((item, index) =>
        {
            if (item.kind === 'opaque-statements')
            {
                emitCode(item.start, item.end);
                builder.emit('\n');
                return;
            }
            if (item.kind === 'markup')
            {
                // The rendered output. The last markup is the component's return value, so its inferred
                // type IS the component's real return type (`h()` returns HTMLElement).
                collect(item.node);
                builder.emit(index === lastMarkup ? 'return (' : ';(');
                emitNode(item.node);
                builder.emit(');\n');
                return;
            }
            emitConstruct(item);
        });
        builder.emit('}\n');
    };

    // Top-level transform: opaque regions are emitted as code (nested constructs lowered, markup within
    // them expanded); components are projected to functions. The leading `export` / `export default` lives
    // in the preceding opaque region, so it glues onto the emitted `function Name` and the export form
    // carries through.
    for (const item of module.items)
    {
        if (item.kind === 'opaque')
        {
            emitCode(item.start, item.end);
        }
        else
        {
            projectComponent(item);
        }
    }

    return finalize(builder, source, usedRuntime, usedHandler, usedChildren, usedRender);
}

/** Re-bases every offset field of a {@link BodyItem} returned by a sub-region scan onto the full source. */
function shiftConstruct(c: BodyItem, delta: number): BodyItem
{
    const out = { ...c } as Record<string, unknown>;
    for (const field of OFFSET_FIELDS)
    {
        if (typeof out[field] === 'number')
        {
            out[field] = (out[field] as number) + delta;
        }
    }
    return out as unknown as BodyItem;
}

/**
 * Appends the ambient declarations the projection references - the `AzerothHandler` event-typing helper
 * (when a host handler used it) and `declare const` bindings for `h` / `on` / the built-in components the
 * markup used - so the virtual module type-checks in any `ts.Program`. They are APPENDED (after all user
 * code) and ambient/module-scoped, so user offsets are unchanged and the segments map 1:1 with no shift.
 */
function finalize(builder: Builder, source: string, usedRuntime: Set<string>, usedHandler: boolean, usedChildren: boolean, usedRender: boolean): VirtualCode
{
    const parts: string[] = [];
    if (usedHandler)
    {
        parts.push(AZEROTH_HANDLER_DECL);
    }
    if (usedChildren)
    {
        // Satisfies any declared `children` prop without checking the markup children's value.
        parts.push('declare const __children: { children: any };');
    }
    if (usedRender)
    {
        // Projects a component's MARKUP children (for import-usage + IntelliSense) without type-checking them
        // against the parent's `children` type. A render-callback child does NOT go through here - it is
        // passed as the real typed `children:` prop so its parameters infer from the component's signature -
        // so the only values reaching __azRender are markup thunks / narrowing guards, hence `() => unknown`.
        parts.push('declare function __azRender(render: () => unknown): void;');
    }
    for (const name of usedRuntime)
    {
        if (!alreadyImports(source, name))
        {
            parts.push(`declare const ${ name }: typeof import('${ RUNTIME_MODULE }').${ name };`);
        }
    }
    if (usedRuntime.has('createFieldArray'))
    {
        // Projection-only helper: re-types `NAME.rows()` so each row is `FieldArrayRow<R> & R`. The `& R`
        // half is what makes an array-form `<For>` row variable's field access type-check (mirroring the
        // runtime rewrite of `row.field` to `row.form.values().field`); the rest of FieldArrayApi is kept.
        parts.push(
            `declare function __azRowForm<R extends object>(fa: import('${ RUNTIME_MODULE }').FieldArrayApi<R>): `
            + `Omit<import('${ RUNTIME_MODULE }').FieldArrayApi<R>, 'rows'> `
            + `& { rows: () => Array<import('${ RUNTIME_MODULE }').FieldArrayRow<R> & R> };`
        );
    }
    if (parts.length === 0)
    {
        return { code: builder.out, mapping: new CodeMapping(builder.segments) };
    }
    return { code: `${ builder.out }\n${ parts.join('\n') }\n`, mapping: new CodeMapping(builder.segments) };
}

/**
 * Splits `[start, end)` at top-level commas (ignoring commas nested in brackets, strings, templates, or
 * comments), returning the trimmed span of each part. Used for a `watch`'s dependency list.
 */
function splitTopLevelCommaSpans(source: string, start: number, end: number): Span[]
{
    const spans: Span[] = [];
    let depth = 0;
    let segStart = start;
    let i = start;
    while (i < end)
    {
        const ch = source[i];
        if (ch === '"' || ch === '\'')
        {
            i = skipString(source, i);
            continue;
        }
        if (ch === '`')
        {
            i = skipTemplate(source, i);
            continue;
        }
        if (ch === '/' && source[i + 1] === '/')
        {
            i = skipLineComment(source, i);
            continue;
        }
        if (ch === '/' && source[i + 1] === '*')
        {
            i = skipBlockComment(source, i);
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{')
        {
            depth++;
        }
        else if (ch === ')' || ch === ']' || ch === '}')
        {
            depth--;
        }
        else if (ch === ',' && depth === 0)
        {
            spans.push(trimSpan(source, segStart, i));
            segStart = i + 1;
        }
        i++;
    }
    const last = trimSpan(source, segStart, end);
    if (last.end > last.start)
    {
        spans.push(last);
    }
    return spans;
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
    const close = matchBrace(source, open);
    const inner = trimSpan(source, open + 1, close - 1);
    // Skip a leading `...` so the mapped span covers just the expression.
    if (source.startsWith('...', inner.start))
    {
        return trimSpan(source, inner.start + 3, inner.end);
    }
    return inner;
}

/** Index just past the `}` matching the `{` at `open` (bracket-depth aware, ignoring strings). */
function matchBrace(source: string, open: number): number
{
    let depth = 0;
    let i = open;
    while (i < source.length)
    {
        const ch = source[i];
        if (ch === '"' || ch === '\'')
        {
            i = skipString(source, i);
            continue;
        }
        if (ch === '`')
        {
            i = skipTemplate(source, i);
            continue;
        }
        if (ch === '{')
        {
            depth++;
        }
        else if (ch === '}')
        {
            depth--;
            if (depth === 0)
            {
                return i + 1;
            }
        }
        i++;
    }
    return source.length;
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

// The expression-shape predicates (isFunctionLiteral / isBareReference / isCollectionLiteral) and the
// quoting helpers (objectKey / quoteString) are shared with codegen via markup-util so the virtual
// module mirrors the shipped output exactly. Only the projection-specific render-callback predicate
// lives here.

/**
 * True for a render CALLBACK whose first parameter needs contextual typing - `item => ...` or
 * `(item, index) => ...`. Deliberately NOT true for a no-arg arrow (`() => ...`) or an IIFE (`(() => ...)()`):
 * those have no parameter to type and must be wrapped, not passed bare to `__azRender`.
 */
function isRenderCallback(code: string): boolean
{
    return /^[A-Za-z_$][\w$]*\s*=>/.test(code) || /^\(\s*[A-Za-z_$]/.test(code);
}
