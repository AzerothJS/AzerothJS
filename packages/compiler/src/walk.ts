/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The shared scope-aware reactive traversal.
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

import { MARKER_MEMO, MARKER_SIGNAL, MARKER_DEFERRED, MARKER_ROW } from './markers.ts';

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
    /** A FIELD read on an array-form ROW variable (`rowName.field`), where `field` is a blank-row
     *  key. `viaGetter` is true when the row variable is a `<For>` getter param (a rowItem or a
     *  marker-scoped row param) - the WALK resolves this, because only it sees the marker scopes
     *  of the raw/hole path; a hook re-deriving it from rowItems emits record-shaped sugar on a
     *  getter and crashes at first render. */
    rowFieldRead?(node: ts.PropertyAccessExpression, viaGetter: boolean): void;
    /** An assignment / `++` / `--` whose target is a ROW field (`rowName.field`). Always writable;
     *  `viaGetter` as on {@link rowFieldRead}. */
    rowFieldWrite?(target: ts.PropertyAccessExpression, expression: ts.Node, viaGetter: boolean): void;
    /**
     * An unshadowed read of a `<For>` row-item getter param: a bare `item`, or the `item` of a member
     * access not claimed by {@link rowFieldRead}. The rewrite appends the getter call.
     */
    rowItemRead?(node: ts.Identifier): void;
    /**
     * A `__azRow(fn)` row marker (a For render child emitted in raw mode). The walk scopes the
     * wrapped arrow's params as row items; the rewrite consumer strips the wrapper call.
     */
    rowMarker?(call: ts.CallExpression): void;
}

