/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * First-class semantic diagnostics for `component` syntax: the mistakes the TYPE system cannot see - they fall out of the reactive analysis and the
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
 *                                    so the two never both fire on one handler);
 *   - azeroth/malformed-component  - a `component` header that fails its shape check (missing name,
 *                                    unbalanced generics, missing body brace) would otherwise VANISH
 *                                    into opaque TS; this names exactly what is wrong;
 *   - azeroth/keyword-shadow       - a body-local binding named like a capture-guarded keyword
 *                                    (the STABILITY.md capture clause);
 *   - azeroth/unterminated-declaration - a missing `;` that let a declaration absorb the next one
 *                                    (the swallowed binding would silently vanish);
 *   - azeroth/non-ascii-name       - a non-ASCII character in a declaration name (the ASCII-only
 *                                    scanner would truncate it silently).
 *
 * Plus the normative markup rules of GRAMMAR 6.6, defined HERE and nowhere else (the lowerer
 * assumes validated input; the language server and ESLint processor surface the same findings):
 *   - azeroth/reserved-event-name  - a host on* attribute that is not handler-form (`onclick`,
 *                                    `once`); the namespace is reserved for event handlers;
 *   - azeroth/duplicate-attr       - a repeated host attribute name (render modes disagree on
 *                                    the winner);
 *   - azeroth/duplicate-prop       - a repeated component prop key, including bind:'s claimed
 *                                    value + write-back keys and children=/markup-children;
 *   - azeroth/content-property-children - innerHTML/textContent combined with children.
 *   - azeroth/ref-value            - a host `ref` with no value or a static string: it can
 *                                    never receive the element, and the render modes disagree
 *                                    on whether the attribute appears in the document.
 *
 * (assign-derived and use-before-declaration are out of scope here - left to TypeScript; the harder
 * data-flow rules are future work.)
 *
 * @see {@link diagnoseModule} - diagnose a whole module
 */

import * as ts from 'typescript';

import type { MarkupAttribute, MarkupElement, MarkupFragment } from './types.ts';
import type { ComponentDecl } from './ast.ts';
import type { ReactiveAnalysis } from './analyze.ts';
import type { ReactiveSources } from './dep.ts';

import { parseModule, step, skipTrivia } from './parser.ts';
import { parseMarkup } from './markup-parser.ts';
import { findConstructs } from './lower-reactive.ts';
import { arrayFormEachName } from './analyze.ts';
import { DECLARATION_KEYWORDS } from './keyword-spec.ts';
import {
    hostEventType,
    isBindingAttr,
    BINDING_ATTRS,
    isReservedHostAttribute,
    reservedHostAttributeMessage,
    contentChildrenMessage,
    bindWriteBack,
    CONTENT_PROPERTIES
} from 'azerothjs/semantics';
import { isFunctionLiteral } from './markup-util.ts';
import { analyzeComponent } from './analyze.ts';
import { parseStatementsSlice, parseExpressionSlice } from './ts-slice.ts';
import { findMarkupStart, isIdentStart, isIdentPart, scanTypeParams, skipBalanced } from './scanner.ts';
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
 * Every semantic diagnostic for every component in a module: the reactive and structural
 * mistakes the type checker cannot see - an inert effect, a constant derived, a handler that
 * runs at setup, a bind target that can never wire.
 *
 * It reuses the SAME analysis and walk machinery codegen uses, so a diagnostic and the
 * compiled output can never disagree about what is reactive.
 *
 * Severities include 'error', but this function never throws and never fails a build itself;
 * the caller decides. The compile path treats an error-severity finding as fatal, while the
 * editor and the ESLint processor surface the same findings as squiggles.
 *
 * A handler-factory call WITH arguments, `onClick={makeHandler(id)}`, is deliberately not
 * flagged: that is the factory idiom, not a setup-time call.
 *
 * @param source - The module source.
 * @returns One entry per finding, each with a stable code, a severity, a message and a source
 *          span. Empty for a module containing no component.
 * @example
 * diagnoseModule('component C { derived d = 1 + 2; <p>{d}</p> }')[0].code;
 * // 'azeroth/constant-derived'
 *
 * @see {@link lintSource} for markup syntax slips, which are a separate layer.
 */
export function diagnoseModule(source: string): AzerothDiagnostic[]
{
    const diagnostics: AzerothDiagnostic[] = [];
    const items = parseModule(source).items;
    // Imports and module-scope variables, resolved once: a bind target that names one is a
    // silent half-dead binding (or a TypeError on the first keystroke, for an import).
    const moduleScope = moduleBindScope(source, items);
    for (const item of items)
    {
        if (item.kind === 'component')
        {
            diagnoseComponent(source, item, diagnostics, moduleScope);
        }
        else
        {
            diagnoseMalformedComponents(source, item.start, item.end, diagnostics);
            // Module-scope markup (`const row = () => <li/>`) compiles through the same
            // lowerer, so it answers to the same GRAMMAR 6.6 rules.
            walkEmbeddedMarkup(source, item.start, item.end, markupRuleVisitor(diagnostics));
            // ...and to the bind-target rule: a bind in module-scope markup was invisible to the
            // per-component pass and compiled to the same silent half-dead binding. A synthetic
            // one-item body reuses the whole resolver with module scope only.
            diagnoseBindTargets(
                source,
                { body: [{ kind: 'opaque-statements', start: item.start, end: item.end }] } as unknown as ComponentDecl,
                { sources: [], hasProps: false, scopes: [], forms: new Map(), rowForms: new Map() },
                diagnostics,
                moduleScope,
                true
            );
        }
    }
    return diagnostics;
}

/**
 * The parser is TOTAL: a `component` header that fails its shape check (no name, an
 * unbalanced type-parameter list, a missing body brace) silently becomes opaque
 * TypeScript - "my component vanished" with no error anywhere. This pass walks the
 * OPAQUE module regions with the same step machinery the parser uses (so `component`
 * inside strings, comments, or markup never triggers) and names exactly what went
 * wrong. Only clear declaration INTENT is flagged: the keyword followed by an
 * identifier or `{`; `obj.component`, `component: T`, `component = x` stay silent.
 *
 * @internal `azeroth/malformed-component`
 */
function diagnoseMalformedComponents(source: string, start: number, end: number, out: AzerothDiagnostic[]): void
{
    let i = start;
    let prevChar = '';
    let prevWord = '';
    while (i < end)
    {
        const s = step(source, i, prevChar, prevWord);
        if (s.kind === 'identifier' && s.text === 'component' && prevChar !== '.')
        {
            const reason = malformedComponentReason(source, s.next);
            if (reason !== null)
            {
                out.push({
                    code: 'azeroth/malformed-component',
                    severity: 'error',
                    message: `This looks like a \`component\` declaration, but ${ reason } - so it is `
                        + 'treated as plain TypeScript and the component does not exist.',
                    start: i,
                    end: i + 'component'.length
                });
            }
        }
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
    }
}

/**
 * @internal Why a `component` keyword ending at `keywordEnd` failed to parse
 * as a declaration, or null when it does not look like one (or would in fact parse -
 * e.g. the keyword sits inside a component body's opaque run, not at module level).
 */
function malformedComponentReason(source: string, keywordEnd: number): string | null
{
    let cursor = skipTrivia(source, keywordEnd);
    const next = source[cursor];

    // Anonymous header: `component {` shows intent with no name.
    if (next === '{')
    {
        return 'the component name is missing (write `component Name { ... }`)';
    }
    if (next === undefined || !isIdentStart(next))
    {
        return null; // `component = x`, `component: T`, `component,` ... - an ordinary identifier
    }

    // `component Name` - two identifiers in a row is not valid TypeScript, so the
    // declaration intent is unambiguous. Find which shape check fails.
    while (cursor < source.length && isIdentPart(source[cursor]))
    {
        cursor++;
    }
    cursor = skipTrivia(source, cursor);

    if (source[cursor] === '<')
    {
        const closed = scanTypeParams(source, cursor);
        if (closed === -1)
        {
            return 'its type-parameter list never closes (unbalanced `<...>`)';
        }
        cursor = skipTrivia(source, closed);
    }

    if (source[cursor] === '(')
    {
        const closed = skipBalanced(source, cursor);
        if (closed >= source.length && source[source.length - 1] !== ')')
        {
            return 'its parameter list never closes (unbalanced `(...)`)';
        }
        cursor = skipTrivia(source, closed);
    }

    if (source[cursor] !== '{')
    {
        return 'the body `{` is missing after the signature';
    }
    return null; // shape is fine here - the keyword was simply not at a recognized position
}

/** One imported binding: the local name, its source offset, and the span of its whole import statement. */
interface ImportBinding { name: string; start: number; end: number; stmtStart: number; stmtEnd: number }

/** Escapes every regex metacharacter in `value` so it can be embedded in a `new RegExp(...)` pattern
 *  and still only match itself literally. @internal */
export function escapeRegExp(value: string): string
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
/**
 * Keywords added AFTER 1.0 shipped its grammar, per the STABILITY.md capture clause:
 * a contextual keyword claims the shape `<word> { ... }`, so a local binding with the
 * same name invites a silent re-interpretation. Each addition lists itself here and
 * the shadow diagnostic covers it; the ORIGINAL keyword set is deliberately absent
 * (flagging pre-existing code would be noise, not protection).
 */
const CAPTURE_GUARDED_KEYWORDS = ['mount'] as const;

/** @internal `azeroth/keyword-shadow`: a body-local binding named like a guarded keyword. */
function diagnoseKeywordShadows(source: string, component: ComponentDecl, out: AzerothDiagnostic[]): void
{
    for (const item of component.body)
    {
        if (item.kind !== 'opaque-statements')
        {
            continue;
        }
        const region = source.slice(item.start, item.end);
        for (const keyword of CAPTURE_GUARDED_KEYWORDS)
        {
            const pattern = new RegExp(`\\b(?:let|const|var|function)\\s+(${ keyword })\\b`, 'g');
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(region)) !== null)
            {
                const at = item.start + match.index + match[0].length - keyword.length;
                out.push({
                    code: 'azeroth/keyword-shadow',
                    severity: 'warning',
                    message: `\`${ keyword }\` is a reactive keyword: \`${ keyword } { ... }\` at a statement start `
                        + 'parses as the keyword block, not this binding. Rename the local.',
                    start: at,
                    end: at + keyword.length
                });
            }
        }
    }
}

