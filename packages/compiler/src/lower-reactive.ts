/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Nested-scope lowering for the state, derived and effect keywords.
 *
 * The component-body TOP LEVEL lowers `state`/`derived`/`effect` to createSignal/createMemo/
 * createEffect directly in codegen. This module lowers the SAME keywords when they appear in a NESTED
 * scope - a render callback (`items.map(i => { derived active = ... })`), an IIFE, a local helper, or a
 * module-level "composable" function - so the keywords work anywhere, not only at the top level.
 *
 * APPROACH (three steps, around the existing reactive rewrite):
 *   1. toMarkers   - text-transform each nested keyword statement into a MARKER call
 *                    (`__azMemo`/`__azSignal`/`__azEffect`), editing only the statement's edges so any
 *                    keyword NESTED inside its body stays in place for its own edit. The result is valid
 *                    TS the rewrite can parse.
 *   2. rewrite     - run the normal reactive read/write rewrite (rewrite.ts). The shared walk (walk.ts)
 *                    recognises the marker declarations as SCOPED sources, so a nested `derived`'s bare
 *                    reads gain `()` within its scope, exactly like a top-level source.
 *   3. stripMarkers- replace the markers with the real runtime calls and report which were used (so the
 *                    caller can add them to the module's import set).
 *
 * The markers exist only between steps 1 and 3; emitted output never contains them.
 *
 * @internal Compiler codegen-support stage; not part of the package's public API.
 */

import * as ts from 'typescript';
import type { ReactiveSources } from './dep.ts';
import type { BodyItem, StateDecl, DerivedDecl, DeferredDecl, EffectBlock, WatchBlock, WrapperBlock } from './ast.ts';

import { createCodeWalker, maskMarkupOperands, tryParseConstruct, skipTrivia } from './parser.ts';
import { parseDeclarationSlice, parseExpressionSlice, parseStatementsSlice, type ParsedSlice } from './ts-slice.ts';
import { rewriteStatements, rewriteReactive, setterName } from './rewrite.ts';
import { MARKER_MEMO, MARKER_SIGNAL, MARKER_DEFERRED } from './markers.ts';
import { RUNTIME_FN, LOWERABLE, LOWERABLE_WORDS } from './keyword-spec.ts';

/**
 * Splits `[start, end)` of `source` at TOP-LEVEL commas - skipping nested ()/[]/{}, strings,
 * templates, comments, and regex literals (the same lexical model the rewriter itself uses via
 * {@link createCodeWalker}) - returning the trimmed span of each non-empty part. THE one comma splitter:
 * codegen splits a `watch` dependency list through the string form below, and the projection
 * splits the SAME list as mapped spans; sharing the scan is what keeps the runtime and the
 * types agreeing on where each dependency starts and ends.
 */
export function splitTopLevelCommaSpans(source: string, start: number, end: number): { start: number; end: number }[]
{
    const spans: { start: number; end: number }[] = [];
    let depth = 0;
    let segStart = start;
    let i = start;
    const walk = createCodeWalker(source, start, end, true);

    const push = (from: number, to: number): void =>
    {
        while (from < to && ts.isWhiteSpaceLike(source.charCodeAt(from)))
        {
            from++;
        }
        while (to > from && ts.isWhiteSpaceLike(source.charCodeAt(to - 1)))
        {
            to--;
        }
        if (to > from)
        {
            spans.push({ start: from, end: to });
        }
    };

    while (i < end)
    {
        const token = walk(i);
        if (token.kind === 'open')
        {
            depth++;
        }
        else if (token.kind === 'close')
        {
            depth--;
        }
        else if (token.kind === 'punct' && token.text === ',' && depth === 0)
        {
            push(segStart, i);
            segStart = token.next;
        }
        i = token.next;
    }
    push(segStart, end);
    return spans;
}

/** Splits a comma list at TOP-LEVEL commas; the string form of {@link splitTopLevelCommaSpans}. */
export function splitTopLevelCommas(code: string): string[]
{
    return splitTopLevelCommaSpans(code, 0, code.length).map((span) => code.slice(span.start, span.end));
}

/** Builds the `on(...)` dependency getters from a `watch (deps)` list. `called` true -> `() => (count())`
 *  (final form for top-level codegen); false -> `() => (count)` (bare; the later rewrite adds the call). */
export function watchDepGetters(depsText: string, sources: ReactiveSources, called: boolean): string[]
{
    return splitTopLevelCommas(depsText).map(dep => called ? `() => (${ rewriteReactive(dep, sources) })` : `() => (${ dep })`);
}

/** A position-based text edit (insertion when `start === end`). */
interface Edit { start: number; end: number; text: string }

/**
 * Words after which a `{` opens an object literal: each expects an expression, a type after
 * `extends`, an options clause after `with`.
 */
const OBJECT_AFTER_WORD: ReadonlySet<string> = new Set([
    'return', 'typeof', 'yield', 'await', 'new', 'delete', 'in', 'of', 'instanceof', 'throw', 'default', 'extends', 'with'
]);

/** Punctuators after which a `{` opens an object; `>` is left out so `=> {` stays a block. */
const OBJECT_AFTER_CHAR: ReadonlySet<string> = new Set([
    '(', '[', ',', '=', '?', '&', '|', '!', '~', '+', '-', '*', '/', '%', '^', '<', '.'
]);

/**
 * Whether a lead word before a `{` expects an expression: not as a member name, not `return` or
 * `yield` before a line break, and `of` only in a `for (...)` head.
 */
function wordLeadsObject(word: string, member: boolean, lineBreak: boolean, scope: Scope): boolean
{
    return OBJECT_AFTER_WORD.has(word) && !member
        && !(lineBreak && (word === 'return' || word === 'yield'))
        && (word !== 'of' || scope.forHead === true);
}

/** What an open bracket holds: statements, object members, class members, or an expression list. */
interface Scope
{
    kind: 'block' | 'object' | 'class' | 'list';
    open: number;
    ternaries: number;
    /** A `for (` or `for await (` head. */
    forHead?: boolean;
}

/** Whether the `?` at `i` opens a conditional rather than `??` or `?.`. */
function opensConditional(code: string, i: number): boolean
{
    return code[i - 1] !== '?' && code[i + 1] !== '?' && !(code[i + 1] === '.' && !/[0-9]/.test(code[i + 2] ?? ''));
}

/**
 * Confirms statement ownership when a keyword-shaped token at an authored boundary falls
 * outside the structural walker's idea of a block. An ordinary member, parameter or the
 * unbraced body of a control statement cannot supply this evidence. Parse at most once per
 * candidate-bearing slice and use the existing expression wrapper to preserve its grammar.
 */
export function visitStatementListExpressions(
    code: string,
    expression: boolean,
    visit: (statement: ts.ExpressionStatement, owner: ts.Block | ts.ModuleBlock | ts.SourceFile | ts.CaseOrDefaultClause,
        parsed: ParsedSlice, index: number) => void,
    typeMembers?: Set<number>
): void
{
    const masked = maskMarkupOperands(code, expression);
    const parsed = expression ? parseExpressionSlice(masked, 0) : parseStatementsSlice(masked, 0);
    const pending: ts.Node[] = [parsed.sourceFile];
    while (pending.length > 0)
    {
        const node = pending.pop() as ts.Node;
        if (typeMembers && ts.isPropertySignature(node) && ts.isIdentifier(node.name))
        {
            typeMembers.add(parsed.mapPos(node.name.getStart(parsed.sourceFile)));
        }
        if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isSourceFile(node) || ts.isCaseOrDefaultClause(node))
        {
            for (const [index, statement] of node.statements.entries())
            {
                if (ts.isExpressionStatement(statement))
                {
                    visit(statement, node, parsed, index);
                }
            }
        }
        ts.forEachChild(node, child =>
        {
            pending.push(child);
        });
    }
}