/** True for an `=`/`+=`/`&&=`/... assignment operator. */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean
{
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * Walks `root`, invoking `hooks` for every reactive reference, with lexical scoping: a local
 * binding shadows a reactive source of the same name.
 *
 * A shadow stack of locally-bound names is pushed per scope, so a parameter, const or
 * destructured name that shadows a source suppresses the reactive event for reads of that
 * name inside the scope. That syntactic shadow tracking is what makes compile-time reactivity
 * sound.
 *
 * Scope tracking is lexical ONLY. It does not resolve imports or consult types, so a name
 * present in `sources` is assumed to BE that source unless lexically shadowed. It is likewise
 * a scope walk, not data-flow analysis.
 *
 * A bare `props` read is reported with field `'*'`, a whole-bag dependency. A write target
 * fires `write` and never `read`, so a pure write is not mistaken for a dependency.
 *
 * @param root - A parsed expression or statement list.
 * @param sources - The component's reactive-source names, and whether it takes props.
 * @param hooks - Read, props-read and write callbacks, all optional.
 * @internal
 */
export function traverseReactive(root: ts.Node, sources: ReactiveSources, hooks: ReactiveHooks, generatedMarkers = true): void
{
    // Each lexical scope tracks plain locals that SHADOW a source (`shadows`) and nested keyword
    // sources lowered to markers (`scoped`, name -> writable). A `derived`/`state` keyword used inside
    // a function/block (a render callback, an IIFE, a composable) becomes a `__azMemo`/`__azSignal`
    // marker declaration; the walk treats it as a reactive SOURCE within its scope rather than a
    // shadowing local, so its bare reads gain `()` exactly like a top-level source.
    interface Scope
    {
        shadows: Set<string>;
        scoped: Map<string, boolean>;
        rows: Set<string>;
        /** Ordinary helper parameters that receive array-form records by the registered row name. */
        records?: Set<string>;
    }
    const scopeStack: Scope[] = [];

    // Arrows wrapped by a `__azRow(...)` marker in the walked text - For render children whose
    // emission was RAW (markup embedded in an expression), so their row-param knowledge had to
    // cross the text boundary. Their params are runtime getters and scope as row items. The
    // marker is compiler-emitted only; a hand-written `For({ children: fn })` call carries no
    // marker and is walked as the ordinary user code it is.
    const rowMarkerArrows = new Set<ts.Node>();

    const top = (): Scope | undefined => scopeStack[scopeStack.length - 1];

    const isScopedSource = (name: string): boolean =>
        scopeStack.some(scope => scope.scoped.has(name));

    const propsName = sources.hasProps && sources.paramName !== null ? sources.paramName ?? 'props' : null;

    const interesting = (name: string): boolean =>
        sources.names.has(name) || name === propsName || isScopedSource(name)
        || (sources.propAliases?.has(name) ?? false) || (sources.forms?.has(name) ?? false);

    /** The nearest declaration decides whether an occurrence names a local, a getter or a keyword. */
    const bindingScope = (name: string): Scope | undefined =>
        scopeStack.findLast(scope => scope.shadows.has(name) || scope.rows.has(name) || scope.scoped.has(name));

    const isShadowed = (name: string): boolean => bindingScope(name)?.shadows.has(name) ?? false;

    /** A raw render child declares its getter in the walk; a detached IR child supplies it as a source. */
    const rowItemOf = (name: string): boolean =>
    {
        const owner = bindingScope(name);
        return owner !== undefined ? owner.rows.has(name) : (sources.rowItems?.has(name) ?? false);
    };

    const formFieldOf = (name: string, field: string): boolean =>
        (sources.forms?.get(name)?.has(field) ?? false) && bindingScope(name) === undefined
        && !(sources.rowItems?.has(name) ?? false);

    /** Global record-style row sugar still applies to ordinary helpers. Inside a row callback,
     *  a nearer declaration can instead name a plain local or a nested row getter. */
    const rowFieldOf = (name: string, field: string): boolean =>
    {
        if (!sources.rowForms?.get(name)?.has(field))
        {
            return false;
        }
        const owner = bindingScope(name);
        return owner === undefined || owner.rows.has(name) || (owner.records?.has(name) ?? false);
    };

    /** Named record parameters can occur in nested helpers; a getter or plain local masks the convention. */
    const recordParameter = (name: string): boolean =>
    {
        if (!sources.rowForms?.has(name))
        {
            return false;
        }
        const owner = bindingScope(name);
        return owner === undefined ? !sources.rowItems?.has(name) : (owner.records?.has(name) ?? false);
    };

    /** A nested binding with the same name takes precedence over the component's argument. */
    const isComponentProps = (name: string): boolean =>
        name === propsName && !isShadowed(name) && !isScopedSource(name) && !rowItemOf(name);

    /** Resolves a name innermost-first: a scoped marker source (with writability), a shadowing local, or
     *  finally the component's flat sources. Returns null when the name is not reactive here. */
    const resolveSource = (name: string): { writable: boolean } | null =>
    {
        const owner = bindingScope(name);
        if (owner !== undefined)
        {
            const writable = owner.scoped.get(name);
            return writable !== undefined ? { writable } : null;
        }
        if (sources.names.has(name) && !sources.rowItems?.has(name))
        {
            return { writable: sources.writable === undefined ? true : sources.writable.has(name) };
        }
        return null;
    };

    const bind = (name: string): void =>
    {
        if (interesting(name) || rowItemOf(name) || bindingScope(name)?.records?.has(name))
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
        if (!generatedMarkers || n.initializer === undefined || !ts.isCallExpression(n.initializer) || !ts.isIdentifier(n.initializer.expression))
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

    const visitBinding = (name: ts.BindingName, declare?: (name: string) => void, read?: (expr: ts.Expression) => void): void =>
    {
        if (ts.isIdentifier(name))
        {
            declare?.(name.text);
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
                    read?.(element.propertyName.expression);
                }
                visitBinding(element.name, declare, read);
                // A default value (`{ a = x }`, `[a = x]`) is an expression evaluated when
                // the bound value is missing; reads inside it (e.g. a `state` read) must be
                // detected and rewritten just like any other read. Without this they leak
                // through unrewritten - a reactive false negative.
                if (element.initializer !== undefined)
                {
                    read?.(element.initializer);
                }
            }
        }
    };

    const reference = (id: ts.Identifier): void =>
    {
        const name = id.text;
        if (isComponentProps(name))
        {
            hooks.propsRead?.(id, '*');
            return;
        }
        if (resolveSource(name) !== null)
        {
            hooks.read?.(id);
            return;
        }
        // A bare read of a row-item getter param (`{ item }` hole, `remove(item)`) - the rewrite
        // appends the call so the CURRENT item flows, not the one the row was built from.
        if (rowItemOf(name))
        {
            hooks.rowItemRead?.(id);
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

    const bindLexicalList = (list: ts.VariableDeclarationList): void =>
    {
        if (list.flags & ts.NodeFlags.BlockScoped)
        {
            for (const declaration of list.declarations)
            {
                if (!tryScopedDeclaration(declaration))
                {
                    visitBinding(declaration.name, bind);
                }
            }
        }
    };

    /** A closure before a later declaration already resolves that name to the same block. */
    const bindStatements = (statements: ts.NodeArray<ts.Statement>): void =>
    {
        for (const statement of statements)
        {
            if (ts.isVariableStatement(statement))
            {
                bindLexicalList(statement.declarationList);
            }
            else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)
                || ts.isModuleDeclaration(statement)) && statement.name && ts.isIdentifier(statement.name))
            {
                bind(statement.name.text);
            }
        }
    };

    /** A var inside a nested block belongs to the function body. Parameter defaults are
     *  evaluated outside that body. Skip the extra scan for ordinary var-free slices. */
    const hasVar = /\bvar\b/.test(root.getSourceFile().text);
    const bindVars = (n: ts.Node): void =>
    {
        if (ts.isFunctionLike(n) || ts.isClassLike(n) || ts.isModuleDeclaration(n))
        {
            return;
        }
        if (ts.isVariableDeclarationList(n))
        {
            if (!(n.flags & ts.NodeFlags.BlockScoped))
            {
                for (const declaration of n.declarations)
                {
                    visitBinding(declaration.name, bind);
                }
            }
            return;
        }
        ts.forEachChild(n, bindVars);
    };

    const visit = (n: ts.Node): void =>
    {
        if ((n.kind >= ts.SyntaxKind.FirstTypeNode && n.kind <= ts.SyntaxKind.LastTypeNode)
            || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeParameterDeclaration(n)
            || (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword))
        {
            return;
        }

        // A `__azRow(fn)` row marker: the compiler's own raw-mode emission of a For render
        // child (see MARKER_ROW). Register the wrapped arrow BEFORE traversal reaches it, so
        // its params scope as row-item getters, and report the call so the rewrite strips the
        // wrapper. An occurrence is either rewritten immediately with IR rowItems (non-raw, no
        // marker emitted) or deferred behind this marker - never both, because both are chosen
        // by the same `emit.raw` flag at the same emission site.
        if (generatedMarkers && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === MARKER_ROW)
        {
            let wrapped: ts.Node | undefined = n.arguments[0];
            while (wrapped !== undefined && ts.isParenthesizedExpression(wrapped))
            {
                wrapped = wrapped.expression;
            }
            if (wrapped !== undefined && (ts.isArrowFunction(wrapped) || ts.isFunctionExpression(wrapped)))
            {
                rowMarkerArrows.add(wrapped);
                hooks.rowMarker?.(n);
            }
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
                hooks.rowFieldWrite?.(n.left, n, rowItemOf((n.left.expression).text));
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
                hooks.rowFieldWrite?.(n.operand, n, rowItemOf((n.operand.expression).text));
                return;
            }
        }

        if (ts.isPropertyAccessExpression(n))
        {
            const object = n.expression;
            if (ts.isIdentifier(object) && isComponentProps(object.text))
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
            // An array-form ROW FIELD read (`rowName.field`) - rewritten to `rowName.form.values().field`
            // (through the getter call when the row var is also a rowItem). `rowName.key` / `rowName.form`
            // / FormApi access (`rowName.form.errors()`) are not fields and fall to the rowItem check.
            if (ts.isIdentifier(object) && rowFieldOf(object.text, n.name.text))
            {
                hooks.rowFieldRead?.(n, rowItemOf(object.text));
                return;
            }
            // Any other member access through a row-item getter param (`item.name`) - the rewrite
            // appends the call: `item().name`.
            if (ts.isIdentifier(object) && rowItemOf(object.text))
            {
                hooks.rowItemRead?.(object);
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
                visitBinding(n.name, bind, visit);
            }
            if (n.initializer)
            {
                visit(n.initializer);
            }
            return;
        }

        if (ts.isIdentifier(n))
        {
            // A literal class field key is a name. Its initializer and computed keys are reads.
            if (!(ts.isPropertyDeclaration(n.parent) && n.parent.name === n))
            {
                reference(n);
            }
            return;
        }

        if (ts.isLabeledStatement(n))
        {
            visit(n.statement);
            return;
        }
        if (ts.isBreakOrContinueStatement(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isMetaProperty(n))
        {
            return;
        }
        if (ts.isModuleDeclaration(n))
        {
            if (ts.isIdentifier(n.name))
            {
                bind(n.name.text);
            }
            if (n.body)
            {
                scopeStack.push({ shadows: new Set(), scoped: new Map(), rows: new Set() });
                if (ts.isModuleBlock(n.body))
                {
                    bindStatements(n.body.statements);
                    if (hasVar)
                    {
                        bindVars(n.body);
                    }
                }
                visit(n.body);
                scopeStack.pop();
            }
            return;
        }
        if (ts.isClassLike(n))
        {
            if (ts.isClassDeclaration(n) && n.name)
            {
                bind(n.name.text);
            }
            scopeStack.push({ shadows: new Set(), scoped: new Map(), rows: new Set() });
            if (ts.isClassExpression(n) && n.name)
            {
                bind(n.name.text);
            }
            ts.forEachChild(n, child =>
            {
                if (child !== n.name)
                {
                    visit(child);
                }
            });
            scopeStack.pop();
            return;
        }
        if (ts.isEnumDeclaration(n))
        {
            bind(n.name.text);
            scopeStack.push({ shadows: new Set(), scoped: new Map(), rows: new Set() });
            for (const member of n.members)
            {
                const name = member.name;
                if (ts.isIdentifier(name) || ts.isStringLiteral(name))
                {
                    bind(name.text);
                }
                else if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
                {
                    bind(name.expression.text);
                }
            }
            for (const member of n.members)
            {
                if (member.initializer)
                {
                    visit(member.initializer);
                }
            }
            scopeStack.pop();
            return;
        }

        if (isFunctionScope(n))
        {
            // A method decorator evaluates in the enclosing scope, before its parameters bind.
            if (ts.canHaveDecorators(n))
            {
                for (const decorator of ts.getDecorators(n) ?? [])
                {
                    visit(decorator.expression);
                }
            }
            if (n.name && ts.isComputedPropertyName(n.name))
            {
                visit(n.name.expression);
            }
            if (ts.isFunctionDeclaration(n) && n.name)
            {
                bind(n.name.text);
            }
            const scope: Scope = { shadows: new Set(), scoped: new Map(), rows: new Set() };
            scopeStack.push(scope);
            if (ts.isFunctionExpression(n) && n.name)
            {
                bind(n.name.text);
            }
            // All parameters already bind when a default is evaluated, including later
            // parameters in their temporal dead zone. Separate binding from evaluation.
            const rowArrow = rowMarkerArrows.has(n);
            for (const parameter of n.parameters)
            {
                const name = ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
                if (rowArrow && name !== undefined)
                {
                    scope.rows.add(name);
                }
                else if (name !== undefined && recordParameter(name))
                {
                    // A helper can receive a record indirectly. Its parameter shadows the
                    // component receiver while retaining registered fields such as row.qty.
                    scope.shadows.add(name);
                    (scope.records ??= new Set()).add(name);
                }
                else
                {
                    visitBinding(parameter.name, bind);
                }
            }
            for (const parameter of n.parameters)
            {
                visitBinding(parameter.name, undefined, visit);
                if (parameter.initializer)
                {
                    visit(parameter.initializer);
                }
            }
            if (n.body)
            {
                if (hasVar)
                {
                    bindVars(n.body);
                }
                visit(n.body);
            }
            scopeStack.pop();
            return;
        }

        if (isBlockScope(n))
        {
            scopeStack.push({ shadows: new Set(), scoped: new Map(), rows: new Set() });
            if (ts.isBlock(n))
            {
                bindStatements(n.statements);
                if (hasVar && ts.isClassStaticBlockDeclaration(n.parent))
                {
                    bindVars(n);
                }
            }
            else if (ts.isCaseBlock(n))
            {
                for (const clause of n.clauses)
                {
                    bindStatements(clause.statements);
                }
            }
            else if (ts.isCatchClause(n) && n.variableDeclaration)
            {
                visitBinding(n.variableDeclaration.name, bind);
            }
            else if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n))
                && n.initializer && ts.isVariableDeclarationList(n.initializer))
            {
                bindLexicalList(n.initializer);
            }
            ts.forEachChild(n, visit);
            scopeStack.pop();
            return;
        }

        ts.forEachChild(n, visit);
    };

    scopeStack.push({ shadows: new Set(sources.locals), scoped: new Map(), rows: new Set() });
    if (ts.isSourceFile(root))
    {
        bindStatements(root.statements);
        if (hasVar)
        {
            bindVars(root);
        }
    }
    ts.forEachChild(root, visit);
    scopeStack.pop();
}