/** The body-item kinds that are `<keyword> <name> = <value>` declarations (name + value spans). */
const DECLARATION_KINDS: ReadonlySet<string> = new Set([
    'state', 'derived', 'deferred', 'resource', 'stream', 'store', 'selector', 'form'
]);

/**
 * @internal Two silent-corruption traps in declaration scanning, surfaced loudly:
 *
 *   - `azeroth/non-ascii-name` - the identifier scanner is ASCII-only, so `state café = 1`
 *     parses the name as `caf` and the rest silently becomes junk. Flag the truncation.
 *   - `azeroth/unterminated-declaration` - `state a = 1  state b = 2;` (no `;` after the first)
 *     parses as ONE declaration whose value ABSORBED the second, so `b` vanishes with no error.
 *     Detect a declaration keyword at depth 0 inside a value and point at it.
 */
function diagnoseDeclarationSlips(source: string, component: ComponentDecl, out: AzerothDiagnostic[]): void
{
    for (const item of component.body)
    {
        if (!DECLARATION_KINDS.has(item.kind))
        {
            continue;
        }
        const decl = item as { kind: string; name: string; start: number; nameStart: number; nameEnd: number; valueEnd: number; end: number };

        const nextCp = source.codePointAt(decl.nameEnd);
        if (nextCp !== undefined && nextCp > 0x7F && /\p{L}|\p{N}/u.test(String.fromCodePoint(nextCp)))
        {
            out.push({
                code: 'azeroth/non-ascii-name',
                severity: 'error',
                message: `\`${ decl.kind } ${ decl.name }…\` has a non-ASCII character in its name. Declaration names are ASCII-only in 1.x - rename it (the character after \`${ decl.name }\` is not scanned as part of the name).`,
                start: decl.nameStart,
                end: decl.nameEnd + 1
            });
        }

        const absorbed = findAbsorbedDeclaration(source, decl.nameEnd, decl.valueEnd);
        if (absorbed !== -1)
        {
            out.push({
                code: 'azeroth/unterminated-declaration',
                severity: 'error',
                message: 'Missing `;`: this declaration keyword sits inside the previous declaration\'s value, so it was absorbed and this binding will not exist. End the previous declaration with a semicolon.',
                start: absorbed,
                end: absorbed + (source.slice(absorbed).match(/^\w+/)?.[0].length ?? 1)
            });
        }

        // A missing `;` also lets a declaration absorb the RETURN MARKUP. Two shapes:
        //
        //   1. `derived x = <div/>;` - markup right after `=`. `step` sees it in expression
        //      position and reports `kind: 'markup'`; findAbsorbedMarkup points at it. (Markup
        //      at bracket depth 0 in a value is never valid - it would emit raw, untransformed
        //      markup into the JS.)
        //   2. `state count = 0` then `<div>...` - the value `0` makes `<` a COMPARISON to `step`
        //      (`0 < div > ...`), so the markup is not seen as markup; instead the whole thing runs
        //      to the component body end with no `;`. An unterminated value-declaration is the
        //      tell: statementEnd only returns a non-`;` end when it hit the body limit.
        const absorbedMarkup = findAbsorbedMarkup(source, decl.nameEnd, decl.valueEnd);
        if (absorbedMarkup !== -1)
        {
            const tag = source.slice(absorbedMarkup).match(/^<\/?[A-Za-z][\w-]*|^<>/)?.[0].length ?? 1;
            out.push({
                code: 'azeroth/unterminated-declaration',
                severity: 'error',
                message: `Missing \`;\`: markup here was absorbed into the \`${ decl.kind } ${ decl.name }\` declaration's value, so the binding is malformed and this markup is dropped from the render. A declaration value cannot contain markup - end the declaration with a semicolon before it.`,
                start: absorbedMarkup,
                end: absorbedMarkup + tag
            });
        }
        else if (source[decl.end - 1] !== ';')
        {
            // Unterminated: the declaration's value has no closing `;` and ran to the end of the
            // component body, swallowing whatever followed - the return markup, the next
            // statement - into a malformed value. (findAbsorbedDeclaration above already handles
            // the decl->decl shape with its own, more specific message; this is the general case.)
            out.push({
                code: 'azeroth/unterminated-declaration',
                severity: 'error',
                message: `\`${ decl.kind } ${ decl.name }\` is missing its terminating \`;\`, so everything after the value - including the component's return markup - was absorbed into it and is lost. Add a semicolon after the value.`,
                start: decl.start,
                end: decl.nameEnd
            });
        }
    }
}

/**
 * @internal Scans `[from, to)` for a markup region at bracket depth 0 - markup absorbed into a
 * declaration value because a `;` was missing (`state count = 0` then `<div>...`). Returns its
 * offset, or -1. `step` only reports `kind: 'markup'` in expression position with a real tag/
 * fragment start, so a `<` comparison operator (`a < b`) is never mistaken for markup; and markup
 * nested inside brackets (depth > 0) is skipped, leaving only the top-level absorbed case.
 */
function findAbsorbedMarkup(source: string, from: number, to: number): number
{
    let i = from;
    let depth = 0;
    let prevChar = '';
    let prevWord = '';
    while (i < to)
    {
        const s = step(source, i, prevChar, prevWord);
        if (s.kind === 'markup' && depth === 0)
        {
            return i;
        }
        if (s.kind === 'open')
        {
            depth++;
        }
        else if (s.kind === 'close')
        {
            depth--;
        }
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
    }
    return -1;
}

/**
 * @internal Scans `[from, to)` for a declaration keyword at bracket depth 0 that is followed by an
 * identifier name (the parser's own declaration-intent rule) - i.e. a swallowed declaration. Returns
 * its offset, or -1. A member access (`store.foo`) or a value use (`x ? state : y`) is excluded
 * because the keyword is either preceded by `.` or not followed by a name.
 */
function findAbsorbedDeclaration(source: string, from: number, to: number): number
{
    let i = from;
    let depth = 0;
    let prevChar = '';
    let prevWord = '';
    while (i < to)
    {
        const s = step(source, i, prevChar, prevWord);
        if (s.kind === 'open')
        {
            depth++;
        }
        else if (s.kind === 'close')
        {
            depth--;
        }
        else if (s.kind === 'identifier' && depth === 0 && prevChar !== '.' && DECLARATION_KEYWORDS.has(s.text))
        {
            const nameAt = skipTrivia(source, s.next);
            if (nameAt < to && isIdentStart(source[nameAt] ?? ''))
            {
                return i;
            }
        }
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
    }
    return -1;
}

