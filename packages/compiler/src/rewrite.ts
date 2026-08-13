/**
 * The reactive rewrite. Rewrites an expression's source so reactive reads/writes become signal getter/setter calls - the
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
 * The "assigned a read-only source" error message, shared by the reactive-rewrite guard (this
 * module) and the semantic diagnostic (diagnostics.ts) so both phases report identically.
 *
 * @param name - The read-only value's name.
 * @param kind - Its declaring keyword; `derived` when the caller cannot resolve it.
 * @returns The error message.
 * @internal
 */
export function assignToDerivedMessage(name: string, kind = 'derived'): string
{
    return `Cannot assign to \`${ name }\`: a \`${ kind }\` value is read-only. Compute it from \`state\`, or make \`${ name }\` a \`state\` if it must change.`;
}

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
 * Rewrites the reactive reads and writes in one expression, returning transformed source.
 *
 * The output is byte-identical to the input except at reactive positions, because edits are
 * spliced by position rather than re-printed from the AST. Formatting, comments and
 * non-reactive sub-expressions survive exactly, which is what keeps source maps accurate.
 * Scope-awareness leaves a shadowing local untouched.
 *
 * A `props.f` read is left alone - props is a getter object, so reading the property already
 * runs its getter - and only state and derived reads gain a call.
 *
 * The rewrite is NON-IDEMPOTENT: running it twice yields `x()()`. Codegen's raw mode exists
 * precisely to guarantee it runs exactly once over projected markup, so never re-run it on
 * already-rewritten output.
 *
 * `sources` must be complete, or a genuinely reactive read is emitted as a plain identifier
 * and silently stops updating.
 *
 * @param code - The expression source, without wrapping parens; they are added for parsing.
 * @param sources - The component's reactive-source names, and whether it takes props.
 * @param offset - Base offset for the emitted edit positions.
 * @returns The rewritten source.
 * @throws {CompileError} On a write to a read-only source, such as a derived.
 * @example
 * rewriteReactive('count + 1', { names: new Set(['count']), hasProps: false });
 * // 'count() + 1'
 *
 * rewriteReactive('count = 5', { names: new Set(['count']), hasProps: false });
 * // 'setCount(5)'
 *
 * @see {@link rewriteStatements} for an effect body or opaque setup.
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
                throw new CompileError(assignToDerivedMessage(target.text, sources.kinds?.get(target.text) ?? 'derived'), offset);
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
        // An array-form ROW FIELD read `row.name` -> `row.form.values().name`, through the getter call
        // (`row().form.values().name`) when the row var is a `<For>` getter param. Outside the row
        // callback (`rows().forEach(row => row.qty)`) the name is NOT in rowItems and the value form
        // stays - there the binding really is the plain `{ key, form }` row object.
        rowFieldRead: (node, viaGetter) =>
        {
            insert(node.expression.getEnd(), `${ viaGetter ? '()' : '' }.form.values()`);
        },
        // A write to a ROW field -> the row form's setValue, through `.form` (and the getter call when
        // the row var is a `<For>` getter param). `row.n = e` -> `row.form.setValue('n', e)`;
        // compound/`++` read the current value via `row.form.values()`.
        rowFieldWrite: (target, expression, viaGetter) =>
        {
            const rowVar = target.expression.getText(sourceFile);
            const form = `${ rowVar }${ viaGetter ? '()' : '' }.form`;
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
        // A `<For>` row-item getter read - bare `item` or the `item` of `item.name` - gains the call
        // (`item()` / `item().name`), so the CURRENT item flows into the binding, not the one the row
        // was built from. Call-shaped output is load-bearing: the row-binding reactivity heuristic
        // (wrapDynamic) binds call-shaped expressions live, which is what updates a replaced item's
        // row in place.
        rowItemRead: (node) =>
        {
            insert(node.getEnd(), '()');
        },
        // A `__azRow(fn)` row marker is transport, not output: the walk has already scoped the
        // wrapped arrow's params, so the wrapper is deleted - callee + opening paren, and the
        // closing paren - leaving the arrow in place. Markers never survive to emitted code.
        rowMarker: (call) =>
        {
            const wrapped = call.arguments[0];
            if (wrapped === undefined)
            {
                return;
            }
            edits.push({ start: call.getStart(sourceFile), end: wrapped.getStart(sourceFile), text: '' });
            edits.push({ start: call.getEnd() - 1, end: call.getEnd(), text: '' });
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
