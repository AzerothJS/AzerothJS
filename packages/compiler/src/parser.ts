/**
 * MODULE: compiler/parser - the component-pipeline parser
 *
 * Splits a `.azeroth` source into opaque JS/TS regions and `component` declarations, and parses each
 * component body into items - state/derived declarations, effect blocks, the markup output, and opaque
 * statement runs.
 *
 * Everything is driven by ONE low-level routine, `step`, which advances past a single structural unit
 * (trivia, a string/template/regex/number literal, an identifier, a whole markup region, a bracket, or
 * any other punctuator) and reports its class. The module split, the markup-aware block delimiter, the
 * statement-terminator scan, and the body walker are all thin loops over `step`, so the
 * non-code-skipping rules live in exactly one place.
 *
 * The non-obvious correctness point is MARKUP. A component body interleaves JS and markup, so naive
 * brace/`;` scanning breaks on markup text like `<p>it's me</p>` (the `'` would start a JS string and
 * run past the brace). `step` consumes whole markup regions via the markup parser, so an apostrophe in
 * markup text is just text and the brace/terminator counters stay honest.
 *
 * Inner JS/TS is NOT parsed here - it is left as SPANS for the semantic pass to hand to TypeScript.
 *
 * KNOWN LIMITATIONS (refined later):
 *   - Components are recognized by the shape `component <Identifier>` optionally followed by a
 *     `<TypeParams>` list and a `(<param>)` signature; a leading `export`/`export default` stays in the
 *     preceding opaque region.
 *   - Reactive declarations are recognized only at the body's top level and must be `;`-terminated
 *     (no ASI); `effect` must be brace-delimited.
 *   - A `<` that opens neither valid markup nor a generic arrow is treated as an operator.
 *
 * @see {@link parseModule} - the parse entry point
 * @see {@link Module} - the parsed-module shape (from ast.ts)
 */

import type { Module, ModuleItem, ComponentDecl, BodyItem } from './ast.ts';

import {
    isWhitespace,
    isIdentStart,
    isIdentPart,
    isExpressionPosition,
    skipString,
    skipTemplate,
    skipLineComment,
    skipBlockComment,
    skipRegex,
    skipBalanced,
    scanTypeParams
} from './scanner.ts';
import { parseMarkup, CompileError } from './markup-parser.ts';

/** The class of a single structural unit produced by {@link step}. */
export type StepKind = 'trivia' | 'literal' | 'identifier' | 'markup' | 'open' | 'close' | 'punct';

/** The result of advancing past one structural unit. */
export interface Step
{
    /** Index just past the unit. */
    next: number;
    /** Updated "previous significant char" (unchanged for trivia). */
    prevChar: string;
    /** Updated "previous significant word" (unchanged for trivia). */
    prevWord: string;
    kind: StepKind;
    /** For identifier: the word. For open/close/punct: the single char. */
    text: string;
}

/**
 * Advances past exactly one structural unit starting at `i`, using the previous
 * significant token (`prevChar`/`prevWord`) to disambiguate `/` (regex vs
 * divide) and `<` (markup vs operator). Whole markup regions are consumed via
 * the markup parser; a `<` that fails to parse as markup is returned as a
 * punctuator.
 *
 * @internal
 */