function diagnoseComponent(source: string, component: ComponentDecl, out: AzerothDiagnostic[], moduleScope: ModuleBindScope): void
{
    diagnoseKeywordShadows(source, component, out);
    diagnoseDeclarationSlips(source, component, out);

    // azeroth/constant-derived and azeroth/inert-effect
    const analysis = analyzeComponent(source, component);

    // A rest element in the props parameter (`{ a, ...rest }`) cannot be lowered: props are read
    // through per-key getters to stay reactive, and there is no single getter for "the remaining
    // props". Reject it with a located error instead of emitting a body that reads an unbound `rest`.
    if (analysis.hasRestProp && component.propsParam !== null)
    {
        out.push({
            code: 'azeroth/unsupported-props-rest',
            severity: 'error',
            message: 'A rest element (`...rest`) in a component props parameter is not supported: '
                + 'props are read through getters to stay reactive. Name the props you use, or take the '
                + 'whole object (`component C(props: P)`) and read `props.x`.',
            start: component.propsParam.start,
            end: component.propsParam.end
        });
    }
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

    // azeroth/assign-to-derived (semantic phase). The reactive rewrite ALSO rejects this
    // (the codegen-time backstop), so derived mutation is caught in both phases.
    diagnoseDerivedWrites(source, component, analysis, out);
    diagnoseBindTargets(source, component, analysis, out, moduleScope);
    diagnoseReusedMarkupValues(source, component, out);

    // azeroth/handler-not-function, plus the GRAMMAR 6.6 markup rules (duplicate-attr,
    // duplicate-prop, reserved-event-name, content-property-children) - both walk the SAME
    // deep markup traversal, embedded expression markup included.
    //
    // Statement and effect/watch/wrapper bodies are walked too: markup held in a statement
    // (`const frag = <For .../>`) compiles through the same emitter, so leaving it out made
    // EVERY rule in this family position-dependent - a duplicate attribute, a reserved event
    // name, or a keyless <For> was an error in markup position and silent one line above.
    for (const item of component.body)
    {
        if (item.kind === 'markup')
        {
            diagnoseEventHandlers(source, item.node, out);
            walkMarkupDeep(source, item.node, markupRuleVisitor(out));
        }
        else if (item.kind === 'opaque-statements')
        {
            walkEmbeddedMarkup(source, item.start, item.end, markupRuleVisitor(out));
        }
        else if (item.kind === 'effect' || item.kind === 'watch' || item.kind === 'wrapper')
        {
            walkEmbeddedMarkup(source, item.bodyStart, item.bodyEnd, markupRuleVisitor(out));
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
/**
 * The message for a `bind:` whose target is a plain local rather than reactive state.
 *
 * Deliberately parallel to {@link assignToDerivedMessage}: that one covers a target that is
 * reactive but not writable, this one a target that is writable but not reactive. Between them
 * they are the two halves of GRAMMAR's "requires a writable reactive lvalue".
 */
export function bindTargetNotReactiveMessage(name: string): string
{
    return `\`bind:\` needs a writable reactive value, but \`${ name }\` is a plain variable. `
        + 'Writing to it cannot update the DOM, so the binding would only work one way. '
        + `Declare it as \`state ${ name }\` if it must change.`;
}

/**
 * Names a markup element introduces for its subtree: `let={row}` and `index={i}`.
 *
 * These are accessors, not variables, so they are neither a plain local nor a component-level
 * source - and a bind target must be judged against the scope it actually resolves in.
 */
function markupBoundNames(el: MarkupElement): string[]
{
    const names: string[] = [];
    for (const attr of el.attributes)
    {
        // The SAME gate the lowerer applies. Without it, a plain `<div let="x">` or any author
        // attribute happening to be called `let`/`index` was treated as a row binding, which
        // shadowed a real component local and rejected programs that used to build. Semantics owns
        // which attributes bind on which tag; this rule must not re-decide it - `isBindingAttr`
        // already answers for the tag, so no separate built-in test is needed.
        if (attr.spread || attr.name === null || attr.value.kind !== 'expression'
            || !isBindingAttr(el.tag, attr.name))
        {
            continue;
        }
        const text = attr.value.code.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(text))
        {
            names.push(text);
        }
    }
    return names;
}

/** An array-form linkage carried LEXICALLY with a row name: which form, its keys, its openness. */
interface RowFormLink
{
    form: string;
    keys: ReadonlySet<string>;
    open: boolean;
}

/** The lexical scope a bind target resolves in: rows (with any form linkage), region locals, nested keywords. */
interface BindScope
{
    rows: ReadonlyMap<string, RowFormLink | null>;
    region: ReadonlyMap<string, 'param' | 'local'>;
    keywords: ReadonlySet<string>;
}

/**
 * The complete bind-target rule. GRAMMAR: `bind:p={lvalue}` requires a WRITABLE REACTIVE lvalue.
 * The writable reactive lvalues are exactly: a `state` name, a `form` field path
 * (`login.email`), and an array-form row field (`row.qty`). A STORE is none of these: the
 * handle is a function (`box()`) and its state is written through its own setters, so a dotted
 * "store path" is a compile-silent mount crash and is rejected here.
 *
 * Resolution is scope-ordered, innermost first, and row-form linkage is LEXICAL: each `<For>`
 * binds its own row to its own array form, carried through the walk beside the row name. The
 * EMITTER wires row fields by NAME, component-wide - so wherever the lexical linkage and the
 * name-keyed registry disagree (two rows sharing a name, a plain row shadowing an array-form
 * row), the bind would wire the wrong form and is rejected with a rename.
 *
 * Dotted targets are classified from the AST and canonicalized, never pattern-matched: spacing,
 * comments, and line-wrapped dots spell the same chain. Wrapper spellings (parentheses, a
 * non-null assertion, bracket access) defeat the emitter rewrite even when the chain under them
 * is valid, so they are rejected with the plain spelling. What the rule cannot resolve it
 * leaves alone: an unsuppressable false positive is worse than a silent defect.
 */
function diagnoseBindTargets(
    source: string, component: ComponentDecl, analysis: ReactiveAnalysis,
    out: AzerothDiagnostic[], moduleScope: ModuleBindScope, moduleLevel = false
): void
{
    const IDENT = /^[A-Za-z_$][\w$]*$/;

    const stateNames = new Set<string>();
    const readOnlyKinds = new Map<string, string>();
    for (const src of analysis.sources)
    {
        if (src.kind === 'state')
        {
            stateNames.add(src.name);
        }
        else
        {
            readOnlyKinds.set(src.name, src.kind);
        }
    }
    const handleKinds = new Map<string, string>();
    for (const item of component.body)
    {
        if (item.kind === 'form' || item.kind === 'store' || item.kind === 'resource'
            || item.kind === 'stream' || item.kind === 'selector')
        {
            handleKinds.set(item.name, item.kind);
        }
    }
    const propAliases = analysis.propAliases ?? new Map<string, string>();
    const paramName = analysis.hasProps ? analysis.paramName ?? null : null;
    const openForms = analysis.openForms ?? new Set<string>();
    const arrayForms = analysis.arrayForms ?? new Map<string, ReadonlySet<string>>();
    const rowFormsGlobal = analysis.rowForms;

    // At module level "declare it as state" is illegal advice; the module remedy is the truth.
    const plainMessage = (name: string): string => moduleLevel
        ? '`bind:` needs a writable reactive value, but `' + name + '` is a module-scope '
            + 'variable, which no component tracks - the input would never update when it changes. '
            + 'Move it into the component as `state`.'
        : bindTargetNotReactiveMessage(name);

    // Plain variables the component body declares at statement level, destructured included.
    const plainLocals = new Set<string>();
    for (const item of component.body)
    {
        if (item.kind !== 'opaque-statements')
        {
            continue;
        }
        const { sourceFile } = parseStatementsSlice(blankMarkupRegions(source, item.start, item.end), item.start);
        for (const statement of sourceFile.statements)
        {
            if (ts.isVariableStatement(statement))
            {
                for (const declaration of statement.declarationList.declarations)
                {
                    collectBoundNames(declaration.name, plainLocals);
                }
            }
            else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
                && statement.name !== undefined)
            {
                plainLocals.add(statement.name.text);
            }
        }
    }

    const remedy = 'Bind a `state` instead, or handle the event yourself with an onInput handler.';
    const propsMessage = (read: string): string =>
        '`bind:` needs a writable reactive value, but `' + read + '` is a prop, and props are '
        + 'read-only in the child - the parent owns the value. `bind:` it where this component '
        + 'is used and call the write-back callback the parent passes, or copy it into local `state`.';
    const renameMessage = (text: string, head: string, why: string): string =>
        '`' + text + '` cannot be wired reliably: ' + why + ' The compiler wires array-form row '
        + 'fields by NAME across the whole component, so this bind cannot be proven to reach '
        + 'the right row. Rename one `let={ ' + head + ' }`.';
    const depthMessage = (text: string, field: string): string =>
        '`' + text + '` goes deeper than the field: `bind:` wires exactly one level (`' + field
        + '`), and a deeper write mutates the values snapshot without notifying anything. Bind '
        + '`' + field + '`, or handle the event yourself with an onInput handler.';
    const notValidMessage = (text: string): string =>
        '`bind:` needs a writable reactive value, but `' + text + '` is not a valid target '
        + 'expression. Bind a `state` name or a `form` field, or handle the event yourself '
        + 'with an onInput handler.';
    const notAssignableMessage = (text: string): string =>
        '`bind:` needs a writable reactive value, but `' + text + '` is not an assignable '
        + 'expression. Bind a `state` name or a `form` field, or handle the event yourself '
        + 'with an onInput handler.';
    const thisMessage = (text: string): string =>
        '`bind:` needs a writable reactive value, but `' + text + '` is never one: a component '
        + 'is a plain function, so `this` is undefined at runtime. Bind a `state` name instead.';
    const wrappedMessage = (canonical: string): string =>
        '`bind:` rewrites its target to wire the write-back, and parentheses, a non-null '
        + 'assertion, or bracket access around it defeat the rewrite - the binding would read '
        + 'and write raw, unwired values. Write the target plainly as `' + canonical + '`.';

    /** The message for a resolved-invalid bare target, or null when the target is valid/unknown. */
    const resolveBare = (name: string, scope: BindScope): string | null =>
    {
        // A reactive keyword declared INSIDE the embedded region (a nested `state` in a callback
        // is a real scoped source) shadows every outer meaning of the name. The region scan cannot
        // place it in an exact function scope, so the name is left ALONE rather than resolved -
        // silence over a wrong rejection.
        if (scope.keywords.has(name))
        {
            return null;
        }
        if (name === 'this')
        {
            return thisMessage('this');
        }
        if (scope.rows.has(name))
        {
            return '`bind:` needs a writable reactive value, but `' + name + '` is a row binding, '
                + 'which is read-only. Bind to the state the row came from, or handle the '
                + 'event yourself with an onInput handler.';
        }
        const local = scope.region.get(name);
        if (local === 'param')
        {
            return '`bind:` needs a writable reactive value, but `' + name + '` is a function '
                + 'parameter, which nothing reactive tracks - the input could never update. ' + remedy;
        }
        if (local === 'local')
        {
            return plainMessage(name);
        }
        if (stateNames.has(name))
        {
            return null;
        }
        const roKind = readOnlyKinds.get(name);
        if (roKind !== undefined)
        {
            return '`bind:` needs a writable reactive value, but `' + name + '` is a `' + roKind
                + '` value, which is read-only. Bind the `state` it is computed from, or handle '
                + 'the event yourself with an onInput handler.';
        }
        const handle = handleKinds.get(name);
        if (handle === 'form')
        {
            // Never recommend a spelling the compiler itself would reject: an array form has no
            // direct fields, an open form has no knowable ones, an empty form none at all.
            const rowKeys = arrayForms.get(name);
            if (rowKeys !== undefined)
            {
                const opening = '`bind:` needs a writable reactive value, but `' + name + '` is '
                    + 'the `form ' + name + '[]` handle itself, which has no fields of its own';
                if (openForms.has(name))
                {
                    return opening + ', and its row fields are not knowable at compile time. '
                        + 'Inline the blank-row fields in the `form ' + name + '[]` literal, or '
                        + 'handle the event yourself with an onInput handler.';
                }
                const first = [...rowKeys].find(key => isSpellableField(key));
                if (first === undefined)
                {
                    return opening + ', and its blank row declares no fields `bind:` can wire. '
                        + 'Handle the event yourself with an onInput handler.';
                }
                return opening + '. Iterate its rows and bind a row field there '
                    + '(`<For each={' + name + '.rows()} key={(row) => row.key} let={ row }>` '
                    + 'with `bind:value={row.' + first + '}`).';
            }
            const fields = analysis.forms.get(name) ?? new Set<string>();
            if (openForms.has(name) || fields.size === 0)
            {
                return '`bind:` needs a writable reactive value, but `' + name + '` is the '
                    + '`form` handle itself, which is not assignable' + (openForms.has(name)
                    ? ', and its fields are not knowable at compile time. Inline the fields '
                            + 'in the initial object literal to bind them, or handle the event '
                            + 'yourself with an onInput handler.'
                    : ', and it declares no fields.');
            }
            const first = [...fields].find(key => isSpellableField(key));
            if (first === undefined)
            {
                return '`bind:` needs a writable reactive value, but `' + name + '` is the '
                    + '`form` handle itself, which is not assignable, and none of its field names '
                    + 'is an identifier `bind:` can wire. Handle the event yourself with an '
                    + 'onInput handler.';
            }
            return '`bind:` needs a writable reactive value, but `' + name + '` is the `form` '
                + 'handle itself, which is not assignable. Bind one of its fields instead '
                + '(`' + name + '.' + first + '`).';
        }
        if (handle === 'store')
        {
            return '`bind:` needs a writable reactive value, but `' + name + '` is the `store` '
                + 'handle itself, which is not assignable. A store is read as `' + name + '()` and '
                + 'written through its own setters - bind a `state` instead, or write through a '
                + 'store method in an onInput handler.';
        }
        if (handle !== undefined)
        {
            return '`bind:` needs a writable reactive value, but `' + name + '` is a `' + handle
                + '` handle, which is read-only. Copy its value into `state` to edit it, or '
                + 'handle the event yourself with an onInput handler.';
        }
        if (propAliases.has(name))
        {
            return propsMessage(name);
        }
        if (plainLocals.has(name))
        {
            return plainMessage(name);
        }
        if (moduleScope.imports.has(name))
        {
            return '`bind:` needs a writable reactive value, but `' + name + '` is an import, '
                + 'and an imported binding cannot be assigned. Own the value as `state`, or write '
                + 'back through a function the module exports.';
        }
        if (moduleScope.vars.has(name))
        {
            return '`bind:` needs a writable reactive value, but `' + name + '` is a module-scope '
                + 'variable, which no component tracks - the input would never update when it changes. '
                + 'Move it into the component as `state`.';
        }
        return null;
    };

    /** The message for a resolved-invalid dotted target (canonical spelling), or null when valid/unknown. */
    const resolveDotted = (text: string, scope: BindScope): string | null =>
    {
        const segments = text.split('.');
        const head = segments[0] as string;
        if (scope.keywords.has(head))
        {
            return null;
        }
        if (scope.rows.has(head))
        {
            const link = scope.rows.get(head) ?? null;
            const field = segments[1] as string;
            // The emitter sugars row fields BY FIELD NAME, component-wide, and routes through the
            // row object's OWN `.form` - so which <For> registered a shared row name never
            // matters when both agree the FIELD is a row field. The only mis-wires are per field:
            // the registry claims a field this row does not carry (sugar on the wrong shape), or
            // drops a field this row needs (raw, dead).
            const sugared = rowFormsGlobal.get(head)?.has(field) ?? false;
            if (link === null)
            {
                if (sugared)
                {
                    return renameMessage(text, head, '`' + head + '` names a plain row here, but '
                        + 'an array-form row elsewhere in this component claims `' + field + '` '
                        + 'as a row field, so the emitter would wire it as one.');
                }
                // Property writes through a plain row alias are the author's business.
                return null;
            }
            if (link.open)
            {
                return '`' + text + '` cannot be wired: `' + head + '` iterates an array form '
                    + 'whose row fields are not knowable at compile time, because its initial '
                    + 'object does not declare them all literally. Inline the blank-row fields in '
                    + 'the `form ..[]` literal, or handle the event yourself with an onInput handler.';
            }
            if (!link.keys.has(field))
            {
                return '`' + text + '` is not a row field of `form ' + link.form + '[]` - its '
                    + 'row fields are ' + [...link.keys].map(k => '`' + k + '`').join(', ') + '.';
            }
            if (!sugared)
            {
                return renameMessage(text, head, 'another <For> row named `' + head + '` decides '
                    + 'which fields wire by name, and it does not carry `' + field + '` - the '
                    + 'bind would emit raw and dead.');
            }
            if (segments.length > 2)
            {
                return depthMessage(text, head + '.' + field);
            }
            return null;
        }
        // A param or a local as the head may ALIAS something writable: property writes through
        // an alias are the author's business. Only precisely classified heads are rejected.
        if (scope.region.has(head))
        {
            return null;
        }
        if (head === 'this')
        {
            return thisMessage(text);
        }
        if (paramName !== null && head === paramName)
        {
            return propsMessage(text);
        }
        // A destructured prop is precisely classified, unlike a plain local alias: the alias
        // exists ONLY as a props read, so a path through it is a write into the parent's object.
        if (propAliases.has(head))
        {
            return propsMessage(text);
        }
        const fields = analysis.forms.get(head);
        if (fields !== undefined)
        {
            const field = segments[1] as string;
            if (fields.has(field))
            {
                return segments.length > 2 ? depthMessage(text, head + '.' + field) : null;
            }
            // An OPEN key set (non-literal initializer, spread, computed key) means the compiler
            // cannot wire the field even though createForm may create it at runtime - and cannot
            // list "the fields" honestly either.
            if (openForms.has(head))
            {
                return '`' + text + '` cannot be wired: the fields of `form ' + head + '` are '
                    + 'not knowable at compile time, because its initial object does not declare '
                    + 'them all literally. Inline the field in the initial object literal, or '
                    + 'handle the event yourself with an onInput handler.';
            }
            if (fields.size === 0)
            {
                return '`' + text + '` is not a field of `form ' + head + '`, which declares no fields.';
            }
            return '`' + text + '` is not a field of `form ' + head + '` - its fields are '
                + [...fields].map(k => '`' + k + '`').join(', ') + '.';
        }
        // The array-form HANDLE has no fields of its own - a dotted bind through it targets the
        // FieldArrayApi record and is dead in both directions.
        const rowKeys = arrayForms.get(head);
        if (rowKeys !== undefined)
        {
            const opening = '`' + text + '` reads the `form ' + head + '[]` handle, which has no '
                + 'fields of its own - its rows do.';
            if (openForms.has(head))
            {
                return opening + ' Its row fields are not knowable at compile time - inline the '
                    + 'blank-row fields in the `form ' + head + '[]` literal, or handle the event '
                    + 'yourself with an onInput handler.';
            }
            const first = [...rowKeys].find(key => isSpellableField(key));
            if (first === undefined)
            {
                return opening + ' Its blank row declares no fields `bind:` can wire. Handle '
                    + 'the event yourself with an onInput handler.';
            }
            return opening + ' Iterate them and bind the row field there '
                + '(`<For each={' + head + '.rows()} key={(row) => row.key} let={ row }>` with '
                + '`bind:value={row.' + first + '}`).';
        }
        const handle = handleKinds.get(head);
        if (handle === 'store')
        {
            return '`bind:` cannot write through `' + head + '`, a `store` handle: a store is '
                + 'read as `' + head + '()` and written through its own setters, so `' + text + '` '
                + 'never reaches its state. Bind a `state` instead, or write through a store '
                + 'method in an onInput handler.';
        }
        if (handle === 'resource' || handle === 'stream' || handle === 'selector')
        {
            return '`bind:` needs a writable reactive value, but `' + text + '` writes into '
                + '`' + head + '`, a `' + handle + '` handle, which is read-only. Copy its value '
                + 'into `state` to edit it, or handle the event yourself with an onInput handler.';
        }
        return null;
    };

    /**
     * Syntax-level vetting for a target the canonicalizer could not classify. The write-back
     * synthesizes `target = value`, so a non-lvalue shape emits a module that is not valid
     * JavaScript - the bundler fails pointing into GENERATED code, never at the bind. Element
     * access with a computed key (`arr[i]`) is a legal lvalue and stays silent like other aliases.
     */
    const resolveShape = (text: string, scope: BindScope): string | null =>
    {
        let expression: ts.Expression;
        try
        {
            const { sourceFile } = parseExpressionSlice(text, 0);
            const statement = sourceFile.statements[0];
            if (statement === undefined || !ts.isExpressionStatement(statement))
            {
                return '`bind:` needs a writable reactive value, but this target is empty. '
                    + 'Bind a `state` name or a `form` field.';
            }
            // parseExpressionSlice wraps the text in parentheses; unwrap ITS wrapper only.
            expression = ts.isParenthesizedExpression(statement.expression)
                ? statement.expression.expression : statement.expression;
        }
        catch
        {
            return null;
        }
        // Author wrappers around the whole target.
        while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression))
        {
            expression = expression.expression;
        }
        if (expression.kind === ts.SyntaxKind.ThisKeyword)
        {
            return thisMessage(text);
        }
        if (ts.isIdentifier(expression))
        {
            if (expression.text.length === 0)
            {
                return notValidMessage(text);
            }
            return resolveBare(expression.text, scope);
        }
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
        {
            let sawOptional = false;
            let sawInvalid = false;
            let computedAccess = false;
            let bracketKey: string | null = null;
            let node: ts.Expression = expression;
            while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
                || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
            {
                if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
                {
                    node = node.expression;
                    continue;
                }
                if (node.questionDotToken !== undefined)
                {
                    sawOptional = true;
                }
                if (ts.isPropertyAccessExpression(node))
                {
                    if (!ts.isIdentifier(node.name) || node.name.text.length === 0)
                    {
                        sawInvalid = true;
                    }
                }
                else
                {
                    const argument = node.argumentExpression;
                    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
                    {
                        bracketKey = argument.text;
                    }
                    else
                    {
                        computedAccess = true;
                    }
                }
                node = node.expression;
            }
            if (node.kind === ts.SyntaxKind.ThisKeyword)
            {
                return thisMessage(text);
            }
            if (sawOptional)
            {
                return '`bind:` needs a writable reactive value, but `' + text + '` is an optional '
                    + 'chain, which can never be assigned. Bind the non-optional path, or handle '
                    + 'the event yourself with an onInput handler.';
            }
            if (sawInvalid || (ts.isIdentifier(node) && node.text.length === 0))
            {
                return notValidMessage(text);
            }
            if (bracketKey !== null && ts.isIdentifier(node)
                && (analysis.forms.has(node.text) || arrayForms.has(node.text)))
            {
                return 'The field `' + bracketKey + '` of `form ' + node.text + '` cannot be '
                    + 'wired by `bind:`: its name is not an identifier, so the compiler cannot '
                    + 'rewrite the access. Handle the event yourself with an onInput handler.';
            }
            // A computed element access on a resolvable-or-not head is an alias-class lvalue.
            void computedAccess;
            return null;
        }
        return notAssignableMessage(text);
    };

    const report = (attr: MarkupAttribute, message: string, code = 'azeroth/bind-target-not-reactive'): void =>
    {
        out.push({ code, severity: 'error', message, start: attr.start, end: attr.end });
    };

    const emptyScope: BindScope =
    {
        rows: new Map<string, RowFormLink | null>(),
        region: new Map<string, 'param' | 'local'>(),
        keywords: new Set<string>()
    };

    /**
     * Flags row-field READS the emitter would sugar into something this name does not hold.
     *
     * The model here MUST be the emitter's, not a lexical one. The emitter rewrites `NAME.field`
     * whenever the name-keyed registry claims that field for that name, component-wide, and it
     * deliberately does NOT let a same-named parameter or local shadow a row (walk.ts rowFieldOf:
     * row names are excluded from shadow registration on purpose). So a callback param, local, or
     * loop variable that happens to share a registered row name is sugared too - `{items.map(row
     * => row.qty)}` beside a `<For let={ row }>` over an array form compiles to
     * `row().form.values().qty` on a plain object and throws at first render. An earlier version
     * of this rule keyed on lexical rows and SKIPPED shadowed names, which silenced exactly the
     * crashing set.
     *
     * Only a KEYWORD source (a nested `state`/`store`) genuinely shadows, because the emitter
     * honours those; those stay silent.
     */
    const flagPoisonedRowReads = (sourceFile: ts.SourceFile, sliceStart: number, scope: BindScope, keywords: ReadonlySet<string>): void =>
    {
        const report = (node: ts.Node, message: string): void =>
        {
            out.push({
                code: 'azeroth/row-name-collision',
                severity: 'error',
                message,
                start: sliceStart + node.getStart(sourceFile),
                end: sliceStart + node.getEnd()
            });
        };

        const wiredByName = 'The compiler wires array-form row fields by NAME across the whole '
            + 'component, and it does not let a same-named local shadow a row.';

        const visitRead = (node: ts.Node): void =>
        {
            // `const { field } = row` and `row["field"]` are never rewritten (the sugar matches a
            // dotted access only), so they read the raw `{ key, form }` record and render empty.
            if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
                && node.initializer !== undefined && ts.isIdentifier(node.initializer))
            {
                const rowName = node.initializer.text;
                const link = scope.rows.get(rowName) ?? null;
                if (link !== null && !link.open && !keywords.has(rowName))
                {
                    const bound = new Set<string>();
                    collectBoundNames(node.name, bound);
                    const field = [...bound].find(key => link.keys.has(key));
                    if (field !== undefined)
                    {
                        report(node.name, 'Destructuring `' + rowName + '` does not read its form '
                            + 'fields: a row is a `{ key, form }` record, and only a dotted read '
                            + '(`' + rowName + '.' + field + '`) is rewritten to the field value. '
                            + 'Read the fields you need through the row.');
                        return;
                    }
                }
            }
            if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
                && (ts.isStringLiteral(node.argumentExpression)
                    || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)))
            {
                const rowName = node.expression.text;
                const link = scope.rows.get(rowName) ?? null;
                const field = node.argumentExpression.text;
                if (link !== null && !link.open && link.keys.has(field) && !keywords.has(rowName))
                {
                    report(node, '`' + rowName + '["' + field + '"]` is not rewritten to the field '
                        + 'value: only a dotted read is. Write `' + rowName + '.' + field + '`.');
                    return;
                }
            }
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
                && ts.isIdentifier(node.name))
            {
                const name = node.expression.text;
                const field = node.name.text;
                const link = scope.rows.get(name) ?? null;
                // ONLY an exact registry DISAGREEMENT is reported: this row lexically carries the
                // field and the name-keyed registry does not, or the reverse. That is decidable
                // from the two tables and nothing else.
                //
                // Everything softer was retired. Reporting a read merely because the registry
                // claims the name - a helper parameter, a statement-scoped local, a row whose
                // `each=` could not be followed - required guessing what the author meant, and six
                // rounds of adversarial review each found valid programs it refused: a helper
                // called WITH the row is correct, `rows.values()` is a documented getter, a form
                // named in a guard is not iterated. A rule that fails a build has to be right
                // every time, and this one could not be.
                if (link !== null && !link.open && !keywords.has(name))
                {
                    const sugared = rowFormsGlobal.get(name)?.has(field) ?? false;
                    if (link.keys.has(field) !== sugared)
                    {
                        report(node, '`' + name + '.' + field + '` would not read what this row '
                            + 'holds: ' + wiredByName + ' Rename one `let={ ' + name + ' }`.');
                        return;
                    }
                }
            }
            ts.forEachChild(node, visitRead);
        };
        visitRead(sourceFile);
    };

    /** Scans a TS slice for embedded markup, resolving the scope surrounding each region. */
    const scanEmbedded = (start: number, end: number, scope: BindScope): void =>
    {
        const first = findMarkupStart(source, start);
        // A read is poisoned by the REGISTRY, so any component that registers a row can carry one
        // - including in a slice with no markup at all. It is ALSO poisoned when the lexical row
        // exists but the registry is empty, which is exactly what a component whose only <For>
        // failed to link looks like: the rows render and every field reads nothing, and gating on
        // the registry alone meant that component was never scanned at all.
        const hasRows = rowFormsGlobal.size > 0 || scope.rows.size > 0;
        if ((first === -1 || first >= end) && !hasRows)
        {
            return;
        }
        // Keyword constructs nested in this slice (`state` in a .map callback, a `store` in an
        // effect body) declare scoped sources the TS parse cannot see.
        const declared = findConstructs(source.slice(start, end))
            .map(construct => 'name' in construct ? construct.name : null)
            .filter((name): name is string => typeof name === 'string');
        const keywords = declared.length > 0 ? new Set([...scope.keywords, ...declared]) : scope.keywords;
        const { sourceFile } = parseStatementsSlice(blankMarkupRegions(source, start, end), start);
        if (hasRows)
        {
            flagPoisonedRowReads(sourceFile, start, scope, keywords);
        }
        if (first === -1 || first >= end)
        {
            return;
        }
        let pos = start;
        for (;;)
        {
            const at = findMarkupStart(source, pos);
            if (at === -1 || at >= end)
            {
                return;
            }
            let parsed: { node: MarkupElement | MarkupFragment; end: number };
            try
            {
                parsed = parseMarkup(source, at);
            }
            catch
            {
                // Malformed markup is another rule's finding; this one must not crash on it.
                return;
            }
            const local = regionScopeAt(sourceFile, at - start);
            let region = scope.region;
            let rows = scope.rows;
            if (local.size > 0)
            {
                region = new Map([...scope.region, ...local]);
                rows = new Map([...scope.rows].filter(([name]) => !local.has(name)));
            }
            visitNode(parsed.node, { rows, region, keywords });
            pos = parsed.end;
        }
    };

    const visitNode = (node: MarkupElement | MarkupFragment, scope: BindScope): void =>
    {
        let inner = scope;
        if (node.kind === 'element')
        {
            const introduced = markupBoundNames(node);
            if (introduced.length > 0)
            {
                // A `<For>` over an array form links its `let=` row to that form, LEXICALLY;
                // every other introduced name (an `index=`, a Show/Match `let=`) is a plain row.
                let letName: string | null = null;
                let link: RowFormLink | null = null;
                const letAttr = node.attributes.find(a => !a.spread && a.name === 'let' && a.value.kind === 'expression');
                if (letAttr !== undefined && letAttr.value.kind === 'expression')
                {
                    letName = letAttr.value.code.trim();
                }
                if (node.tag === 'For' && letName !== null)
                {
                    const eachAttr = node.attributes.find(a => !a.spread && a.name === 'each' && a.value.kind === 'expression');
                    const formName = eachAttr !== undefined && eachAttr.value.kind === 'expression'
                        ? arrayFormEachName(eachAttr.value.code, arrayForms) : null;
                    const keys = formName !== null ? arrayForms.get(formName) : undefined;
                    if (formName !== null && keys !== undefined)
                    {
                        link = { form: formName, keys, open: openForms.has(formName) };
                    }
                }
                const rows = new Map(scope.rows);
                for (const name of introduced)
                {
                    rows.set(name, name === letName ? link : null);
                }
                let region = scope.region;
                if (introduced.some(name => scope.region.has(name)))
                {
                    const trimmed = new Map(scope.region);
                    for (const name of introduced)
                    {
                        trimmed.delete(name);
                    }
                    region = trimmed;
                }
                inner = { rows, region, keywords: scope.keywords };
            }

            // A file input never round-trips its value: the browser reports a fake path and
            // refuses the write back. Only a STATIC type="file" is knowable at compile time.
            const isFileInput = !node.isComponent && node.tag.toLowerCase() === 'input'
                && node.attributes.some(a => !a.spread && a.name === 'type'
                    && a.value.kind === 'static' && a.value.value.trim().toLowerCase() === 'file');

            for (const attr of node.attributes)
            {
                if (attr.spread || attr.name === null || attr.value.kind !== 'expression')
                {
                    continue;
                }
                if (!attr.name.startsWith('bind:'))
                {
                    // A render-function attribute can hold markup of its own; its binds answer
                    // to the scope of the function that carries them.
                    scanEmbedded(source.indexOf('{', attr.start) + 1, attr.end - 1, inner);
                    continue;
                }
                if (isFileInput && attr.name === 'bind:value')
                {
                    report(attr, 'The `value` of a file input cannot be two-way bound: the '
                        + 'browser only reports a fake path and refuses the write back. Read '
                        + '`$event.target.files` in an `onChange` handler and keep what you '
                        + 'need in `state`.', 'azeroth/bind-file-input');
                    continue;
                }
                const target = attr.value.code.trim();
                let message: string | null;
                if (target.length === 0)
                {
                    message = '`bind:` needs a writable reactive value, but this target is '
                        + 'empty. Bind a `state` name or a `form` field.';
                }
                else if (IDENT.test(target))
                {
                    message = resolveBare(target, inner);
                }
                else
                {
                    // Dotted targets are classified from the AST, never a regex: whitespace, a
                    // comment, or a line-wrapped dot spell the SAME chain, and wrapper spellings
                    // (parens, `!`, bracket access) of a knowable chain defeat the emitter.
                    const chain = canonicalDottedChain(target);
                    if (chain !== null)
                    {
                        const resolved = chain.canonical.includes('.')
                            ? resolveDotted(chain.canonical, inner)
                            : resolveBare(chain.canonical, inner);
                        message = resolved ?? (chain.wrapped ? wrappedMessage(chain.canonical) : null);
                    }
                    else
                    {
                        message = resolveShape(target, inner);
                    }
                }
                if (message !== null)
                {
                    report(attr, message);
                }
            }
        }

        for (const child of node.children)
        {
            if (child.kind === 'element' || child.kind === 'fragment')
            {
                visitNode(child, inner);
            }
            else if (child.kind === 'expression')
            {
                scanEmbedded(child.start + 1, child.end - 1, inner);
            }
        }
    };

    for (const item of component.body)
    {
        if (item.kind === 'markup')
        {
            visitNode(item.node, emptyScope);
        }
        else if (item.kind === 'opaque-statements')
        {
            scanEmbedded(item.start, item.end, emptyScope);
        }
        else if (item.kind === 'effect' || item.kind === 'watch' || item.kind === 'wrapper')
        {
            scanEmbedded(item.bodyStart, item.bodyEnd, emptyScope);
        }
    }
}

