/**
 * MODULE: compiler/walk - the shared scope-aware reactive traversal
 *
 * Both the dependency collector (resolve.ts) and the R2 rewriter (rewrite.ts) walk a TypeScript
 * expression the SAME way - tracking lexical scopes so a local binding shadows a reactive source of
 * the same name - so the two CANNOT diverge on which identifiers are reactive. The only difference is
 * what they do with the events, which is why this is a hooks-driven traversal.
 *
 * EVENTS:
 *   - `read`      - an unshadowed read of a state/derived source.
 *   - `propsRead` - a `props.field` access (or a bare `props`, field '*').
 *   - `write`     - an assignment / ++ / -- whose target is a reactive source.
 *
 * Write targets are reported via `write`, never `read`, so a pure write (`x = 1`) is not mistaken for
 * a dependency.
 *
 * @see {@link traverseReactive}
 * @internal Compiler analysis primitive; not part of the package's public API.
 */

import * as ts from 'typescript';

import type { ReactiveSources } from './dep.ts';

import { MARKER_MEMO, MARKER_SIGNAL, MARKER_DEFERRED } from './markers.ts';

/** Callbacks invoked as {@link traverseReactive} walks reactive references. */
export interface ReactiveHooks
{
    /** An unshadowed read of a `state`/`derived` source. */
    read?(node: ts.Identifier): void;
    /** A `props.field` access, or a bare `props` read (`field === '*'`). */
    propsRead?(node: ts.Node, field: string): void;
    /**
     * An assignment / `++` / `--` whose target is a reactive source. `writable` is false for a
     * read-only source (a `derived`, or a nested `derived` marker) - the consumer rejects it.
     */
    write?(target: ts.Identifier, expression: ts.Node, writable: boolean): void;
    /** A FIELD read on a `form` source (`formName.field`), where `field` is one of the form's initial keys. */
    formFieldRead?(node: ts.PropertyAccessExpression): void;
    /** An assignment / `++` / `--` whose target is a `form` field (`formName.field`). Always writable. */
    formWrite?(target: ts.PropertyAccessExpression, expression: ts.Node): void;
    /** A FIELD read on an array-form ROW variable (`rowName.field`), where `field` is a blank-row key. */
    rowFieldRead?(node: ts.PropertyAccessExpression): void;
    /** An assignment / `++` / `--` whose target is a ROW field (`rowName.field`). Always writable. */
    rowFieldWrite?(target: ts.PropertyAccessExpression, expression: ts.Node): void;
}