export function step(source: string, i: number, prevChar: string, prevWord: string): Step
{
    const ch = source[i];

    // Trivia (transparent: prev* unchanged).
    if (isWhitespace(ch))
    {
        let j = i + 1;
        while (j < source.length && isWhitespace(source[j]))
        {
            j++;
        }
        return { next: j, prevChar, prevWord, kind: 'trivia', text: '' };
    }
    if (ch === '/' && source[i + 1] === '/')
    {
        return { next: skipLineComment(source, i), prevChar, prevWord, kind: 'trivia', text: '' };
    }
    if (ch === '/' && source[i + 1] === '*')
    {
        return { next: skipBlockComment(source, i), prevChar, prevWord, kind: 'trivia', text: '' };
    }

    // Literals (operands).
    if (ch === '"' || ch === '\'')
    {
        return { next: skipString(source, i), prevChar: ch, prevWord: '', kind: 'literal', text: '' };
    }
    if (ch === '`')
    {
        return { next: skipTemplate(source, i), prevChar: '`', prevWord: '', kind: 'literal', text: '' };
    }
    if (ch === '/' && isExpressionPosition(prevChar, prevWord))
    {
        return { next: skipRegex(source, i), prevChar: '/', prevWord: '', kind: 'literal', text: '' };
    }
    if (ch >= '0' && ch <= '9')
    {
        let j = i + 1;
        while (j < source.length && (isIdentPart(source[j]) || source[j] === '.'))
        {
            j++;
        }
        return { next: j, prevChar: '0', prevWord: '', kind: 'literal', text: '' };
    }

    // Markup region (consumed whole) when a `<` opens a tag/fragment in expression position. A `}`
    // also qualifies: in a component body, markup legitimately follows a brace-delimited block
    // (`effect { ... } <p/>`), and `}<Tag` is never a meaningful less-than. This
    // matters for brace counting - if such markup is NOT consumed whole, its `</tag>` close is
    // mis-scanned as a regex (`<` operator, then `/.../`) that swallows the component's closing brace.
    // A failed parse (e.g. a generic arrow) falls through. `isTagOrFragmentStart` gates the next char.
    if (ch === '<' && (isExpressionPosition(prevChar, prevWord) || prevChar === '}') && isTagOrFragmentStart(source[i + 1]))
    {
        const end = tryConsumeMarkup(source, i);
        if (end !== -1)
        {
            return { next: end, prevChar: '>', prevWord: '', kind: 'markup', text: '' };
        }
    }

    // Identifier (operand).
    if (isIdentStart(ch))
    {
        let j = i + 1;
        while (j < source.length && isIdentPart(source[j]))
        {
            j++;
        }
        const word = source.slice(i, j);
        return { next: j, prevChar: source[j - 1], prevWord: word, kind: 'identifier', text: word };
    }

    // Brackets.
    if (ch === '{' || ch === '(' || ch === '[')
    {
        return { next: i + 1, prevChar: ch, prevWord: '', kind: 'open', text: ch };
    }
    if (ch === '}' || ch === ')' || ch === ']')
    {
        return { next: i + 1, prevChar: ch, prevWord: '', kind: 'close', text: ch };
    }

    // Any other single operator/structural character.
    return { next: i + 1, prevChar: ch, prevWord: '', kind: 'punct', text: ch };
}

/**
 * parseModule
 *
 * PURPOSE:
 * Parses a `.azeroth` source into its module-level structure: opaque regions and `component`
 * declarations, each with its parsed body items.
 *
 * WHY IT EXISTS:
 * It is the front of the component pipeline - the step that finds the components and carves the body
 * into the items analyze/lower/codegen consume, while passing ordinary TS/JS through as opaque spans.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, parsing stage; the first call in generateModule (and diagnoseModule), feeding
 * analyzeComponent and lowerComponent.
 *
 * INPUT CONTRACT:
 * - source: the `.azeroth` module text.
 *
 * OUTPUT CONTRACT:
 * - A {@link Module} whose items TILE the whole source (every byte is in exactly one opaque region or
 *   component). Inner JS/TS is left as spans, not parsed.
 *
 * WHY THIS DESIGN:
 * It is TOTAL and allocation-light and NEVER throws - malformed input still yields a module (with the
 * troublesome stretch as an opaque region), so the build/tooling degrades gracefully rather than
 * aborting. The single `step` routine consuming whole markup regions is what keeps brace/terminator
 * scanning correct across interleaved JS and markup.
 *
 * WHEN TO USE:
 * The start of any component-pipeline operation (compile, diagnose).
 *
 * WHEN NOT TO USE:
 * Parsing a lone markup region (use {@link parseMarkup}); parsing expression interiors (left to
 * TypeScript via ts-slice).
 *
 * EDGE CASES:
 * - `export`/`export default` before `component` stays in the preceding opaque region (a known limit).
 * - `component Foo<T> {` (type params) is not yet recognized as a component.
 * - A `<` that is neither valid markup nor a generic arrow is treated as an operator.
 *
 * PERFORMANCE NOTES:
 * A single pass over the source via `step`; inner JS/TS is not parsed here.
 *
 * DEVELOPER WARNING:
 * Because it never throws, a parse problem surfaces as an OPAQUE region rather than an error - don't
 * treat "no component found" as proof the source is component-free; it can mean the shape wasn't
 * recognized (see Known Limitations in the module header).
 *
 * @param source - The `.azeroth` module source
 * @returns The {@link Module}; module-level items tile the whole source.
 * @see {@link parseMarkup}
 * @see {@link Module}
 *
 * @example
 * ```ts
 * const m = parseModule('component A { state n = 0; <p>{n}</p> }');
 * (m.items[0] as { body: { kind: string }[] }).body.map(b => b.kind);
 * // ['state', 'markup']
 * ```
 */