/**
 * A markup value is a NODE, so using one twice cannot mean what it reads as.
 *
 * `const frag = <b/>; <p>{frag}{frag}</p>` serializes TWO copies on the server and mounts ONE on
 * the client, because appending the same DOM node twice moves it. GRAMMAR's mode-equivalence
 * clause is unconditional for accepted programs - "string rendering followed by hydration is
 * observably equivalent to client rendering" - so the language has to refuse this program rather
 * than pick a winner between the modes. Making it equivalent instead would mean markup values
 * were re-renderable templates rather than nodes, which is a different language.
 *
 * The shape of this rule follows `azeroth/multiple-roots`: something the author wrote that would
 * be silently discarded (there, a whole region; here, one of the two placements) is made loud.
 *
 * Reuse is counted per REFERENCE in markup, which catches the literal `{frag}{frag}`. A reference
 * inside a callback (`{items.map(() => frag)}`) renders the same node once per item and is not
 * counted - it reads as one reference and the rule does not model call counts.
 *
 * @internal `azeroth/markup-value-reused`
 */
function diagnoseReusedMarkupValues(source: string, component: ComponentDecl, out: AzerothDiagnostic[]): void
{
    // Locals whose initializer IS a markup region. `blankMarkupRegions` replaces each region with
    // a `0` at the region's own offset, so a markup initializer parses as a NumericLiteral whose
    // position is exactly where markup starts in the ORIGINAL source - which is the test.
    const markupLocals = new Set<string>();
    for (const item of component.body)
    {
        if (item.kind !== 'opaque-statements')
        {
            continue;
        }
        const { sourceFile } = parseStatementsSlice(blankMarkupRegions(source, item.start, item.end), item.start);
        for (const statement of sourceFile.statements)
        {
            if (!ts.isVariableStatement(statement))
            {
                continue;
            }
            for (const declaration of statement.declarationList.declarations)
            {
                const initializer = declaration.initializer;
                if (initializer === undefined || !ts.isIdentifier(declaration.name)
                    || !ts.isNumericLiteral(initializer))
                {
                    continue;
                }
                const at = item.start + initializer.getStart(sourceFile);
                if (findMarkupStart(source, at) === at)
                {
                    markupLocals.add(declaration.name.text);
                }
            }
        }
    }
    if (markupLocals.size === 0)
    {
        return;
    }

    // PLACEMENTS, not references. Counting every identifier read a name appears in rejected
    // `onClick={() => log(frag)}` beside one placement, `{cond ? frag : frag}` (which places it
    // ONCE), and a `<For>` row parameter that merely shares the name - none of which diverge, all
    // of which compiled before. It also double-counted a single reference when markup was embedded
    // in a hole, so whether the rule fired depended on how TypeScript error-recovered the hole
    // text: an accident, not a rule.
    //
    // A placement is the narrow, decidable thing: a child hole whose ENTIRE expression is the
    // name, which is exactly what inserts the node. Anything else - a ternary, a call, an
    // attribute, a handler - is left alone. That undercounts (a name placed inside markup nested
    // in a hole is not seen), and undercounting is the safe direction: silence, never a false
    // build failure.
    const uses = new Map<string, { start: number; end: number }[]>();
    const placementName = (code: string): string | null =>
    {
        const text = code.trim();
        return /^[A-Za-z_$][\w$]*$/.test(text) && markupLocals.has(text) ? text : null;
    };
    const countPlacements = (node: MarkupElement | MarkupFragment, shadowed: ReadonlySet<string>): void =>
    {
        // A `let=`/`index=` row name shadows a markup local of the same spelling for the whole
        // subtree, the same way the bind rule trims its own scope - without this, a row parameter
        // that merely shares the name was counted as a placement of the local.
        let inner = shadowed;
        if (node.kind === 'element')
        {
            const introduced = markupBoundNames(node);
            if (introduced.length > 0)
            {
                inner = new Set([...shadowed, ...introduced]);
            }
        }
        for (const child of node.children)
        {
            if (child.kind === 'element' || child.kind === 'fragment')
            {
                countPlacements(child, inner);
                continue;
            }
            if (child.kind !== 'expression')
            {
                continue;
            }
            const name = placementName(child.code);
            if (name === null || inner.has(name))
            {
                continue;
            }
            // The hole spans `{` .. `}`; the name sits at the first non-space inside it.
            const at = child.start + 1 + (child.code.length - child.code.trimStart().length);
            const list = uses.get(name) ?? [];
            list.push({ start: at, end: at + name.length });
            uses.set(name, list);
        }
    };

    for (const item of component.body)
    {
        if (item.kind === 'markup')
        {
            countPlacements(item.node, new Set<string>());
        }
    }

    for (const [name, found] of uses)
    {
        if (found.length < 2)
        {
            continue;
        }
        // Reported on the SECOND and later placements: the first one is the placement that
        // survives on the client, so the later ones are the ones that vanish.
        for (const use of found.slice(1))
        {
            out.push({
                code: 'azeroth/markup-value-reused',
                // A WARNING, not an error. The divergence is real and measured, but the rule
                // decides it from syntax alone, and on this codebase every syntax-only guess about
                // author intent has eventually refused a valid program. It reports; it does not
                // fail the build.
                severity: 'warning',
                message: '`' + name + '` is a markup value, which is a single element - placing it '
                    + 'more than once renders it twice on the server and once on the client, where '
                    + 'the second placement MOVES the same node. Build the element where each copy '
                    + 'is used, or make `' + name + '` a function and call it at each placement.',
                start: use.start,
                end: use.end
            });
        }
    }
}

