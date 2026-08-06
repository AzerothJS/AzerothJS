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
        else
        {
            diagnoseMalformedComponents(source, item.start, item.end, diagnostics);
            // Module-scope markup (`const row = () => <li/>`) compiles through the same
            // lowerer, so it answers to the same GRAMMAR 6.6 rules.
            walkEmbeddedMarkup(source, item.start, item.end, markupRuleVisitor(diagnostics));
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
        //   2. `state count = 0` then `<div>…` - the value `0` makes `<` a COMPARISON to `step`
        //      (`0 < div > …`), so the markup is not seen as markup; instead the whole thing runs
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
 * declaration value because a `;` was missing (`state count = 0` then `<div>…`). Returns its
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

function diagnoseComponent(source: string, component: ComponentDecl, out: AzerothDiagnostic[]): void
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

    // azeroth/handler-not-function, plus the GRAMMAR 6.6 markup rules (duplicate-attr,
    // duplicate-prop, reserved-event-name, content-property-children) - both walk the SAME
    // deep markup traversal, embedded expression markup included.
    for (const item of component.body)
    {
        if (item.kind === 'markup')
        {
            diagnoseEventHandlers(source, item.node, out);
            walkMarkupDeep(source, item.node, markupRuleVisitor(out));
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
function forRowRule(el: MarkupElement, out: AzerothDiagnostic[]): void
{
    if (el.tag !== 'For')
    {
        return;
    }
    const real = el.children.filter(child => !(child.kind === 'text' && child.value.trim() === ''));
    const solo = real[0];

    // A callback/thunk child is the manual API's own form and is judged by its own rule.
    if (real.length === 1 && solo !== undefined && solo.kind === 'expression')
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
