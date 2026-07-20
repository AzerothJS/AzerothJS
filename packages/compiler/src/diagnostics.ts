/**
 * MODULE: compiler/diagnostics - first-class semantic diagnostics for `component` syntax
 *
 * These are the mistakes the TYPE system cannot see - they fall out of the reactive analysis and the
 * markup AST:
 *   - azeroth/constant-derived     - a `derived` with no reactive dependencies AND no calls/side
 *                                    effects (a call may read a store accessor the analysis can't see);
 *   - azeroth/inert-effect         - an `effect` with no reactive dependencies AND no calls/side
 *                                    effects (same store-accessor caveat as constant-derived);
 *   - azeroth/self-write-in-effect - an `effect` that reads a `state` and also assigns it (a
 *                                    synchronous feedback loop);
 *   - azeroth/handler-not-function - an on* handler that runs at setup instead of on the event: an
 *                                    assignment, ++/--, or a zero-arg call of a plain reference
 *                                    (onClick={save()}). A call WITH arguments
 *                                    (onClick={makeHandler(id)}) is the handler-factory idiom and is
 *                                    left alone (this subsumes the old markup-level handler-call rule,
 *                                    so the two never both fire on one handler).
 *
 * (assign-derived and use-before-declaration are out of scope here - left to TypeScript; the harder
 * data-flow rules are future work.)
 *
 * @see {@link diagnoseModule} - diagnose a whole module
 */

import * as ts from 'typescript';

import type { MarkupElement, MarkupFragment } from './types.ts';
import type { ComponentDecl } from './ast.ts';
import type { ReactiveAnalysis } from './analyze.ts';
import type { ReactiveSources } from './dep.ts';

import { parseModule } from './parser.ts';
import { isEventName } from './markup-util.ts';
import { analyzeComponent } from './analyze.ts';
import { parseStatementsSlice, parseExpressionSlice } from './ts-slice.ts';
import { findMarkupStart } from './scanner.ts';
import { traverseReactive } from './walk.ts';
import { isSetupHandler, setupHandlerMessage } from './handler.ts';
import { assignToDerivedMessage } from './rewrite.ts';

/** One AzerothJS semantic diagnostic over the original source. */
export interface AzerothDiagnostic
{
    /** Stable rule id, e.g. 'azeroth/constant-derived'. */
    code: string;
    severity: 'error' | 'warning';
    message: string;
    /** Source span. */
    start: number;
    end: number;
}

/**
 * diagnoseModule
 *
 * PURPOSE:
 * Produces the AzerothJS semantic diagnostics for every component in a module.
 *
 * WHY IT EXISTS:
 * It surfaces reactive and structural mistakes the type checker can't see (inert effects, constant
 * deriveds, setup-time event handlers, duplicate props blocks), at build time where they reach every
 * contributor.
 *
 * COMPILER / RUNTIME ROLE:
 * Build-time, compiler; called by the Vite plugin's transform (findings become build warnings) and
 * usable by any tooling. Uses the `typescript` peer dep.
 *
 * INPUT CONTRACT:
 * - source: the module text.
 *
 * OUTPUT CONTRACT:
 * - An {@link AzerothDiagnostic}[]: one entry per finding across all components, each with a stable
 *   `code`, `severity`, `message`, and source span.
 *
 * WHY THIS DESIGN:
 * It reuses the SAME analyze/walk machinery codegen uses, so a diagnostic and the compiled output can
 * never disagree about what is reactive. Findings carry spans so callers map them to file:line:col.
 *
 * WHEN TO USE:
 * Diagnosing a `.azeroth` module (the plugin path) or in editor/CI tooling.
 *
 * WHEN NOT TO USE:
 * Type errors (TypeScript handles those); pure markup syntax slips (that's {@link lintSource}).
 *
 * EDGE CASES:
 * - A module with no component returns an empty array.
 * - A handler-factory call WITH arguments (onClick={makeHandler(id)}) is intentionally NOT flagged.
 *
 * PERFORMANCE NOTES:
 * One parse plus per-component analysis.
 *
 * DEVELOPER WARNING:
 * Severities include 'error', but diagnoseModule never throws or fails a build itself - the caller
 * decides what to do (the Vite plugin emits them as warnings).
 *
 * @param source - The module source to diagnose.
 * @returns Every semantic diagnostic found, across all components.
 * @see {@link AzerothDiagnostic}
 * @see {@link lintSource}
 *
 * @example
 * ```ts
 * diagnoseModule('component C { derived d = 1 + 2; <p>{d}</p> }')[0].code;
 * // 'azeroth/constant-derived'
 * ```
 */