/** Imports and module-scope variables visible to every component in the module. */
interface ModuleBindScope
{
    imports: ReadonlySet<string>;
    vars: ReadonlySet<string>;
}

/** Collects imported names and module-scope variable names from the opaque module regions. */
function moduleBindScope(source: string, items: readonly { kind: string; start: number; end: number }[]): ModuleBindScope
{
    const imports = new Set<string>();
    const vars = new Set<string>();
    for (const item of items)
    {
        if (item.kind === 'component')
        {
            continue;
        }
        const { sourceFile } = parseStatementsSlice(blankMarkupRegions(source, item.start, item.end), item.start);
        for (const statement of sourceFile.statements)
        {
            if (ts.isImportDeclaration(statement) && statement.importClause !== undefined
                && statement.importClause.phaseModifier !== ts.SyntaxKind.TypeKeyword)
            {
                const clause = statement.importClause;
                if (clause.name !== undefined)
                {
                    imports.add(clause.name.text);
                }
                if (clause.namedBindings !== undefined)
                {
                    if (ts.isNamespaceImport(clause.namedBindings))
                    {
                        imports.add(clause.namedBindings.name.text);
                    }
                    else
                    {
                        for (const element of clause.namedBindings.elements)
                        {
                            if (!element.isTypeOnly)
                            {
                                imports.add(element.name.text);
                            }
                        }
                    }
                }
            }
            else if (ts.isVariableStatement(statement))
            {
                for (const declaration of statement.declarationList.declarations)
                {
                    collectBoundNames(declaration.name, vars);
                }
            }
            else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
                && statement.name !== undefined)
            {
                vars.add(statement.name.text);
            }
        }
    }
    return { imports, vars };
}

