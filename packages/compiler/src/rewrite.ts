/**
 * MODULE: compiler/rewrite - the R2 reactive rewrite
 *
 * Rewrites an expression's source so reactive reads/writes become signal getter/setter calls - the
 * core compile-time-reactivity transform:
 *   - a read of a `state`/`derived` `x` becomes `x()`;
 *   - a `props.f` read is left as-is (props is a getter OBJECT - reading the property runs its getter,
 *     so reactivity flows without a call);
 *   - `x = e` becomes `setX(e)`;
 *   - compound and ++/-- writes become functional-updater setter calls.
 * A local that shadows a reactive name is left alone - the rewriter uses the SAME scope-aware walk
 * (walk.ts) the dependency collector uses, so the two cannot disagree about what is reactive.
 *
 * MECHANISM: parse the expression with TypeScript, collect position-based edits, and
 * splice them into the source slice - so non-reactive parts stay byte-identical (good for source
 * fidelity and source maps). It does NOT re-print the AST.
 *
 * @see {@link rewriteReactive} - rewrite an expression
 * @see {@link rewriteStatements} - rewrite a statement list
 * @internal Compiler codegen-support stage; not part of the package's public API.
 */

import * as ts from 'typescript';

import type { ReactiveSources } from './dep.ts';

import { parseExpressionSlice, parseStatementsSlice } from './ts-slice.ts';
import { traverseReactive } from './walk.ts';
import { CompileError } from './markup-parser.ts';

/** A position-based text edit (insertion when `start === end`). */
interface Edit
{
    start: number;
    end: number;
    text: string;
}

/** The functional-updater parameter name (unlikely to collide with user code). */
const PREV = '__p';

/** Compound-assignment operator -> its binary operator. */
const COMPOUND: ReadonlyMap<ts.SyntaxKind, string> = new Map([
    [ts.SyntaxKind.PlusEqualsToken, '+'],
    [ts.SyntaxKind.MinusEqualsToken, '-'],
    [ts.SyntaxKind.AsteriskEqualsToken, '*'],
    [ts.SyntaxKind.SlashEqualsToken, '/'],
    [ts.SyntaxKind.PercentEqualsToken, '%'],
    [ts.SyntaxKind.AsteriskAsteriskEqualsToken, '**'],
    [ts.SyntaxKind.AmpersandEqualsToken, '&'],
    [ts.SyntaxKind.BarEqualsToken, '|'],
    [ts.SyntaxKind.CaretEqualsToken, '^'],
    [ts.SyntaxKind.LessThanLessThanEqualsToken, '<<'],
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, '>>'],
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, '>>>'],
    [ts.SyntaxKind.AmpersandAmpersandEqualsToken, '&&'],
    [ts.SyntaxKind.BarBarEqualsToken, '||'],
    [ts.SyntaxKind.QuestionQuestionEqualsToken, '??']
]);

/**
 * The setter name for a state declaration: `count` -> `setCount`. Codegen must declare the setter
 * with this same name so the rewritten writes resolve.
 *
 * @param name - The state source name.
 * @returns The conventional setter name (`set` + capitalised name).
 * @example
 * ```ts
 * setterName('count'); // 'setCount'
 * ```
 * @internal
 */
/**
 * The single source of truth for the "assigned a derived" error message, shared by the
 * reactive-rewrite guard (this module) and the semantic diagnostic (diagnostics.ts) so both
 * phases report identically.
 *
 * @param name - The derived value's name.
 * @returns The error message.
 * @internal
 */
export function assignToDerivedMessage(name: string): string
{
    return `Cannot assign to \`${ name }\`: a \`derived\` value is read-only. Compute it from \`state\`, or make \`${ name }\` a \`state\` if it must change.`;
}

export function setterName(name: string): string
{
    return `set${ name.charAt(0).toUpperCase() }${ name.slice(1) }`;
}