function constructPositions(code: string, expression: boolean): { statements: Map<number, number>; typeMembers: Set<number> }
{
    const statements = new Map<number, number>();
    const typeMembers = new Set<number>();
    visitStatementListExpressions(code, expression, (node, owner, { sourceFile, mapPos }) =>
    {
        const list = ts.isCaseOrDefaultClause(owner) ? owner.parent : owner;
        statements.set(mapPos(node.getStart(sourceFile)), ts.isSourceFile(list) ? -1 : mapPos(list.getStart(sourceFile)));
    }, typeMembers);
    return { statements, typeMembers };
}

/**
 * Finds every reactive keyword construct at a statement position, at ANY nesting depth, in `code`.
 * Descends into bodies (the scan continues past just the keyword) so a keyword nested inside an effect
 * body or an arrow block is found too. Strings/templates/comments/regex are skipped via {@link createCodeWalker}.
 * Object and class members are not statements; `expression` starts the scan in expression position.
 */
export function findConstructs(code: string, expression = false): BodyItem[]
{
    const out: BodyItem[] = [];
    let i = 0;
    let prevChar = expression ? '(' : '';
    let prevWord = '';
    let atStmtStart = !expression;
    const walk = createCodeWalker(code, 0, code.length, expression, true);
    let positions: ReturnType<typeof constructPositions> | undefined;
    // Declaration initializers can contain statements before their trailing `with` clause.
    let optionEnds: Map<number, number> | undefined;
    let opaqueUntil = 0;
    let postfix = false;
    let literal = false;
    let member = false;
    let lineBreak = false;
    let forAwait = false;
    const scopes: Scope[] = [{ kind: expression ? 'list' : 'block', open: -1, ternaries: 0 }];
    // The depth whose next `{` is a class body, and whether the last `:` was a case or label colon.
    let classDepth = -1;
    let classAngles = 0;
    let colonOpensBlock = false;

    while (i < code.length)
    {
        const scope = scopes[scopes.length - 1] as Scope;
        const s = walk(i);
        opaqueUntil = optionEnds?.get(i) ?? opaqueUntil;
        if (i >= opaqueUntil && s.kind === 'identifier' && (atStmtStart ||
            (LOWERABLE_WORDS.has(s.text) && (prevChar === '{' || prevChar === '}' || prevChar === ';'))))
        {
            const construct = tryParseConstruct(code, i, code.length);
            if (construct !== null && LOWERABLE.has(construct.kind))
            {
                // A wrong scope must not let a recognizable Allman block ship as a bare
                // name followed by an ordinary block. The authored boundary above rules
                // out ASI-only starts. A TypeScript statement index separates method names
                // and class fields from real statement-list entries at the same boundary.
                // Two interface fields can look like one declaration split over a newline.
                // Require positive member evidence so recovery around a real framework
                // statement never disqualifies it.
                const splitName = 'nameStart' in construct && /[\r\n\u2028\u2029]/.test(code.slice(s.next, construct.nameStart));
                if (!atStmtStart || splitName)
                {
                    positions ??= constructPositions(code, expression);
                }
                if ((atStmtStart || positions?.statements.get(i) === scope.open) && !(splitName && positions?.typeMembers.has(i)))
                {
                    out.push(construct);
                    // The emission owns an effect's complete header and a declaration's
                    // options. Walk their tokens for context, but never place a second edit
                    // inside those spans. The initializer and the effect body remain open.
                    if (construct.kind === 'watch' || construct.kind === 'effect')
                    {
                        opaqueUntil = construct.bodyStart - 1;
                    }
                    else if ('optionsStart' in construct && construct.optionsStart !== null && construct.optionsEnd !== null)
                    {
                        optionEnds ??= new Map<number, number>();
                        optionEnds.set(construct.optionsStart, construct.optionsEnd);
                    }
                }
            }
        }
        const named = s.member;
        if (s.kind === 'open')
        {
            let kind: Scope['kind'] = 'list';
            if (s.text === '{')
            {
                const objectLead = prevWord !== '' ? wordLeadsObject(prevWord, member, lineBreak, scope)
                    : prevChar === ':' ? !colonOpensBlock : OBJECT_AFTER_CHAR.has(prevChar) && !postfix && !literal;
                // A `{` inside the pending class header's type arguments is a type literal.
                const header = classDepth === scopes.length && classAngles > 0;
                kind = classDepth === scopes.length && !objectLead && !header ? 'class' : objectLead || header ? 'object' : 'block';
                if (kind === 'class')
                {
                    classDepth = -1;
                }
            }
            const forHead = s.text === '(' && !member && (prevWord === 'for' || forAwait);
            scopes.push({ kind, open: i, ternaries: 0, forHead });
            atStmtStart = kind === 'block';
        }
        else if (s.kind === 'close')
        {
            // A closer closes its own kind: a `}` leaves a `(` or `[` open, and a `)` or `]`
            // closes the nearest one through object scopes, never a block or a class body.
            if (s.text !== '}')
            {
                let at = scopes.length - 1;
                while ((scopes[at] as Scope).kind === 'object')
                {
                    at--;
                }
                if (at > 0 && (scopes[at] as Scope).kind === 'list')
                {
                    scopes.length = at;
                }
            }
            else if (scopes.length > 1 && scope.kind !== 'list')
            {
                scopes.pop();
            }
            if (classDepth > scopes.length)
            {
                classDepth = -1;
            }
            const outer = (scopes[scopes.length - 1] as Scope).kind;
            atStmtStart = s.text === '}' && outer !== 'object' && outer !== 'class';
        }
        else if (s.kind !== 'trivia')
        {
            if (s.kind === 'punct' && s.text === '?' && opensConditional(code, i))
            {
                scope.ternaries++;
            }
            else if (s.kind === 'punct' && s.text === ':')
            {
                colonOpensBlock = scope.ternaries === 0 && scope.kind === 'block';
                scope.ternaries = Math.max(0, scope.ternaries - 1);
            }
            else if (s.kind === 'identifier' && s.text === 'class' && !named
                && (scope.kind !== 'class' || prevChar === ':' || OBJECT_AFTER_CHAR.has(prevChar)))
            {
                // In a class body `class` is a member name unless an initializer leads to it.
                const at = skipTrivia(code, s.next);
                if (code[at] === '{' || ts.isIdentifierStart(code.codePointAt(at) ?? 0, ts.ScriptTarget.Latest))
                {
                    classDepth = scopes.length;
                    classAngles = 0;
                }
            }
            else if (s.kind === 'punct' && classDepth === scopes.length && (s.text === '<' || (s.text === '>' && code[i - 1] !== '=')))
            {
                classAngles = Math.max(0, classAngles + (s.text === '<' ? 1 : -1));
            }
            else if (s.kind === 'punct' && s.text === ';' && scope.forHead !== true)
            {
                // A statement ends here, so a bracket, a conditional or a class header left open
                // was misread: the scan goes back to the enclosing brace scope.
                while (scopes.length > 1 && (scopes[scopes.length - 1] as Scope).kind === 'list')
                {
                    scopes.pop();
                }
                (scopes[scopes.length - 1] as Scope).ternaries = 0;
                if (classDepth >= scopes.length)
                {
                    classDepth = -1;
                }
            }
            const { kind } = scopes[scopes.length - 1] as Scope;
            atStmtStart = s.kind === 'punct' && s.text === ';' && kind !== 'object' && kind !== 'class';
        }
        if (s.kind === 'trivia')
        {
            lineBreak ||= /[\n\r\u2028\u2029]/.test(code.slice(i, s.next));
        }
        else
        {
            postfix = s.postfix;
            forAwait = s.kind === 'identifier' && s.text === 'await' && prevWord === 'for' && !member;
            literal = s.kind === 'literal';
            member = named;
            lineBreak = false;
            prevChar = s.prevChar;
            prevWord = s.prevWord;
        }
        i = s.next;
    }
    return out;
}