/**
 * Whether `text` can be written as `x.${text}` - the only spelling `bind:` rewrites. This is a
 * PROPERTY-NAME test, not a standalone-identifier test: after a dot ES5 allows reserved words, so
 * `login.class` is legal and genuinely wires, while a standalone-identifier check called it
 * unspellable and told the author to write an onInput handler instead. Unicode names pass here
 * exactly as they do in the emitted code; an ASCII regex denied those.
 */
function isSpellableField(text: string): boolean
{
    try
    {
        const { sourceFile } = parseExpressionSlice(`_.${ text }`, 0);
        const statement = sourceFile.statements[0];
        if (statement === undefined || !ts.isExpressionStatement(statement))
        {
            return false;
        }
        const expression = ts.isParenthesizedExpression(statement.expression)
            ? statement.expression.expression : statement.expression;
        return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)
            && expression.name.text === text;
    }
    catch
    {
        return false;
    }
}

/** Adds every name a binding pattern declares (identifier, object or array pattern) to `into`. */
function collectBoundNames(name: ts.BindingName, into: Set<string>): void
{
    if (ts.isIdentifier(name))
    {
        into.add(name.text);
        return;
    }
    for (const element of name.elements)
    {
        if (ts.isBindingElement(element))
        {
            collectBoundNames(element.name, into);
        }
    }
}