export function parseModule(source: string): Module
{
    const items: ModuleItem[] = [];
    let opaqueStart = 0;
    let depth = 0;
    let prevChar = '';
    let prevWord = '';
    let i = 0;

    const flushOpaque = (end: number): void =>
    {
        if (end > opaqueStart)
        {
            items.push({ kind: 'opaque', start: opaqueStart, end });
        }
    };

    while (i < source.length)
    {
        const s = step(source, i, prevChar, prevWord);

        if (s.kind === 'identifier' && depth === 0 && s.text === 'component')
        {
            const component = tryParseComponent(source, i, s.next);
            if (component !== null)
            {
                flushOpaque(i);
                items.push(component);
                i = component.end;
                opaqueStart = i;
                prevChar = '}';
                prevWord = '';
                continue;
            }
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

    flushOpaque(source.length);
    return { kind: 'module', items, start: 0, end: source.length };
}

/**
 * Reads a component declaration whose `component` keyword spans
 * `[keywordStart, keywordEnd)`. Returns the node (with its parsed body) when
 * the keyword is followed by `<Identifier> {`, else null.
 *
 * @internal
 */
function tryParseComponent(source: string, keywordStart: number, keywordEnd: number): ComponentDecl | null
{
    const k = skipTrivia(source, keywordEnd);
    if (k >= source.length || !isIdentStart(source[k]))
    {
        return null;
    }

    let n = k + 1;
    while (n < source.length && isIdentPart(source[n]))
    {
        n++;
    }

    // Function-style signature: `component Name<TypeParams>(<param>) { ... }`. Both parts are optional -
    // the bare `component Name { ... }` form (a prop-less component) still works.
    let cursor = skipTrivia(source, n);

    let typeParams: { start: number; end: number } | null = null;
    if (source[cursor] === '<')
    {
        const tpEnd = scanTypeParams(source, cursor);
        if (tpEnd === -1)
        {
            return null;
        }
        typeParams = { start: cursor, end: tpEnd };
        cursor = skipTrivia(source, tpEnd);
    }

    // The parameter is captured as a single VERBATIM span (the trimmed text between `(` and `)`). It is
    // ordinary TypeScript - a named param `props: T`, a destructuring pattern `{ a, b = d }: T`, or either
    // with an inline object type - so it is left for the semantic pass to hand to TypeScript (see
    // `parseComponentParam`) rather than split with hand-rolled rules here. Empty parens `()` carry no
    // parameter, so propsParam stays null.
    let propsParam: { start: number; end: number } | null = null;
    if (source[cursor] === '(')
    {
        const close = skipBalanced(source, cursor); // index just past the matching `)`
        let ps = cursor + 1;
        let pe = close - 1;
        while (ps < pe && isWhitespace(source[ps]))
        {
            ps++;
        }
        while (pe > ps && isWhitespace(source[pe - 1]))
        {
            pe--;
        }
        if (pe > ps)
        {
            propsParam = { start: ps, end: pe };
        }
        cursor = skipTrivia(source, close);
    }

    const brace = cursor;
    if (source[brace] !== '{')
    {
        return null;
    }

    const end = blockEnd(source, brace);
    const bodyStart = brace + 1;
    const bodyEnd = end - 1;
    return {
        kind: 'component',
        name: source.slice(k, n),
        nameStart: k,
        nameEnd: n,
        typeParams,
        propsParam,
        bodyStart,
        bodyEnd,
        body: parseComponentBody(source, bodyStart, bodyEnd),
        start: keywordStart,
        end
    };
}

/**
 * Parses the interior of a component body `[bodyStart, bodyEnd)` into body
 * items. Reactive declarations, effects, and the props block are recognized at
 * the body's top level (depth 0) at statement start; markup regions become the
 * output; everything else accumulates into opaque statement runs.
 *
 * @internal
 */
function parseComponentBody(source: string, bodyStart: number, bodyEnd: number): BodyItem[]
{
    const items: BodyItem[] = [];
    let i = bodyStart;
    let depth = 0;
    let prevChar = '';
    let prevWord = '';
    let atStmtStart = true;
    let opaqueStart = bodyStart;

    const flushOpaque = (end: number): void =>
    {
        let s = opaqueStart;
        let e = end;
        while (s < e && isWhitespace(source[s]))
        {
            s++;
        }
        while (e > s && isWhitespace(source[e - 1]))
        {
            e--;
        }
        if (e > s)
        {
            items.push({ kind: 'opaque-statements', start: s, end: e });
        }
    };

    while (i < bodyEnd)
    {
        if (atStmtStart && depth === 0)
        {
            const p = skipTrivia(source, i);
            if (p < bodyEnd)
            {
                const construct = tryParseConstruct(source, p, bodyEnd);
                if (construct !== null)
                {
                    flushOpaque(p);
                    items.push(construct);
                    i = construct.end;
                    opaqueStart = i;
                    atStmtStart = true;
                    prevChar = '}';
                    prevWord = '';
                    continue;
                }
            }
        }

        const s = step(source, i, prevChar, prevWord);
        if (s.kind === 'open')
        {
            depth++;
            atStmtStart = false;
        }
        else if (s.kind === 'close')
        {
            depth--;
            atStmtStart = depth === 0 && s.text === '}';
        }
        else if (s.kind === 'trivia')
        {
            // Transparent: statement-start state carries across whitespace/comments.
        }
        else
        {
            // A top-level `;` ends a statement; any other significant token is
            // mid-statement.
            atStmtStart = s.kind === 'punct' && s.text === ';' && depth === 0;
        }
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
    }

    flushOpaque(bodyEnd);
    return items;
}

/**
 * Scans for an optional `with { ... }` options clause between `from` and `limit` (a single statement's
 * span). Returns the value end (trimmed, just before `with`) and the options-object `{ ... }` span
 * (braces included), or null when there is no clause. Strings/templates/comments and nested brackets
 * are skipped via {@link step}, so a `with` inside the value (e.g. in a string) is not mistaken for it.
 *
 * @internal
 */
function scanWithClause(source: string, from: number, limit: number): { valueEnd: number; optionsStart: number; optionsEnd: number } | null
{
    let i = from;
    let depth = 0;
    let prevChar = '';
    let prevWord = '';
    while (i < limit)
    {
        const s = step(source, i, prevChar, prevWord);
        if (depth === 0 && s.kind === 'identifier' && s.text === 'with')
        {
            const brace = skipTrivia(source, s.next);
            if (source[brace] === '{')
            {
                const end = blockEnd(source, brace);
                let valueEnd = i;
                while (valueEnd > from && isWhitespace(source[valueEnd - 1]))
                {
                    valueEnd--;
                }
                return { valueEnd, optionsStart: brace, optionsEnd: end };
            }
        }
        if (s.kind === 'open')
        {
            depth++;
        }
        else if (s.kind === 'close')
        {
            if (depth <= 0)
            {
                break;
            }
            depth--;
        }
        else if (depth === 0 && s.kind === 'punct' && s.text === ';')
        {
            break;
        }
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
    }
    return null;
}

/**
 * Recognizes a body construct beginning at `p` (already past leading trivia),
 * bounded by `limit` (the body end). Returns the item, or null when `p` does
 * not begin a recognized construct (it is then plain JS).
 *
 * @internal
 */
export function tryParseConstruct(source: string, p: number, limit: number): BodyItem | null
{
    const ch = source[p];

    // Markup output.
    if (ch === '<' && isTagOrFragmentStart(source[p + 1]))
    {
        try
        {
            const { node, end } = parseMarkup(source, p);
            if (end <= limit)
            {
                return { kind: 'markup', node, start: p, end };
            }
        }
        catch (e)
        {
            // Malformed markup the parser COMMITTED to is a hard, located error - never
            // silently degraded to opaque TS passthrough. An uncommitted failure is a generic
            // arrow (`<T,>(v) => v`), which legitimately falls through. (Angle-bracket casts are
            // disallowed, so `<Foo>bar` commits and a missing close is reported, not fallen through.)
            if (e instanceof CompileError && e.committed)
            {
                throw e;
            }
            // Not markup (e.g. a generic arrow); fall through to plain JS.
        }
        return null;
    }

    if (!isIdentStart(ch))
    {
        return null;
    }

    let j = p + 1;
    while (j < limit && isIdentPart(source[j]))
    {
        j++;
    }
    const word = source.slice(p, j);

    if (word === 'effect')
    {
        // Two forms share the `effect` keyword:
        //   effect [with { ... }] { body }                          -> auto-tracked createEffect
        //   effect (deps) [(values, prev)] [with { ... }] { body }  -> on([...], (values, prev) => { body }, opts?)
        // A `(` immediately after `effect` opens the explicit-dependency form (the `(deps)` list); otherwise
        // it is the auto-tracked form. `effect(call)` with no following block falls through to plain JS.
        let cursor = skipTrivia(source, j);

        if (source[cursor] === '(')
        {
            const depsClose = skipBalanced(source, cursor);
            const depsStart = cursor + 1;
            const depsEnd = depsClose - 1;
            cursor = skipTrivia(source, depsClose);

            // Optional `(values, prev)` callback-parameter list.
            let paramsStart: number | null = null;
            let paramsEnd: number | null = null;
            if (source[cursor] === '(')
            {
                const paramsClose = skipBalanced(source, cursor);
                paramsStart = cursor + 1;
                paramsEnd = paramsClose - 1;
                cursor = skipTrivia(source, paramsClose);
            }

            // Optional `with { ... }` options clause.
            let depsOptionsStart: number | null = null;
            let depsOptionsEnd: number | null = null;
            if (source.startsWith('with', cursor) && !isIdentPart(source[cursor + 4] ?? ''))
            {
                const brace = skipTrivia(source, cursor + 4);
                if (source[brace] === '{')
                {
                    depsOptionsStart = brace;
                    depsOptionsEnd = blockEnd(source, brace);
                    cursor = skipTrivia(source, depsOptionsEnd);
                }
            }

            if (source[cursor] !== '{')
            {
                return null;
            }
            const end = blockEnd(source, cursor);
            return { kind: 'watch', depsStart, depsEnd, paramsStart, paramsEnd, optionsStart: depsOptionsStart, optionsEnd: depsOptionsEnd, bodyStart: cursor + 1, bodyEnd: end - 1, start: p, end };
        }

        // Auto-tracked form; the optional `with { ... }` clause passes options (e.g. `name`) to createEffect.
        let optionsStart: number | null = null;
        let optionsEnd: number | null = null;
        if (source.startsWith('with', cursor) && !isIdentPart(source[cursor + 4] ?? ''))
        {
            const brace = skipTrivia(source, cursor + 4);
            if (source[brace] === '{')
            {
                optionsStart = brace;
                optionsEnd = blockEnd(source, brace);
                cursor = skipTrivia(source, optionsEnd);
            }
        }

        if (source[cursor] !== '{')
        {
            return null;
        }
        const end = blockEnd(source, cursor);
        return { kind: 'effect', optionsStart, optionsEnd, bodyStart: cursor + 1, bodyEnd: end - 1, start: p, end };
    }

    // Block-wrapper keywords: `<kw> { body }` -> `<fn>(() => { body })`.
    const wrapperFn = word === 'batch' ? 'batch'
        : word === 'untrack' ? 'untrack'
            : word === 'cleanup' ? 'onCleanup'
                : word === 'dispose' ? 'onRootDispose'
                    : null;
    if (wrapperFn !== null)
    {
        const brace = skipTrivia(source, j);
        if (source[brace] !== '{')
        {
            return null;
        }
        const end = blockEnd(source, brace);
        return { kind: 'wrapper', fn: wrapperFn, bodyStart: brace + 1, bodyEnd: end - 1, start: p, end };
    }

    // `state`/`derived`/`deferred` are reactive sources (read plain, rewritten to a getter call);
    // `resource`/`stream`/`store`/`selector` are factory declarations (read explicitly via `.data()` etc).
    // All seven share the same surface shape: `<keyword> <name> = <value> [with { ... }] ;`. A keyword
    // only starts a declaration when an identifier (the name) follows it; otherwise `store.foo()` or
    // `selector(x)` (a value named like a keyword) falls through unchanged.
    if (word === 'state' || word === 'derived' || word === 'deferred'
        || word === 'resource' || word === 'stream' || word === 'store' || word === 'selector'
        || word === 'form')
    {
        const nameAt = skipTrivia(source, j);
        if (nameAt >= limit || !isIdentStart(source[nameAt]))
        {
            return null;
        }
        let n = nameAt + 1;
        while (n < limit && isIdentPart(source[n]))
        {
            n++;
        }
        const name = source.slice(nameAt, n);
        // `form NAME[] = ...` is an ARRAY-form (a list of repeated sub-forms). The `[]` sits between the
        // name and `=`; detect it and resume scanning past it. The name span itself stays `nameAt..n`.
        let isArray = false;
        let afterName = n;
        if (word === 'form')
        {
            const bracket = skipTrivia(source, n);
            if (source[bracket] === '[')
            {
                const closeAt = skipTrivia(source, bracket + 1);
                if (source[closeAt] === ']')
                {
                    isArray = true;
                    afterName = closeAt + 1;
                }
            }
        }
        const end = statementEnd(source, afterName, limit);
        const withClause = scanWithClause(source, afterName, end);
        const valueEnd = withClause ? withClause.valueEnd : end;
        const optionsStart = withClause ? withClause.optionsStart : null;
        const optionsEnd = withClause ? withClause.optionsEnd : null;
        if (word === 'form')
        {
            return { kind: 'form', name, nameStart: nameAt, nameEnd: n, start: p, end, valueEnd, optionsStart, optionsEnd, isArray };
        }
        const kind = word as 'state' | 'derived' | 'deferred' | 'resource' | 'stream' | 'store' | 'selector';
        return { kind, name, nameStart: nameAt, nameEnd: n, start: p, end, valueEnd, optionsStart, optionsEnd };
    }

    return null;
}

/**
 * Given `open` at a `{`, returns the index just after the matching `}`, with
 * markup regions and JS non-code skipped (so a `'`/`{` inside markup text never
 * miscounts). Returns the source length when unbalanced.
 *
 * @internal
 */
function blockEnd(source: string, open: number): number
{
    let depth = 0;
    let prevChar = '';
    let prevWord = '';
    let i = open;

    while (i < source.length)
    {
        const s = step(source, i, prevChar, prevWord);
        if (s.kind === 'open')
        {
            depth++;
        }
        else if (s.kind === 'close')
        {
            depth--;
            if (depth === 0 && s.text === '}')
            {
                return s.next;
            }
        }
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
    }

    return i;
}

/**
 * Scans from `from` to the index just after the next top-level `;` (depth 0),
 * skipping nested brackets and markup. Returns `limit` when no terminator is
 * found (the declaration is then unterminated - a documented 1.0 limitation).
 *
 * @internal
 */
function statementEnd(source: string, from: number, limit: number): number
{
    let depth = 0;
    let prevChar = '';
    let prevWord = '';
    let i = from;

    while (i < limit)
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
        else if (s.kind === 'punct' && s.text === ';' && depth === 0)
        {
            return s.next;
        }
        i = s.next;
        prevChar = s.prevChar;
        prevWord = s.prevWord;
    }

    return limit;
}

/**
 * Tries to consume a markup region at `at`; returns its end, or -1 if not markup.
 * Re-throws a COMMITTED parse failure (genuinely malformed markup) so it surfaces as a
 * located error rather than being silently mis-scanned as opaque TS.
 */
function tryConsumeMarkup(source: string, at: number): number
{
    try
    {
        return parseMarkup(source, at).end;
    }
    catch (e)
    {
        if (e instanceof CompileError && e.committed)
        {
            throw e;
        }
        return -1;
    }
}

/** True for the char after `<` that could begin a tag (`Ident`) or fragment (`>`). */
function isTagOrFragmentStart(ch: string | undefined): boolean
{
    return ch === '>' || (ch !== undefined && isIdentStart(ch));
}

/** Skips whitespace and comments from `i`, returning the next significant index. */
export function skipTrivia(source: string, i: number): number
{
    for (;;)
    {
        while (i < source.length && isWhitespace(source[i]))
        {
            i++;
        }
        if (source[i] === '/' && source[i + 1] === '/')
        {
            i = skipLineComment(source, i);
            continue;
        }
        if (source[i] === '/' && source[i + 1] === '*')
        {
            i = skipBlockComment(source, i);
            continue;
        }
        break;
    }
    return i;
}