/** Edge edits turning a `state` declaration into a `__azSignal` marker (initializer left in place). */
function stateEdits(code: string, decl: StateDecl): Edit[]
{
    const parsed = parseDeclarationSlice(code, decl);
    if (parsed === null)
    {
        return [];
    }
    const setter = setterName(decl.name);
    const typeArg = parsed.type ? `<${ parsed.type.getText(parsed.sourceFile) }>` : '';
    const header = { start: decl.start, text: `const [${ decl.name }, ${ setter }] = ${ MARKER_SIGNAL }${ typeArg }(` };
    if (parsed.initializer)
    {
        const initStart = parsed.mapPos(parsed.initializer.getStart(parsed.sourceFile));
        const initEnd = parsed.mapPos(parsed.initializer.getEnd());
        // A `with { ... }` clause sits after the initializer; replace it (and the leading `with`) with a
        // second argument so the initializer text itself stays in place for any nested-keyword edits.
        if (decl.optionsStart !== null && decl.optionsEnd !== null)
        {
            return [
                { ...header, end: initStart },
                { start: initEnd, end: decl.optionsEnd, text: `, ${ code.slice(decl.optionsStart, decl.optionsEnd) })` }
            ];
        }
        return [{ ...header, end: initStart }, { start: initEnd, end: initEnd, text: ')' }];
    }
    return [{ start: decl.start, end: decl.valueEnd, text: `const [${ decl.name }, ${ setter }] = ${ MARKER_SIGNAL }${ typeArg }();` }];
}