/**
 * Replaces every markup region in `source[start..end)` with `0` plus spaces, keeping all
 * offsets stable, so TypeScript can parse the surrounding statements cleanly. Markup is not TS;
 * an unblanked parse swallows whatever follows it.
 */
function blankMarkupRegions(source: string, start: number, end: number): string
{
    let out = source.slice(start, end);
    let pos = start;
    for (;;)
    {
        const at = findMarkupStart(source, pos);
        if (at === -1 || at >= end)
        {
            return out;
        }
        let regionEnd: number;
        try
        {
            regionEnd = parseMarkup(source, at).end;
        }
        catch
        {
            return out;
        }
        const stop = Math.min(regionEnd, end);
        out = out.slice(0, at - start) + '0' + ' '.repeat(stop - at - 1) + out.slice(stop - start);
        pos = regionEnd;
    }
}

/**
 * The scope surrounding position `pos` in a parsed slice: parameter names of every enclosing
 * function and variable names of every enclosing block, innermost winning. These SHADOW component
 * and module declarations, which is what keeps `(x) => <input bind:value={x} />` resolving to
 * the parameter even when a `state x` exists.
 */
/**
 * The canonical `a.b.c` spelling of an identifier-rooted access chain, or null when the
 * expression is anything else (optional links, computed element access, calls, `this`).
 * Spacing, comments, and line breaks around the dots are erased - they do not change which
 * chain it is. `wrapped` is true when the spelling carries parentheses, non-null assertions,
 * or string-literal bracket access anywhere: those parse to the same chain but DEFEAT the
 * emitter rewrite (it matches bare identifier roots), so a wrapped spelling of even a valid
 * target must be rejected with the plain one.
 */
function canonicalDottedChain(text: string): { canonical: string; wrapped: boolean } | null
{
    try
    {
        const { sourceFile } = parseExpressionSlice(text, 0);
        const statement = sourceFile.statements[0];
        if (statement === undefined || !ts.isExpressionStatement(statement))
        {
            return null;
        }
        let node: ts.Expression = ts.isParenthesizedExpression(statement.expression)
            ? statement.expression.expression : statement.expression;
        let wrapped = false;
        const unwrap = (expression: ts.Expression): ts.Expression =>
        {
            let current = expression;
            while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current))
            {
                wrapped = true;
                current = current.expression;
            }
            return current;
        };
        node = unwrap(node);
        const parts: string[] = [];
        for (;;)
        {
            if (ts.isPropertyAccessExpression(node))
            {
                if (node.questionDotToken !== undefined || !ts.isIdentifier(node.name)
                    || node.name.text.length === 0)
                {
                    return null;
                }
                parts.unshift(node.name.text);
                node = unwrap(node.expression);
                continue;
            }
            if (ts.isElementAccessExpression(node))
            {
                const argument = node.argumentExpression;
                const literal = ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument);
                if (node.questionDotToken !== undefined || !literal
                    || !isSpellableField((argument).text))
                {
                    return null;
                }
                wrapped = true;
                parts.unshift(argument.text);
                node = unwrap(node.expression);
                continue;
            }
            break;
        }
        if (!ts.isIdentifier(node) || node.text.length === 0)
        {
            return null;
        }
        parts.unshift(node.text);
        return { canonical: parts.join('.'), wrapped };
    }
    catch
    {
        return null;
    }
}

function regionScopeAt(sourceFile: ts.SourceFile, pos: number): Map<string, 'param' | 'local'>
{
    const scope = new Map<string, 'param' | 'local'>();
    const declare = (name: ts.BindingName, kind: 'param' | 'local'): void =>
    {
        const names = new Set<string>();
        collectBoundNames(name, names);
        for (const text of names)
        {
            scope.set(text, kind);
        }
    };
    const fromStatements = (statements: readonly ts.Statement[]): void =>
    {
        for (const statement of statements)
        {
            if (ts.isVariableStatement(statement))
            {
                for (const declaration of statement.declarationList.declarations)
                {
                    declare(declaration.name, 'local');
                }
            }
            else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
                && statement.name !== undefined)
            {
                scope.set(statement.name.text, 'local');
            }
        }
    };
    const visit = (node: ts.Node): void =>
    {
        if (pos < node.pos || pos >= node.end)
        {
            return;
        }
        if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node))
        {
            fromStatements(node.statements);
        }
        else if (ts.isCaseClause(node) || ts.isDefaultClause(node))
        {
            fromStatements(node.statements);
        }
        else if (ts.isFunctionLike(node))
        {
            for (const parameter of node.parameters)
            {
                declare(parameter.name, 'param');
            }
        }
        else if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node))
            && node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer))
        {
            for (const declaration of node.initializer.declarations)
            {
                declare(declaration.name, 'local');
            }
        }
        else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined)
        {
            declare(node.variableDeclaration.name, 'local');
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return scope;
}

function diagnoseDerivedWrites(source: string, component: ComponentDecl, analysis: ReactiveAnalysis, out: AzerothDiagnostic[]): void
{
    const readOnly = new Map(analysis.sources.filter(s => s.kind !== 'state').map(s => [s.name, s.kind]));
    if (readOnly.size === 0)
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
                const kind = readOnly.get(target.text);
                if (kind === undefined || seen.has(target.text))
                {
                    return;
                }
                seen.add(target.text);
                const span = locate(target);
                out.push({
                    code: 'azeroth/assign-to-derived',
                    severity: 'error',
                    message: assignToDerivedMessage(target.text, kind),
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

/**
 * Walks EVERY markup element reachable from `node`: direct children, and markup embedded in
 * expression values (attribute values and holes), re-parsed from the ORIGINAL source so a
 * finding inside `{cond ? <a/> : <b/>}` carries its absolute span. One walker for every
 * markup-level rule, so no rule can quietly cover less markup than another.
 */
function walkMarkupDeep(source: string, node: MarkupElement | MarkupFragment, visit: (el: MarkupElement) => void): void
{
    if (node.kind === 'element')
    {
        visit(node);
        for (const attr of node.attributes)
        {
            if (!attr.spread && attr.value.kind === 'expression')
            {
                walkEmbeddedMarkup(source, source.indexOf('{', attr.start) + 1, attr.end - 1, visit);
            }
        }
    }
    for (const child of node.children)
    {
        if (child.kind === 'element' || child.kind === 'fragment')
        {
            walkMarkupDeep(source, child, visit);
        }
        else if (child.kind === 'expression')
        {
            walkEmbeddedMarkup(source, child.start + 1, child.end - 1, visit);
        }
    }
}

/**
 * Finds and walks any markup regions inside `[start, end)` of the original source.
 * Malformed embedded markup is skipped here - its parse error surfaces through the
 * compile/type-check gates with its own message.
 */
function walkEmbeddedMarkup(source: string, start: number, end: number, visit: (el: MarkupElement) => void): void
{
    let pos = start;
    while (pos < end)
    {
        const at = findMarkupStart(source, pos);
        if (at === -1 || at >= end)
        {
            return;
        }
        let parsed: { node: MarkupElement | MarkupFragment; end: number };
        try
        {
            parsed = parseMarkup(source, at);
        }
        catch
        {
            return;
        }
        walkMarkupDeep(source, parsed.node, visit);
        pos = parsed.end;
    }
}

/**
 * JS reserved words that cannot become a binding parameter: emitting `(let) => ...`
 * is a syntax error the author would meet as an opaque build failure.
 */
const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return',
    'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var',
    'void', 'while', 'with', 'yield', 'await'
]);

/**
 * The binding-attribute rules (`let=` / `index=`, vocabulary-gated by tag): the value
 * must be a bare, non-reserved identifier (it becomes a callback parameter), the
 * declared names must be distinct, and the declaration must not compete with a
 * render-callback child, which binds the same names positionally.
 */
function bindingAttrRules(el: MarkupElement, out: AzerothDiagnostic[]): void
{
    const names: { name: string; attr: MarkupAttribute }[] = [];

    for (const attr of el.attributes)
    {
        if (attr.spread || attr.name === null || !isBindingAttr(el.tag, attr.name))
        {
            continue;
        }
        if (attr.value.kind !== 'expression')
        {
            out.push({
                code: 'azeroth/binding-value',
                severity: 'error',
                message: `'${ attr.name }' declares a subtree name and needs one: write ${ attr.name }={ name }`,
                start: attr.start,
                end: attr.end
            });
            continue;
        }
        const name = attr.value.code.trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || RESERVED_BINDING_NAMES.has(name))
        {
            out.push({
                code: 'azeroth/binding-value',
                severity: 'error',
                message: `'${ attr.name }' declares a NAME, not an expression - write ${ attr.name }={ someName } `
                    + 'and read it bare in the subtree (a reserved word cannot be a name)',
                start: attr.start,
                end: attr.end
            });
            continue;
        }
        names.push({ name, attr });
    }

    if (names.length === 0)
    {
        return;
    }

    const first = names[0];
    const second = names[1];
    if (first !== undefined && second !== undefined && first.name === second.name)
    {
        out.push({
            code: 'azeroth/binding-duplicate-name',
            severity: 'error',
            message: `'let' and 'index' declare the same name '${ second.name }' - the index would shadow the value`,
            start: second.attr.start,
            end: second.attr.end
        });
    }

}

/**
 * A render-callback child does not exist on a tag that declares binding attributes:
 * names are declared with `let=` / `index=`, read bare, and infer their types. A
 * zero-arg thunk child is the plain lazy form, not a binding, and stays legal. The
 * runtime's callback contract is untouched - it is what the binding attrs compile TO,
 * and the manual API; user components keep render-prop children.
 *
 * The tag set and the names in the message both come from BINDING_ATTRS, so a tag
 * added to the vocabulary is covered here the same day rather than silently skipped.
 */