/** True for an `=`/`+=`/`&&=`/... assignment operator. */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean
{
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * traverseReactive
 *
 * PURPOSE:
 * Walks `root`, invoking `hooks` for every reactive reference, with correct lexical scoping (locals
 * shadow reactive sources of the same name).
 *
 * WHY IT EXISTS:
 * The dependency collector and the rewriter must agree on "which references here are reactive". A
 * single shared, scope-aware traversal makes divergence impossible - each consumer just supplies
 * different hooks.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler analysis primitive; backs both {@link traverseReactive}'s consumers - resolve.collectReads
 * (deps) and rewrite (getter/setter edits).
 *
 * INPUT CONTRACT:
 * - root: a parsed expression/statements node (e.g. a `ts.SourceFile` from ts-slice.ts).
 * - sources: the component's reactive-source set (names + hasProps).
 * - hooks: {@link ReactiveHooks} - read / propsRead / write callbacks (all optional).
 *
 * OUTPUT CONTRACT:
 * - None; it is a visitor. All output flows through the hooks.
 *
 * WHY THIS DESIGN:
 * A shadow stack of locally-bound names is pushed per scope, so an inner binding (param, const,
 * destructure) that shadows a source name suppresses the reactive event for reads of that name within
 * the scope. That syntactic shadow tracking is what makes compile-time reactivity sound.
 *
 * WHEN TO USE:
 * Any pass that needs "which reactive refs does this code contain" with scope correctness.
 *
 * WHEN NOT TO USE:
 * Cross-statement data-flow reasoning - this is a syntactic scope walk, not a type/flow analysis.
 *
 * EDGE CASES:
 * - A bare `props` read is reported as field '*' (a whole-bag dependency).
 * - Destructuring patterns bind every introduced name into the current shadow scope.
 * - Write targets fire `write`, never `read`.
 *
 * PERFORMANCE NOTES:
 * A single AST walk, O(nodes).
 *
 * DEVELOPER WARNING:
 * Scope tracking is lexical/syntactic only - it does not resolve imports or types. A name present in
 * `sources` is assumed to BE that source unless lexically shadowed.
 *
 * @param root - The parsed expression/statements (e.g. a `ts.SourceFile`)
 * @param sources - The component's reactive sources
 * @param hooks - What to do on each read / props-read / write
 * @see {@link ReactiveHooks}
 *
 * @internal
 */
export function traverseReactive(root: ts.Node, sources: ReactiveSources, hooks: ReactiveHooks): void
{
    // Each lexical scope tracks plain locals that SHADOW a source (`shadows`) and nested keyword
    // sources lowered to markers (`scoped`, name -> writable). A `derived`/`state` keyword used inside
    // a function/block (a render callback, an IIFE, a composable) becomes a `__azMemo`/`__azSignal`
    // marker declaration; the walk treats it as a reactive SOURCE within its scope rather than a
    // shadowing local, so its bare reads gain `()` exactly like a top-level source.
    interface Scope { shadows: Set<string>; scoped: Map<string, boolean> }
    const scopeStack: Scope[] = [];

    const top = (): Scope | undefined => scopeStack[scopeStack.length - 1];

    const isScopedSource = (name: string): boolean =>
        scopeStack.some(scope => scope.scoped.has(name));

    const interesting = (name: string): boolean =>
        sources.names.has(name) || (sources.hasProps && name === 'props') || isScopedSource(name)
        || (sources.propAliases?.has(name) ?? false) || (sources.forms?.has(name) ?? false);

    const isShadowed = (name: string): boolean =>
        scopeStack.some(scope => scope.shadows.has(name));

    /** True when `objName` is an unshadowed `form` source and `fieldName` is one of its initial-object keys. */
    const formFieldOf = (objName: string, fieldName: string): boolean =>
        !isShadowed(objName) && (sources.forms?.get(objName)?.has(fieldName) ?? false);

    /** True when `objName` is an unshadowed array-form ROW variable and `fieldName` is a blank-row key.
     *  Row variables are NOT in `interesting()`, so a `<For>` arrow param of the same name is never bound
     *  as a shadowing local - the field access below it still resolves. */
    const rowFieldOf = (objName: string, fieldName: string): boolean =>
        !isShadowed(objName) && (sources.rowForms?.get(objName)?.has(fieldName) ?? false);

    /** Resolves a name innermost-first: a scoped marker source (with writability), a shadowing local, or
     *  finally the component's flat sources. Returns null when the name is not reactive here. */
    const resolveSource = (name: string): { writable: boolean } | null =>
    {
        for (let k = scopeStack.length - 1; k >= 0; k--)
        {
            const scope = scopeStack[k];
            if (scope === undefined)
            {
                continue;
            }
            const scoped = scope.scoped.get(name);
            if (scoped !== undefined)
            {
                return { writable: scoped };
            }
            if (scope.shadows.has(name))
            {
                return null;
            }
        }
        if (sources.names.has(name))
        {
            return { writable: sources.writable === undefined ? true : sources.writable.has(name) };
        }
        return null;
    };

    const bind = (name: string): void =>
    {
        if (interesting(name))
        {
            top()?.shadows.add(name);
        }
    };

    const addScoped = (name: string, writable: boolean): void =>
    {
        top()?.scoped.set(name, writable);
    };

    /** Recognises a marker declaration (`const x = __azMemo(...)` / `const [x, setX] = __azSignal(...)`)
     *  and registers its name as a scoped source. Returns true when it handled the declaration. */
    const tryScopedDeclaration = (n: ts.VariableDeclaration): boolean =>
    {
        if (n.initializer === undefined || !ts.isCallExpression(n.initializer) || !ts.isIdentifier(n.initializer.expression))
        {
            return false;
        }
        const callee = n.initializer.expression.text;
        if ((callee === MARKER_MEMO || callee === MARKER_DEFERRED) && ts.isIdentifier(n.name))
        {
            addScoped(n.name.text, false);
            return true;
        }
        if (callee === MARKER_SIGNAL && ts.isArrayBindingPattern(n.name))
        {
            const first = n.name.elements[0];
            if (first !== undefined && ts.isBindingElement(first) && ts.isIdentifier(first.name))
            {
                addScoped(first.name.text, true);
            }
            return true;
        }
        return false;
    };

    const bindName = (name: ts.BindingName): void =>
    {
        if (ts.isIdentifier(name))
        {
            bind(name.text);
            return;
        }
        for (const element of name.elements)
        {
            if (ts.isBindingElement(element))
            {
                // A computed property name in an object pattern (`{ [key]: a }`) is an
                // EXPRESSION evaluated where the pattern sits - it reads, so traverse it.
                if (element.propertyName !== undefined && ts.isComputedPropertyName(element.propertyName))
                {
                    visit(element.propertyName.expression);
                }
                bindName(element.name);
                // A default value (`{ a = x }`, `[a = x]`) is an expression evaluated when
                // the bound value is missing; reads inside it (e.g. a `state` read) must be
                // detected and rewritten just like any other read. Without this they leak
                // through unrewritten - a reactive false negative.
                if (element.initializer !== undefined)
                {
                    visit(element.initializer);
                }
            }
        }
    };

    const reference = (id: ts.Identifier): void =>
    {
        const name = id.text;
        if (sources.hasProps && name === 'props' && !isShadowed('props'))
        {
            hooks.propsRead?.(id, '*');
            return;
        }
        if (resolveSource(name) !== null)
        {
            hooks.read?.(id);
            return;
        }
        // A destructured-prop alias (`component Name({ a }: P)`) reads like `props.a` - a props dependency
        // for the collector, and a bare-identifier the rewrite replaces with the aliased expression.
        if (sources.propAliases?.has(name) && !isShadowed(name))
        {
            hooks.propsRead?.(id, name);
        }
    };

    const isFunctionScope = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
        ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

    const isBlockScope = (n: ts.Node): boolean =>
        ts.isBlock(n) || ts.isForStatement(n) || ts.isForInStatement(n) ||
        ts.isForOfStatement(n) || ts.isCatchClause(n) || ts.isCaseBlock(n);

    const visit = (n: ts.Node): void =>
    {
        if (n.kind >= ts.SyntaxKind.FirstTypeNode && n.kind <= ts.SyntaxKind.LastTypeNode)
        {
            return;
        }

        // Assignment / update to a reactive source -> a write (not a read).
        if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind))
        {
            if (ts.isIdentifier(n.left))
            {
                const source = resolveSource(n.left.text);
                if (source !== null)
                {
                    hooks.write?.(n.left, n, source.writable);
                    visit(n.right);
                    return;
                }
            }
            // A write to a `form` field (`formName.field = v`) -> the form's setValue.
            if (ts.isPropertyAccessExpression(n.left) && ts.isIdentifier(n.left.expression)
                && formFieldOf(n.left.expression.text, n.left.name.text))
            {
                hooks.formWrite?.(n.left, n);
                visit(n.right);
                return;
            }
            // A write to an array-form ROW field (`rowName.field = v`) -> the row form's setValue.
            if (ts.isPropertyAccessExpression(n.left) && ts.isIdentifier(n.left.expression)
                && rowFieldOf(n.left.expression.text, n.left.name.text))
            {
                hooks.rowFieldWrite?.(n.left, n);
                visit(n.right);
                return;
            }
        }
        if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
            (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken))
        {
            if (ts.isIdentifier(n.operand))
            {
                const source = resolveSource(n.operand.text);
                if (source !== null)
                {
                    hooks.write?.(n.operand, n, source.writable);
                    return;
                }
            }
            if (ts.isPropertyAccessExpression(n.operand) && ts.isIdentifier(n.operand.expression)
                && formFieldOf(n.operand.expression.text, n.operand.name.text))
            {
                hooks.formWrite?.(n.operand, n);
                return;
            }
            if (ts.isPropertyAccessExpression(n.operand) && ts.isIdentifier(n.operand.expression)
                && rowFieldOf(n.operand.expression.text, n.operand.name.text))
            {
                hooks.rowFieldWrite?.(n.operand, n);
                return;
            }
        }

        if (ts.isPropertyAccessExpression(n))
        {
            const object = n.expression;
            if (sources.hasProps && ts.isIdentifier(object) && object.text === 'props' && !isShadowed('props'))
            {
                hooks.propsRead?.(n, n.name.text);
                return;
            }
            // A `form` FIELD read (`formName.field`) - rewritten to `formName.values().field`. A non-field
            // member (`formName.errors`, `formName.handleSubmit`) is real FormApi and falls through unchanged.
            if (ts.isIdentifier(object) && formFieldOf(object.text, n.name.text))
            {
                hooks.formFieldRead?.(n);
                return;
            }
            // An array-form ROW FIELD read (`rowName.field`) - rewritten to `rowName.form.values().field`.
            // `rowName.key` / `rowName.form` / FormApi access (`rowName.form.errors()`) are not fields and
            // fall through unchanged.
            if (ts.isIdentifier(object) && rowFieldOf(object.text, n.name.text))
            {
                hooks.rowFieldRead?.(n);
                return;
            }
            visit(object);
            return;
        }
        if (ts.isElementAccessExpression(n))
        {
            visit(n.expression);
            visit(n.argumentExpression);
            return;
        }

        if (ts.isPropertyAssignment(n))
        {
            if (ts.isComputedPropertyName(n.name))
            {
                visit(n.name.expression);
            }
            visit(n.initializer);
            return;
        }
        if (ts.isShorthandPropertyAssignment(n))
        {
            reference(n.name);
            if (n.objectAssignmentInitializer)
            {
                visit(n.objectAssignmentInitializer);
            }
            return;
        }

        if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n))
        {
            // A nested keyword marker (`const x = __azMemo(...)` / `const [x, setX] = __azSignal(...)`)
            // registers x as a scoped reactive source instead of a shadowing local.
            if (!(ts.isVariableDeclaration(n) && tryScopedDeclaration(n)))
            {
                bindName(n.name);
            }
            if (n.initializer)
            {
                visit(n.initializer);
            }
            return;
        }

        if (ts.isIdentifier(n))
        {
            reference(n);
            return;
        }

        if (isFunctionScope(n))
        {
            if (ts.isFunctionDeclaration(n) && n.name)
            {
                bind(n.name.text);
            }
            scopeStack.push({ shadows: new Set(), scoped: new Map() });
            if (ts.isFunctionExpression(n) && n.name)
            {
                bind(n.name.text);
            }
            for (const parameter of n.parameters)
            {
                visit(parameter);
            }
            if (n.body)
            {
                visit(n.body);
            }
            scopeStack.pop();
            return;
        }

        if (isBlockScope(n))
        {
            scopeStack.push({ shadows: new Set(), scoped: new Map() });
            ts.forEachChild(n, visit);
            scopeStack.pop();
            return;
        }

        ts.forEachChild(n, visit);
    };

    scopeStack.push({ shadows: new Set(), scoped: new Map() });
    ts.forEachChild(root, visit);
    scopeStack.pop();
}
