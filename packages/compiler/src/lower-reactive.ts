/**
 * MODULE: compiler/lower-reactive - nested-scope lowering for the state/derived/effect keywords
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

import type { ReactiveSources } from './dep.ts';
import type { BodyItem, StateDecl, DerivedDecl, DeferredDecl, EffectBlock, WatchBlock, WrapperBlock } from './ast.ts';

import { step, tryParseConstruct, skipTrivia } from './parser.ts';
import { parseDeclarationSlice } from './ts-slice.ts';
import { rewriteStatements, rewriteReactive, setterName } from './rewrite.ts';
import { MARKER_MEMO, MARKER_SIGNAL, MARKER_DEFERRED } from './markers.ts';
import { RUNTIME_FN, LOWERABLE } from './keyword-spec.ts';

/** Splits a comma list at TOP-LEVEL commas, skipping nested ()/[]/{}, strings, and templates. */
export function splitTopLevelCommas(code: string): string[]
{
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    let prevChar = '';
    let prevWord = '';
    while (i < code.length)
    {
        const ch = code[i];
        if (ch === '(' || ch === '[' || ch === '{')
        {
            depth++;
            i++;
            prevChar = ch;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}')
        {
            depth--;
            i++;
            prevChar = ch;
            continue;
        }
        if (ch === ',' && depth === 0)
        {
            parts.push(code.slice(start, i));
            i++;
            start = i;
            prevChar = ',';
            continue;
        }
        const s = step(code, i, prevChar, prevWord);
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
    }
    parts.push(code.slice(start));
    return parts.map(part => part.trim()).filter(part => part.length > 0);
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
 * Finds every reactive keyword construct at a statement position, at ANY nesting depth, in `code`.
 * Descends into bodies (the scan continues past just the keyword) so a keyword nested inside an effect
 * body or an arrow block is found too. Strings/templates/comments/regex are skipped via {@link step}.
 */
export function findConstructs(code: string): BodyItem[]
{
    const out: BodyItem[] = [];
    let i = 0;
    let prevChar = '';
    let prevWord = '';
    let atStmtStart = true;

    while (i < code.length)
    {
        if (atStmtStart)
        {
            const p = skipTrivia(code, i);
            if (p < code.length)
            {
                const c = tryParseConstruct(code, p, code.length);
                if (c !== null && LOWERABLE.has(c.kind))
                {
                    out.push(c);
                    // Descend past the keyword's first char so constructs nested in the body/initializer
                    // are found on later iterations (they get their own, non-overlapping edits); the
                    // construct itself won't re-match mid-identifier.
                    i = p + 1;
                    prevChar = '';
                    prevWord = '';
                    atStmtStart = false;
                    continue;
                }
            }
        }

        const s = step(code, i, prevChar, prevWord);
        if (s.kind === 'open')
        {
            // A `{` opens a block (or object) whose contents begin a new statement position.
            atStmtStart = s.text === '{';
        }
        else if (s.kind === 'close')
        {
            atStmtStart = s.text === '}';
        }
        else if (s.kind !== 'trivia')
        {
            atStmtStart = s.kind === 'punct' && s.text === ';';
        }
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
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
function wrapperEdits(code: string, w: WrapperBlock): Edit[]
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
function toMarkers(code: string): { code: string; hasKeywords: boolean; used: string[] }
{
    const constructs = findConstructs(code);
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
            edits.push(...wrapperEdits(code, c));
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
    const { code: markered, hasKeywords, used: directUsed } = toMarkers(code);
    if (!hasKeywords)
    {
        return { code: rewriteReactive(code, sources, offset), used: [] };
    }
    const stripped = stripMarkers(rewriteReactive(markered, sources, offset));
    return { code: stripped.code, used: [...directUsed, ...stripped.used] };
}