/** Edge edits turning a `derived`/`deferred` declaration into its marker (initializer left in place). */
function memoEdits(code: string, decl: DerivedDecl | DeferredDecl, marker: string): Edit[]
{
    const parsed = parseDeclarationSlice(code, decl);
    if (parsed === null || !parsed.initializer)
    {
        return [];
    }
    const initStart = parsed.mapPos(parsed.initializer.getStart(parsed.sourceFile));
    const initEnd = parsed.mapPos(parsed.initializer.getEnd());
    const header = { start: decl.start, end: initStart, text: `const ${ decl.name } = ${ marker }(() => (` };
    if (decl.optionsStart !== null && decl.optionsEnd !== null)
    {
        return [header, { start: initEnd, end: decl.optionsEnd, text: `), ${ code.slice(decl.optionsStart, decl.optionsEnd) })` }];
    }
    return [header, { start: initEnd, end: initEnd, text: '))' }];
}

/** Edge edits turning an `effect` block into a `createEffect` call (body left in place). The header span
 *  runs to the body `{`, so it also swallows a `with { ... }` clause placed before it. */
function effectEdits(code: string, eff: EffectBlock): Edit[]
{
    const optsArg = eff.optionsStart !== null && eff.optionsEnd !== null ? `, ${ code.slice(eff.optionsStart, eff.optionsEnd) }` : '';
    return [
        { start: eff.start, end: eff.bodyStart, text: 'createEffect(() => {' },
        { start: eff.bodyEnd, end: eff.end, text: `}${ optsArg });` }
    ];
}