export function diagnoseModule(source: string): AzerothDiagnostic[]
{
    const diagnostics: AzerothDiagnostic[] = [];
    for (const item of parseModule(source).items)
    {
        if (item.kind === 'component')
        {
            diagnoseComponent(source, item, diagnostics);
        }
    }
    return diagnostics;
}

/** One imported binding: the local name, its source offset, and the span of its whole import statement. */
interface ImportBinding { name: string; start: number; end: number; stmtStart: number; stmtEnd: number }

/** Escapes every regex metacharacter in `value` so it can be embedded in a `new RegExp(...)` pattern
 *  and still only match itself literally. @internal */
function escapeRegExp(value: string): string
{
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses the `import ... from '...'` statements of a `.azeroth` module (which precede any markup, so
 * they are plain TS) and yields each bound LOCAL name with its offset. Side-effect imports yield
 * nothing.
 *
 * Deliberately NOT one `/import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"][^'"]+['"]\s*;?/g` regex: an
 * unbounded `[\s\S]*?` immediately followed by a multi-token literal it can also partially match
 * (`\s+from`) is a textbook polynomial-regex shape on a large adversarial source file (a
 * `.azeroth`/`.ts` module is exactly "uncontrolled data" here - it can arrive from an untrusted PR
 * built in CI, or a file opened in an editor). Finding the statement boundary with plain string
 * scans keeps each step linear.
 */
function importBindings(source: string): ImportBinding[]
{
    const out: ImportBinding[] = [];
    const importKeywordRe = /\bimport\b/g;
    let km: RegExpExecArray | null;

    while ((km = importKeywordRe.exec(source)) !== null)
    {
        const stmtStart = km.index;
        const afterImport = /^\s+/.exec(source.slice(stmtStart + 'import'.length));
        if (afterImport === null)
        {
            continue; // `import(...)` / `import.meta` - not a static import statement
        }
        let clauseStart = stmtStart + 'import'.length + afterImport[0].length;

        // A leading `type` (before any binding) marks a type-only import; skip it too.
        const typeMatch = /^type\s+/.exec(source.slice(clauseStart));
        if (typeMatch !== null)
        {
            clauseStart += typeMatch[0].length;
        }

        // Scan forward for a `from` keyword immediately (only whitespace between) followed by a
        // quoted specifier - that is the statement's end. Each candidate is an O(1) lookahead, so
        // this whole scan is linear in the statement's length.
        const fromKeywordRe = /\bfrom\b/g;
        fromKeywordRe.lastIndex = clauseStart;
        let clauseEnd = -1;
        let stmtEnd = -1;
        let fm: RegExpExecArray | null;
        while ((fm = fromKeywordRe.exec(source)) !== null)
        {
            const specifierMatch = /^\s*(['"])[^'"]*\1\s*;?/.exec(source.slice(fm.index + 'from'.length));
            if (specifierMatch !== null)
            {
                clauseEnd = fm.index;
                stmtEnd = fm.index + 'from'.length + specifierMatch[0].length;
                break;
            }
        }
        if (clauseEnd === -1)
        {
            continue; // no `from '...'` found - not a well-formed import statement
        }

        const clause = source.slice(clauseStart, clauseEnd).trimEnd();

        // default import: leading `Foo` before any `{`/`*`
        const defName = /^\s*([A-Za-z_$][\w$]*)\s*(?=,|$)/.exec(clause)?.[1];
        if (defName !== undefined && !clause.trimStart().startsWith('{') && !clause.trimStart().startsWith('*'))
        {
            const at = clauseStart + clause.indexOf(defName);
            out.push({ name: defName, start: at, end: at + defName.length, stmtStart, stmtEnd });
        }
        // namespace: `* as NS`
        const nsName = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
        if (nsName !== undefined)
        {
            const at = clauseStart + clause.indexOf(nsName, clause.indexOf('as'));
            out.push({ name: nsName, start: at, end: at + nsName.length, stmtStart, stmtEnd });
        }
        // named: `{ a, b as c, type T }` - the LOCAL name is after `as`, else the imported name.
        // Located by index, not a `{([^}]*)}` regex - unanchored, that regex is retried at every
        // offset, so a clause with many `{` and no `}` costs O(n) per offset, O(n^2) overall.
        const braceOpen = clause.indexOf('{');
        const braceClose = braceOpen === -1 ? -1 : clause.indexOf('}', braceOpen + 1);
        if (braceOpen !== -1 && braceClose !== -1)
        {
            const namedInner = clause.slice(braceOpen + 1, braceClose);
            const blockStart = clauseStart + braceOpen + 1;
            let cursor = 0;
            for (const raw of namedInner.split(','))
            {
                const partStart = blockStart + cursor;
                cursor += raw.length + 1; // + the comma
                const part = raw.replace(/^\s*type\s+/, '');
                // Anchored (`^\s*`), not a bare search: unanchored, this regex is also retried at
                // every offset in `part` - the same O(n^2) shape as the brace lookup above.
                const alias = /^\s*[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)/.exec(part);
                const name = alias ? alias[1] : /^[A-Za-z_$][\w$]*/.exec(part.trim())?.[0];
                if (name === undefined)
                {
                    continue;
                }
                const at = partStart + raw.indexOf(name, alias ? raw.indexOf('as') : 0);
                out.push({ name, start: at, end: at + name.length, stmtStart, stmtEnd });
            }
        }
    }
    return out;
}

/**
 * diagnoseUnusedImports
 *
 * Reports an `azeroth/unused-import` warning for each imported name that is never used. RELIABLE
 * because it checks usage TWO ways and only flags when BOTH say unused:
 *   1. VALUE use - walk the compiled JS (markup already lowered to h()/component calls) with the TS
 *      AST; an identifier reference there means the import is used at runtime. Source text is NOT
 *      scanned for value use - markup makes naive scanning mis-parse.
 *   2. TYPE use - the compiled JS drops type annotations, so a type-only import (`import type { T }`,
 *      `props: { x: T }`) looks unused above. Cross-check the SOURCE: if the name appears anywhere
 *      outside its own import statement, keep it (conservative - never flag a name that might be a type
 *      or a use the value-walk can't see).
 *
 * @param source - the `.azeroth` module source.
 * @param compiledJs - the JS produced by {@link generateModule} for the same source.
 * @returns one warning per genuinely-unused import, located at the name in the source import.
 */
export function diagnoseUnusedImports(source: string, compiledJs: string): AzerothDiagnostic[]
{
    const bindings = importBindings(source);
    if (bindings.length === 0)
    {
        return [];
    }

    // (1) value usages, from the compiled JS AST (excluding the compiled import declarations themselves).
    const declared = new Set(bindings.map(b => b.name));
    const valueUsed = new Set<string>();
    const sf = ts.createSourceFile('m.ts', compiledJs, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n: ts.Node): void =>
    {
        if (ts.isImportDeclaration(n))
        {
            return; // an import binding referencing itself is not a use
        }
        if (ts.isIdentifier(n) && declared.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n))
        {
            valueUsed.add(n.text);
        }
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);

    const out: AzerothDiagnostic[] = [];
    for (const b of bindings)
    {
        if (valueUsed.has(b.name))
        {
            continue;
        }
        // (2) conservative source cross-check: any occurrence outside ALL import statements => keep.
        // `b.name` can only be `[A-Za-z0-9_$]` by construction (it came out of an identifier-shaped
        // capture above), so escaping just `$` is sufficient today - but escaping every regex
        // metacharacter (not just the one this call site happens to need) keeps that true by
        // construction instead of by an invariant a future caller could quietly break.
        const re = new RegExp(`(?<![\\w$.])${ escapeRegExp(b.name) }(?![\\w$])`, 'g');
        let usedElsewhere = false;
        let occ: RegExpExecArray | null;
        while ((occ = re.exec(source)) !== null)
        {
            const at = occ.index;
            if (!bindings.some(other => at >= other.stmtStart && at < other.stmtEnd))
            {
                usedElsewhere = true;
                break;
            }
        }
        if (!usedElsewhere)
        {
            out.push({
                code: 'azeroth/unused-import',
                severity: 'warning',
                message: `\`${ b.name }\` is imported but never used - remove the import.`,
                start: b.start,
                end: b.end
            });
        }
    }
    return out;
}

/** @internal */
function diagnoseComponent(source: string, component: ComponentDecl, out: AzerothDiagnostic[]): void
{
    // azeroth/constant-derived and azeroth/inert-effect
    const analysis = analyzeComponent(source, component);
    for (const scope of analysis.scopes)
    {
        // A reactive dependency means it is neither constant nor inert. A scope that is NOT pure
        // (it contains a call, `new`, `await`, or an assignment) is also exempt: a call may read an
        // external reactive source the dependency analysis cannot see - a store accessor like
        // `router.location()` - so warning would be a false positive whose suggested fix ("use a
        // plain value") would silently break reactivity. Only a dependency-free, side-effect-free
        // scope (e.g. `derived x = 1 + 2`) is provably constant/inert.
        if (scope.deps.length > 0 || !scope.pure)
        {
            continue;
        }
        if (scope.origin === 'derived')
        {
            // Name the binding when known (`` `derived d` ``); fall back to a bare `` `derived` ``
            // for an anonymous scope so the message never renders a dangling backtick-space.
            const subject = scope.name ? `\`derived ${ scope.name }\`` : 'This `derived`';
            out.push({
                code: 'azeroth/constant-derived',
                severity: 'warning',
                message: `${ subject } reads no reactive source, so it never changes - use a plain value.`,
                start: scope.span.start,
                end: scope.span.end
            });
        }
        else if (scope.origin === 'effect')
        {
            out.push({
                code: 'azeroth/inert-effect',
                severity: 'warning',
                message: 'This `effect` reads no reactive source, so it runs once and never re-runs - call it during setup, or read a `state`/`derived` to make it reactive.',
                start: scope.span.start,
                end: scope.span.end
            });
        }
    }

    // azeroth/self-write-in-effect
    const reactive: ReactiveSources = { names: new Set(analysis.sources.map(s => s.name)), hasProps: analysis.hasProps };
    const stateNames = new Set(analysis.sources.filter(s => s.kind === 'state').map(s => s.name));
    diagnoseSelfWriteEffects(source, component, reactive, stateNames, out);

    // azeroth/assign-to-derived (M1, semantic phase). The reactive rewrite ALSO rejects this
    // (the codegen-time backstop), so derived mutation is caught in both phases.
    diagnoseDerivedWrites(source, component, analysis, out);

    // azeroth/handler-not-function
    for (const item of component.body)
    {
        if (item.kind === 'markup')
        {
            diagnoseEventHandlers(item.node, out);
        }
    }

    // azeroth/multiple-roots. The generator returns the LAST top-level markup region,
    // so every earlier one would be built and silently discarded - a section that
    // "vanishes" with no error (field-reported). Make it loud at compile time.
    const markupItems = component.body.filter((item) => item.kind === 'markup');
    for (const extra of markupItems.slice(0, -1))
    {
        out.push({
            code: 'azeroth/multiple-roots',
            severity: 'error',
            message: 'A component renders exactly one top-level markup region, and only the last '
                + 'one is returned - this region would be silently discarded. Wrap sibling roots '
                + 'in a fragment (<>...</>) or a single host element.',
            start: extra.start,
            end: extra.end
        });
    }
}

/**
 * Flags an `effect` that updates a `state` FROM ITS OWN VALUE - a SELF-REFERENTIAL write: `count = count
 * + 1`, `count++`, `count += 1`. Reactivity is compile-time here, so reading the state inside the write
 * makes it a dependency the write then changes -> the effect re-triggers itself -> a feedback loop.
 *
 * It deliberately does NOT flag a write whose value comes from a DIFFERENT source even when the same
 * state is read elsewhere in the body - e.g. the clamp idiom `effect { if (page > totalPages) page =
 * totalPages }`. There `page` is only read in the GUARD; the new value is `totalPages` (another source),
 * so the write converges (it stops once `page <= totalPages`) rather than looping.
 */
function diagnoseSelfWriteEffects(source: string, component: ComponentDecl, reactive: ReactiveSources, stateNames: ReadonlySet<string>, out: AzerothDiagnostic[]): void
{
    // True when the write reads the very state it assigns: `x++`/`--x`, a compound `x += ...`, or `x = ...x...`.
    const isSelfReferential = (target: ts.Identifier, expression: ts.Node): boolean =>
    {
        if (ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression))
        {
            return true;
        }
        if (ts.isBinaryExpression(expression))
        {
            if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
            {
                return true; // compound (`+=`, `||=`, ...) reads the target before writing
            }
            const rhs = expression.right;
            if (ts.isIdentifier(rhs))
            {
                return rhs.text === target.text;
            }
            let reads = false;
            traverseReactive(rhs, { names: new Set([target.text]), hasProps: false }, {
                read: () =>
                {
                    reads = true;
                }
            });
            return reads;
        }
        return false;
    };

    for (const item of component.body)
    {
        if (item.kind !== 'effect')
        {
            continue;
        }
        const { sourceFile, mapPos } = parseStatementsSlice(source.slice(item.bodyStart, item.bodyEnd), item.bodyStart);
        const flagged = new Set<string>();
        traverseReactive(sourceFile, reactive, {
            write: (target, expression) =>
            {
                if (!stateNames.has(target.text) || flagged.has(target.text) || !isSelfReferential(target, expression))
                {
                    return;
                }
                flagged.add(target.text);
                out.push({
                    code: 'azeroth/self-write-in-effect',
                    severity: 'warning',
                    message: `This \`effect\` updates \`${ target.text }\` from its own value - a synchronous feedback loop (the write re-triggers the effect). Compute the value with \`derived\`, or update a different state.`,
                    start: mapPos(target.getStart(sourceFile)),
                    end: mapPos(target.getEnd())
                });
            }
        });
    }
}

/**
 * Flags any assignment / `++` / `--` whose target is a `derived` (read-only) value, in every
 * reactive code region of a component: effect bodies, opaque setup statements, and markup
 * expressions (handlers, attributes, holes). A derived has no setter, so a write is a
 * compile-time error (the reactive rewrite enforces the same thing during codegen).
 */
function diagnoseDerivedWrites(source: string, component: ComponentDecl, analysis: ReactiveAnalysis, out: AzerothDiagnostic[]): void
{
    const derivedNames = new Set(analysis.sources.filter(s => s.kind === 'derived').map(s => s.name));
    if (derivedNames.size === 0)
    {
        return;
    }
    const reactive: ReactiveSources = { names: new Set(analysis.sources.map(s => s.name)), hasProps: analysis.hasProps };

    // Reports the first derived write found in a parsed slice, located via `locate`.
    const flag = (sourceFile: ts.SourceFile, locate: (node: ts.Identifier) => { start: number; end: number }): void =>
    {
        const seen = new Set<string>();
        traverseReactive(sourceFile, reactive, {
            write: (target) =>
            {
                if (!derivedNames.has(target.text) || seen.has(target.text))
                {
                    return;
                }
                seen.add(target.text);
                const span = locate(target);
                out.push({
                    code: 'azeroth/assign-to-derived',
                    severity: 'error',
                    message: assignToDerivedMessage(target.text),
                    start: span.start,
                    end: span.end
                });
            }
        });
    };

    for (const item of component.body)
    {
        if (item.kind === 'effect')
        {
            const { sourceFile, mapPos } = parseStatementsSlice(source.slice(item.bodyStart, item.bodyEnd), item.bodyStart);
            flag(sourceFile, (t) => ({ start: mapPos(t.getStart(sourceFile)), end: mapPos(t.getEnd()) }));
        }
        else if (item.kind === 'opaque-statements')
        {
            const { sourceFile, mapPos } = parseStatementsSlice(source.slice(item.start, item.end), item.start);
            flag(sourceFile, (t) => ({ start: mapPos(t.getStart(sourceFile)), end: mapPos(t.getEnd()) }));
        }
        else if (item.kind === 'markup')
        {
            for (const expr of collectMarkupExpressions(item.node))
            {
                // A render-function value (e.g. `fallback={() => (<markup/>)}`) carries embedded markup
                // in its code. Parsed as a flat TS expression, that markup's `attr={name}` reads as the
                // assignment `attr = {name}` - a false derived-write. Skip it; the codegen rewrite guard
                // still rejects a genuine derived write inside such markup when it compiles the children.
                if (containsMarkup(expr.code))
                {
                    continue;
                }
                const { sourceFile } = parseExpressionSlice(expr.code, 0);
                // Markup expression offsets are approximate; locate the error at the construct.
                flag(sourceFile, () => ({ start: expr.start, end: expr.end }));
            }
        }
    }
}

/** True when an expression's code embeds markup (e.g. a `() => (<el/>)` render function). */
function containsMarkup(code: string): boolean
{
    const at = findMarkupStart(code, 0);
    return at >= 0 && at < code.length;
}

/** Yields every embedded expression ({code, span}) in a markup tree: attributes and holes. */
function* collectMarkupExpressions(node: MarkupElement | MarkupFragment): Generator<{ code: string; start: number; end: number }>
{
    if (node.kind === 'element')
    {
        for (const attr of node.attributes)
        {
            if (attr.value.kind === 'expression')
            {
                yield { code: attr.value.code, start: attr.start, end: attr.end };
            }
        }
    }
    for (const child of node.children)
    {
        if (child.kind === 'expression')
        {
            yield { code: child.code, start: child.start, end: child.end };
        }
        else if (child.kind === 'element' || child.kind === 'fragment')
        {
            yield* collectMarkupExpressions(child);
        }
    }
}

/** Walks markup for on* handlers whose value would run at setup, not on the event. */
function diagnoseEventHandlers(node: MarkupElement | MarkupFragment, out: AzerothDiagnostic[]): void
{
    if (node.kind === 'element')
    {
        for (const attr of node.attributes)
        {
            if (!attr.spread && attr.name !== null && isEventName(attr.name) &&
                attr.value.kind === 'expression' && isSetupHandler(attr.value.code))
            {
                const handler = attr.value.code.trim();
                out.push({
                    code: 'azeroth/handler-not-function',
                    severity: 'error',
                    message: setupHandlerMessage(handler, attr.name),
                    start: attr.start,
                    end: attr.end
                });
            }
        }
    }
    for (const child of node.children)
    {
        if (child.kind === 'element' || child.kind === 'fragment')
        {
            diagnoseEventHandlers(child, out);
        }
    }
}