function callbackChildRule(el: MarkupElement, out: AzerothDiagnostic[]): void
{
    const declared = BINDING_ATTRS.get(el.tag);
    if (declared === undefined)
    {
        return;
    }
    const only = el.children.filter(child => !(child.kind === 'text' && child.value.trim() === ''));
    const solo = only[0];
    if (only.length === 1 && solo !== undefined && solo.kind === 'expression'
        && isFunctionLiteral(solo.code.trim()) && !/^\(\s*\)/.test(solo.code.trim()))
    {
        const form = [...declared].map(name => `${ name }={ ${ name === 'index' ? 'i' : 'name' } }`).join(' ');
        out.push({
            code: 'azeroth/callback-children-removed',
            severity: 'error',
            message: `A render-callback child does not exist on <${ el.tag }>: declare the name with `
                + `\`${ form }\` and read it bare inside, like state.`,
            start: solo.start,
            end: solo.end
        });
    }
}

/**
 * A `<For>` row must be exactly ONE host element. The reconciler tracks and moves rows by
 * element identity, so a row rooted at a component or at control flow hands it a
 * DocumentFragment: the fragment empties itself into the DOM on first insert, and every
 * later reconcile diffs against an empty detached node - the list blanks itself. That is
 * silent data loss at run time, so the shape is rejected here instead.
 *
 * Wrapping is always available and costs one element (`<li>`, `<g>`); the wrapper is what
 * the reconciler moves.
 */
/**
 * `<For>` requires `key`. Its props type declares `key` non-optional and the runtime calls
 * `props.key(item, i)` unconditionally on both the reconcile and the hydrate path, so a keyless
 * `<For>` renders through SSR and then throws "props.key is not a function" the moment the
 * client mounts it - a page that serves and dies. Rejecting it at compile time is what the type
 * already says; a runtime index fallback would be a shim preserving a shape the contract forbids,
 * and index keys silently break row identity on reorder.
 *
 * @internal `azeroth/for-missing-key`
 */
function forKeyRule(el: MarkupElement, out: AzerothDiagnostic[]): void
{
    if (el.tag !== 'For'
        || el.attributes.some(attr => attr.spread || attr.name === 'key'))
    {
        return;
    }
    out.push({
        code: 'azeroth/for-missing-key',
        severity: 'error',
        message: '`<For>` needs a `key`: it tracks rows by key across updates, and without one the '
            + 'page renders on the server and then throws as soon as it mounts. Add '
            + '`key={(item) => item.id}` - any expression that is unique and stable per row.',
        start: el.start,
        end: el.end
    });
}

function forRowRule(el: MarkupElement, out: AzerothDiagnostic[]): void
{
    if (el.tag !== 'For')
    {
        return;
    }
    const real = el.children.filter(child => !(child.kind === 'text' && child.value.trim() === ''));
    const solo = real[0];

    // A callback/thunk child is the manual API's own form and is judged by its own rule - but
    // only a function LITERAL is that form. The exemption used to admit ANY expression child,
    // which let two shapes through that the runtime cannot render:
    //   `<For ...>{renderRow}</For>` - a function REFERENCE. SSR renders it correctly and the
    //     client throws inside insertBefore, the same serve-then-die split as a keyless <For>.
    //   `<For ... let={item}>{ item.n }</For>` - a bare hole. `let=` binds a row name for a row
    //     ELEMENT, so this throws "item is not defined" in both modes.
    // Neither is one host element, which is what a row must be, so both fall through to the
    // existing azeroth/for-row-shape arms below and are named there.
    if (real.length === 1 && solo !== undefined && solo.kind === 'expression'
        && isFunctionLiteral(solo.code.trim()))
    {
        return;
    }
    if (real.length === 1 && solo !== undefined && solo.kind === 'element' && !solo.isComponent)
    {
        return;
    }
    const offender = solo ?? el;
    const what = real.length === 0
        ? 'has no element to render'
        : real.length > 1
            ? `renders ${ real.length } children`
            : solo !== undefined && solo.kind === 'element'
                ? `is rooted at <${ solo.tag }>, which renders a fragment rather than one element`
                : 'is not an element';
    out.push({
        code: 'azeroth/for-row-shape',
        severity: 'error',
        message: `A <For> row must be exactly one host element - this row ${ what }. `
            + 'The list reconciler moves rows by element identity, so wrap the row in an element '
            + '(`<li>`, `<div>`, `<g>` inside SVG) and put the control flow inside it.',
        start: offender.start,
        end: offender.end
    });
}

/** The GRAMMAR 6.6 host-element rules: uniqueness, the reserved on* namespace, content ownership. */
function hostAttributeRules(el: MarkupElement, out: AzerothDiagnostic[]): void
{
    const hasContent = el.children.some(child => !(child.kind === 'text' && child.value.trim() === ''));
    const seen = new Set<string>();
    for (const attr of el.attributes)
    {
        if (attr.spread || attr.name === null)
        {
            continue;
        }
        if (seen.has(attr.name))
        {
            out.push({
                code: 'azeroth/duplicate-attr',
                severity: 'error',
                message: `Duplicate attribute '${ attr.name }' - render modes disagree on which one wins`,
                start: attr.start,
                end: attr.end
            });
        }
        seen.add(attr.name);

        if (attr.name === 'ref' && attr.value.kind !== 'expression')
        {
            out.push({
                code: 'azeroth/ref-value',
                severity: 'error',
                message: '\'ref\' needs an expression value - a callback (`ref={ el => ... }`) or a '
                    + 'createRef box (`ref={ box }`). A bare or string-valued ref can never receive '
                    + 'the element, and the render modes disagree on whether the attribute appears in the document.',
                start: attr.start,
                end: attr.end
            });
        }

        if (attr.name.startsWith('on:'))
        {
            out.push({
                code: 'azeroth/reserved-event-name',
                severity: 'error',
                message: `'${ attr.name }' - the exact-case event form \`on:Type\` is reserved for a future language version; it is not accepted today.`,
                start: attr.start,
                end: attr.end
            });
        }
        else if (isReservedHostAttribute(attr.name))
        {
            out.push({
                code: 'azeroth/reserved-event-name',
                severity: 'error',
                message: reservedHostAttributeMessage(attr.name),
                start: attr.start,
                end: attr.end
            });
        }

        if (CONTENT_PROPERTIES.has(attr.name) && hasContent)
        {
            out.push({
                code: 'azeroth/content-property-children',
                severity: 'error',
                message: contentChildrenMessage(attr.name),
                start: attr.start,
                end: attr.end
            });
        }
    }
}

/**
 * The GRAMMAR 6.6 component-prop uniqueness rules. Every explicit attribute EMITS a props
 * key; a duplicate would fall to the object literal's last-wins and silently drop author
 * code. A `bind:` claims its value key AND its write-back callback key; exactly ONE
 * authored handler may share that callback key (codegen composes them, write-back first).
 * Markup children emit `children` too, so an explicit children= prop alongside them collides.
 */
function componentPropRules(el: MarkupElement, out: AzerothDiagnostic[]): void
{
    const emitted = new Set<string>();
    const claim = (key: string, start: number, end: number): void =>
    {
        if (emitted.has(key))
        {
            out.push({
                code: 'azeroth/duplicate-prop',
                severity: 'error',
                message: `Duplicate prop '${ key }' - the later value would silently replace the earlier one`,
                start,
                end
            });
            return;
        }
        emitted.add(key);
    };

    bindingAttrRules(el, out);
    callbackChildRule(el, out);
    forRowRule(el, out);
    forKeyRule(el, out);

    for (const attr of el.attributes)
    {
        if (attr.spread || attr.name === null)
        {
            continue;
        }
        const name = attr.name;
        if (attr.value.kind === 'static' || attr.value.kind === 'none')
        {
            claim(name, attr.start, attr.end);
        }
        else if (hostEventType(name) !== null)
        {
            // Claimed in the write-back pass below, where the one-composable exemption lives.
        }
        else if (name.startsWith('bind:'))
        {
            claim(name.slice(5), attr.start, attr.end);
        }
        else
        {
            claim(name, attr.start, attr.end);
        }
    }

    const composable = new Set<string>();
    for (const attr of el.attributes)
    {
        if (!attr.spread && attr.name !== null && attr.name.startsWith('bind:') && attr.value.kind === 'expression')
        {
            const { callback } = bindWriteBack(attr.name.slice(5));
            claim(callback, attr.start, attr.end);
            composable.add(callback);
        }
    }
    for (const attr of el.attributes)
    {
        if (attr.spread || attr.name === null || hostEventType(attr.name) === null || attr.value.kind !== 'expression')
        {
            continue;
        }
        if (composable.has(attr.name))
        {
            composable.delete(attr.name);
            continue;
        }
        claim(attr.name, attr.start, attr.end);
    }

    if (el.children.length > 0 && emitted.has('children'))
    {
        const childrenAttr = el.attributes.find(attr => !attr.spread && attr.name === 'children');
        out.push({
            code: 'azeroth/duplicate-prop',
            severity: 'error',
            message: "Duplicate prop 'children' - the element has markup children AND an explicit children= prop",
            start: childrenAttr?.start ?? el.start,
            end: childrenAttr?.end ?? el.start + el.tag.length + 1
        });
    }
}

/** Dispatches one element to its name-domain's rule set. */
function markupRuleVisitor(out: AzerothDiagnostic[]): (el: MarkupElement) => void
{
    return (el) => (el.isComponent ? componentPropRules(el, out) : hostAttributeRules(el, out));
}

/** Walks markup for on* handlers whose value would run at setup, not on the event. */
function diagnoseEventHandlers(source: string, node: MarkupElement | MarkupFragment, out: AzerothDiagnostic[]): void
{
    walkMarkupDeep(source, node, (el) =>
    {
        for (const attr of el.attributes)
        {
            if (!attr.spread && attr.name !== null && hostEventType(attr.name) !== null &&
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
    });
}