/** Edge edits turning a `watch (deps) [(params)] [with {...}] { body }` block into an `on(...)` call. */
function watchEdits(code: string, w: WatchBlock): Edit[]
{
    // Bare dep getters here (`() => (dep)`); the later rewrite adds the call. Body stays in place.
    const deps = watchDepGetters(code.slice(w.depsStart, w.depsEnd), { names: new Set<string>(), hasProps: false }, false).join(', ');
    const params = w.paramsStart !== null && w.paramsEnd !== null ? code.slice(w.paramsStart, w.paramsEnd) : '';
    const optsArg = w.optionsStart !== null && w.optionsEnd !== null ? `, ${ code.slice(w.optionsStart, w.optionsEnd) }` : '';
    return [
        { start: w.start, end: w.bodyStart, text: `on([${ deps }], (${ params }) => {` },
        { start: w.bodyEnd, end: w.end, text: `}${ optsArg });` }
    ];
}

/** Edge edits turning a `<keyword> { body }` block-wrapper into a `<fn>(() => { body })` call. */
function wrapperEdits(w: WrapperBlock): Edit[]
{
    return [
        { start: w.start, end: w.bodyStart, text: `${ w.fn }(() => {` },
        { start: w.bodyEnd, end: w.end, text: '});' }
    ];
}