/** Member access for a (possibly non-identifier) key: `.name` for an identifier, else `["..."]`. */
function memberAccess(key: string): string
{
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${ key }` : `[${ JSON.stringify(key) }]`;
}

/**
 * rewriteReactive
 *
 * PURPOSE:
 * Rewrites reactive reads and writes in an expression's source, returning the transformed source text.
 *
 * WHY IT EXISTS:
 * It is the core compile-time-reactivity transform - turning ordinary-looking reads/writes of state
 * into signal getter/setter calls so authored code stays plain while the output is fine-grained.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, codegen-support; called by codegen for every emitted expression (state/derived
 * initializers, attribute/text holes, prop values).
 *
 * INPUT CONTRACT:
 * - code: the expression source (no wrapping parens; they're added internally for parsing).
 * - sources: the component's reactive-source set (names + hasProps).
 *
 * OUTPUT CONTRACT:
 * - The rewritten expression source, byte-identical except at reactive read/write positions.
 *
 * WHY THIS DESIGN:
 * It splices position-based edits into the original slice rather than re-printing the AST, so
 * formatting, comments, and non-reactive sub-expressions are preserved exactly - which keeps source
 * maps accurate. Scope-awareness (via walk.ts) leaves shadowing locals untouched.
 *
 * WHEN TO USE:
 * Rewriting a single expression (the common codegen path).
 *
 * WHEN NOT TO USE:
 * A statement list (effect bodies, opaque setup) - use {@link rewriteStatements}.
 *
 * EDGE CASES:
 * - `props.f` reads are left as-is (getter-object reactivity); only state/derived reads get `()`.
 * - The rewrite is NON-IDEMPOTENT: running it twice yields `x()()`. Codegen's `raw` mode exists to
 *   ensure it runs exactly once over projected markup.
 *
 * PERFORMANCE NOTES:
 * One parse + one edit-splice pass per expression.
 *
 * DEVELOPER WARNING:
 * Never re-run this on already-rewritten output (non-idempotent). `sources` must be complete or a real
 * reactive read is emitted as a plain identifier.
 *
 * @param code - The expression source
 * @param sources - The component's reactive sources
 * @param offset
 * @returns The rewritten expression source
 * @see {@link rewriteStatements}
 * @see {@link setterName}
 *
 * @example
 * ```ts
 * rewriteReactive('count + 1', { names: new Set(['count']), hasProps: false });
 * // 'count() + 1'
 * rewriteReactive('count = 5', { names: new Set(['count']), hasProps: false });
 * // 'setCount(5)'
 * ```
 *
 * @internal
 */
export function rewriteReactive(code: string, sources: ReactiveSources, offset = 0): string
{
    const { sourceFile } = parseExpressionSlice(code, 0); // text is `(${ code })`
    const rewritten = applyEdits(sourceFile.text, collectEdits(sourceFile, sources, offset));
    // Strip the wrapping parens added by parseExpressionSlice.
    return rewritten.slice(1, -1);
}

/**
 * Rewrites reactive reads/writes in a statement-list slice (an `effect` body or an opaque setup run).
 * Same rules as {@link rewriteReactive}, but parsed as statements rather than wrapped as an expression.
 *
 * @param code - The statement-list source.
 * @param sources - The component's reactive sources.
 * @returns The rewritten statement source.
 * @see {@link rewriteReactive}
 * @example
 * ```ts
 * rewriteStatements('log(count);', { names: new Set(['count']), hasProps: false });
 * // 'log(count());'
 * ```
 * @internal
 */
export function rewriteStatements(code: string, sources: ReactiveSources, offset = 0): string
{
    const { sourceFile } = parseStatementsSlice(code, 0);
    return applyEdits(sourceFile.text, collectEdits(sourceFile, sources, offset));
}

/**
 * Collects the reactive rewrite edits for an already-parsed slice. `offset` is the slice's
 * start in the original source, used only to locate a thrown error.
 *
 * Throws {@link CompileError} when an assignment/increment targets a source that is not
 * writable (a `derived`) - emitting a setter call for it would reference a setter that is
 * never defined. `sources.writable` gates this; when omitted, no writability check runs.
 */
function collectEdits(sourceFile: ts.SourceFile, sources: ReactiveSources, offset = 0): Edit[]
{
    const edits: Edit[] = [];

    const insert = (at: number, text: string): void =>
    {
        edits.push({ start: at, end: at, text });
    };

    traverseReactive(sourceFile, sources, {
        read: (id) =>
        {
            // A shorthand property `{ count }` must expand to `{ count: count() }`.
            if (ts.isShorthandPropertyAssignment(id.parent))
            {
                insert(id.getEnd(), `: ${ id.text }()`);
            }
            else
            {
                insert(id.getEnd(), '()');
            }
        },
        // A real `props.f` access needs no rewrite (props is a getter object, so reading the property runs
        // its getter). But a BARE destructured-prop alias (`a` from `component Name({ a }: P)`) is reported
        // here as an Identifier node, and IS rewritten to its aliased read (`props.a` / `(props.a ?? def)`).
        propsRead: (node) =>
        {
            if (!ts.isIdentifier(node) || sources.propAliases === undefined)
            {
                return;
            }
            const repl = sources.propAliases.get(node.text);
            if (repl === undefined)
            {
                return;
            }
            // A shorthand `{ a }` expands to `{ a: props.a }`; elsewhere the identifier is replaced.
            if (ts.isShorthandPropertyAssignment(node.parent))
            {
                insert(node.getEnd(), `: ${ repl }`);
            }
            else
            {
                edits.push({ start: node.getStart(sourceFile), end: node.getEnd(), text: repl });
            }
        },
        write: (target, expression, writable) =>
        {
            // A `derived` (any source without a setter) is read-only: reject the write
            // rather than emit a call to a setter that is never defined (a runtime crash).
            // `writable` is resolved by the walk (handles both flat and nested scoped sources).
            if (sources.writable !== undefined && !writable)
            {
                throw new CompileError(assignToDerivedMessage(target.text), offset);
            }

            const set = setterName(target.text);
            const lhsStart = target.getStart(sourceFile);

            if (ts.isBinaryExpression(expression))
            {
                const rightStart = expression.right.getStart(sourceFile);
                const rightEnd = expression.right.getEnd();
                if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)
                {
                    edits.push({ start: lhsStart, end: rightStart, text: `${ set }(` });
                    insert(rightEnd, ')');
                }
                else
                {
                    const op = COMPOUND.get(expression.operatorToken.kind) ?? '+';
                    edits.push({ start: lhsStart, end: rightStart, text: `${ set }(${ PREV } => ${ PREV } ${ op } (` });
                    insert(rightEnd, '))');
                }
                return;
            }

            // Postfix/prefix `++`/`--` (statement-position form).
            const update = expression as ts.PostfixUnaryExpression | ts.PrefixUnaryExpression;
            const op = update.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-';
            edits.push({ start: update.getStart(sourceFile), end: update.getEnd(), text: `${ set }(${ PREV } => ${ PREV } ${ op } 1)` });
        },
        // A `form` FIELD read `f.name` -> `f.values().name`: insert `.values()` between the form and the
        // field. (Non-field members like `f.errors` are not reported here, so they stay as real FormApi.)
        formFieldRead: (node) =>
        {
            insert(node.expression.getEnd(), '.values()');
        },
        // A write to a `form` field -> the form's setValue. `f.name = e` -> `f.setValue('name', e)`;
        // `f.n += e` / `f.n++` read the current value via `values()` and set the computed result.
        formWrite: (target, expression) =>
        {
            const form = target.expression.getText(sourceFile);
            const field = target.name.text;
            const lhsStart = target.getStart(sourceFile);

            if (ts.isBinaryExpression(expression))
            {
                const rightStart = expression.right.getStart(sourceFile);
                const rightEnd = expression.right.getEnd();
                if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)
                {
                    edits.push({ start: lhsStart, end: rightStart, text: `${ form }.setValue(${ JSON.stringify(field) }, ` });
                    insert(rightEnd, ')');
                }
                else
                {
                    const op = COMPOUND.get(expression.operatorToken.kind) ?? '+';
                    edits.push({ start: lhsStart, end: rightStart, text: `${ form }.setValue(${ JSON.stringify(field) }, ${ form }.values()${ memberAccess(field) } ${ op } (` });
                    insert(rightEnd, '))');
                }
                return;
            }

            const update = expression as ts.PostfixUnaryExpression | ts.PrefixUnaryExpression;
            const op = update.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-';
            edits.push({ start: update.getStart(sourceFile), end: update.getEnd(), text: `${ form }.setValue(${ JSON.stringify(field) }, ${ form }.values()${ memberAccess(field) } ${ op } 1)` });
        },
        // An array-form ROW FIELD read `row.name` -> `row.form.values().name`: insert `.form.values()`
        // between the row and the field. (`row.key` / `row.form` / FormApi access are not reported here.)
        rowFieldRead: (node) =>
        {
            insert(node.expression.getEnd(), '.form.values()');
        },
        // A write to a ROW field -> the row form's setValue, through `.form`. `row.n = e` ->
        // `row.form.setValue('n', e)`; compound/`++` read the current value via `row.form.values()`.
        rowFieldWrite: (target, expression) =>
        {
            const form = `${ target.expression.getText(sourceFile) }.form`;
            const field = target.name.text;
            const lhsStart = target.getStart(sourceFile);

            if (ts.isBinaryExpression(expression))
            {
                const rightStart = expression.right.getStart(sourceFile);
                const rightEnd = expression.right.getEnd();
                if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)
                {
                    edits.push({ start: lhsStart, end: rightStart, text: `${ form }.setValue(${ JSON.stringify(field) }, ` });
                    insert(rightEnd, ')');
                }
                else
                {
                    const op = COMPOUND.get(expression.operatorToken.kind) ?? '+';
                    edits.push({ start: lhsStart, end: rightStart, text: `${ form }.setValue(${ JSON.stringify(field) }, ${ form }.values()${ memberAccess(field) } ${ op } (` });
                    insert(rightEnd, '))');
                }
                return;
            }

            const update = expression as ts.PostfixUnaryExpression | ts.PrefixUnaryExpression;
            const op = update.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-';
            edits.push({ start: update.getStart(sourceFile), end: update.getEnd(), text: `${ form }.setValue(${ JSON.stringify(field) }, ${ form }.values()${ memberAccess(field) } ${ op } 1)` });
        }
    });

    return edits;
}

/** Applies edits to `text`, right-to-left so earlier offsets stay valid. */
function applyEdits(text: string, edits: Edit[]): string
{
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
    let out = text;
    for (const edit of sorted)
    {
        out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    }
    return out;
}