/**
 * Transforms every nested keyword construct in `code` into its lowered form. Source declarations
 * (state/derived/deferred) become MARKER calls the walk recognises as scoped sources; the others
 * (effect/watch/wrappers) emit their runtime call directly. `used` reports those directly-emitted
 * runtime helpers (the marker ones are reported by {@link stripMarkers}).
 */
function toMarkers(code: string, expression = false): { code: string; hasKeywords: boolean; used: string[] }
{
    const constructs = findConstructs(code, expression);
    if (constructs.length === 0)
    {
        return { code, hasKeywords: false, used: [] };
    }
    const edits: Edit[] = [];
    const used = new Set<string>();
    for (const c of constructs)
    {
        if (c.kind === 'state')
        {
            edits.push(...stateEdits(code, c));
        }
        else if (c.kind === 'derived')
        {
            edits.push(...memoEdits(code, c, MARKER_MEMO));
        }
        else if (c.kind === 'deferred')
        {
            edits.push(...memoEdits(code, c, MARKER_DEFERRED));
        }
        else if (c.kind === 'effect')
        {
            edits.push(...effectEdits(code, c));
            used.add(RUNTIME_FN.effect);
        }
        else if (c.kind === 'watch')
        {
            edits.push(...watchEdits(code, c));
            used.add(RUNTIME_FN.watch);
        }
        else if (c.kind === 'wrapper')
        {
            edits.push(...wrapperEdits(c));
            used.add(c.fn);
        }
    }
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let out = code;
    for (const edit of edits)
    {
        out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    }
    return { code: out, hasKeywords: true, used: [...used] };
}

/** Replaces the transient source markers with the real runtime calls; reports which were used. */
function stripMarkers(code: string): { code: string; used: string[] }
{
    const used: string[] = [];
    let out = code;
    if (out.includes(MARKER_MEMO))
    {
        out = out.split(MARKER_MEMO).join(RUNTIME_FN.derived);
        used.push(RUNTIME_FN.derived);
    }
    if (out.includes(MARKER_SIGNAL))
    {
        out = out.split(MARKER_SIGNAL).join(RUNTIME_FN.state);
        used.push(RUNTIME_FN.state);
    }
    if (out.includes(MARKER_DEFERRED))
    {
        out = out.split(MARKER_DEFERRED).join(RUNTIME_FN.deferred);
        used.push(RUNTIME_FN.deferred);
    }
    return { code: out, used };
}

/**
 * Lowers nested keyword constructs then runs the reactive rewrite over a statement-list region (an
 * effect/watch body or opaque setup run). When the region has no nested keywords this is exactly
 * {@link rewriteStatements}; otherwise the keywords are lowered, rewritten with scope-aware reactivity,
 * and the markers stripped.
 *
 * @returns the lowered/rewritten code and the runtime helper names it introduced.
 */
export function lowerStatements(code: string, sources: ReactiveSources, offset = 0): { code: string; used: string[] }
{
    const { code: markered, hasKeywords, used: directUsed } = toMarkers(code);
    if (!hasKeywords)
    {
        return { code: rewriteStatements(code, sources, offset), used: [] };
    }
    const stripped = stripMarkers(rewriteStatements(markered, sources, offset));
    return { code: stripped.code, used: [...directUsed, ...stripped.used] };
}

/** {@link lowerStatements} for an expression region (a hole, attribute value, or render callback). */
export function lowerExpression(code: string, sources: ReactiveSources, offset = 0): { code: string; used: string[] }
{
    const { code: markered, hasKeywords, used: directUsed } = toMarkers(code, true);
    if (!hasKeywords)
    {
        return { code: rewriteReactive(code, sources, offset), used: [] };
    }
    const stripped = stripMarkers(rewriteReactive(markered, sources, offset));
    return { code: stripped.code, used: [...directUsed, ...stripped.used] };
}
