/**
 * MODULE: compiler/lint - markup lint
 *
 * Catches the SYNTAX-level slips in a markup region that neither the TYPE system nor the
 * component-semantic diagnostics catch. (A handler that runs at setup - onClick={save()} - is
 * diagnoseModule's azeroth/handler-not-function; duplicate attributes and lowercase on* names
 * are diagnoseModule's error-severity GRAMMAR 6.6 rules - none of those are duplicated here.)
 * These rules have near-zero false-positive rates:
 *   - azeroth/interpolation-spacing - spacing inside markup expression braces ({ expr }, not
 *     {expr}). The braces are markup punctuation, invisible to any TypeScript-based rule (the
 *     projection lowers them away), so this is the ONLY layer that can enforce it - the
 *     eslint-plugin and the editors both surface it from here;
 *   - azeroth/unsafe-narrow-in-show - `guard()!.x` inside a `<Show when={ guard() }>` that
 *     does NOT declare a binding name. `guard()` here is a second, independent read of the
 *     same nullable value `when` already checked - it can observe null even while the branch
 *     is mounted (a signal change between the two reads, an async race), and TypeScript's `!`
 *     is erased at compile time, so it gives no runtime protection. `let={ value }` exists
 *     precisely for this: the name is bound to the value Show checked and only updates while
 *     that stays truthy, so it cannot yield null while the branch is mounted - not "usually
 *     doesn't," structurally cannot.
 *
 * Rules walk the parsed element tree of each top-level markup region. Warnings carry source spans, so
 * the Vite plugin can print file:line:col (and any tooling can squiggle them). A warning MAY carry a
 * machine-applicable {@link LintFix} in ORIGINAL source coordinates - the eslint-plugin forwards it so
 * `eslint --fix` rewrites the `.azeroth` source directly.
 *
 * @see {@link lintSource} - lint a whole module
 * @see {@link lintMarkup} - lint one parsed region
 */

import type { MarkupElement, MarkupFragment, MarkupChild, MarkupAttribute } from './types.ts';
import { findMarkupStart } from './scanner.ts';
import { parseMarkup } from './markup-parser.ts';
import { isBindingAttr } from 'azerothjs/semantics';

/** A machine-applicable fix: replace `[start, end)` of the ORIGINAL source with `text`. */
export interface LintFix
{
    range: [number, number];
    text: string;
}

/** One lint finding. Warning severity - lint never fails a build. */
export interface LintWarning
{
    /** Stable rule id, e.g. 'azeroth/event-case'. */
    code: string;

    /** Human-readable message with the suggested fix. */
    message: string;

    /** Source span of the offending attribute/element. */
    start: number;
    end: number;

    /** Present when the finding is mechanically fixable (original-source coordinates). */
    fix?: LintFix;
}

/** Options for the style-level rules (structural rules are always on). */
export interface LintOptions
{
    /**
     * Spacing inside markup expression braces: 'always' wants `{ expr }`, 'never' wants `{expr}`,
     * 'off' disables the rule. Default 'always'. A side whose whitespace contains a newline is
     * always accepted (multiline expressions indent freely). Spreads (`{...props}`) are exempt -
     * the ecosystem convention keeps them tight.
     */
    interpolationSpacing?: 'always' | 'never' | 'off';

    /**
     * Spaces per nesting level for markup TAGS. `0` (the default) disables the rule.
     *
     * This is the markup counterpart of ESLint's `indent`, which cannot do the job: the
     * eslint-plugin lints the PROJECTION, whose whitespace the compiler re-flows, so an
     * indent report there would point at a column the author never wrote. This rule reads
     * the original source, so its positions and its fix are the author's own text.
     */
    markupIndent?: number;
}

/**
 * Lints one parsed markup region. Pure and allocation-light - safe to call per region on every
 * diagnostics/transform pass.
 *
 * @param node - The parsed markup element or fragment to lint.
 * @returns The lint warnings found in this region (empty when clean).
 * @see {@link lintSource}
 * @example
 * ```ts
 * const { node } = parseMarkup('<p>{count()}</p>', 0);
 * lintMarkup(node, source)[0].code; // 'azeroth/interpolation-spacing'
 * ```
 */
export function lintMarkup(node: MarkupElement | MarkupFragment, source: string, options?: LintOptions): LintWarning[]
{
    const warnings: LintWarning[] = [];
    const spacing = options?.interpolationSpacing ?? 'always';
    visit(node, warnings, source, spacing);
    const step = options?.markupIndent ?? 0;
    if (step > 0)
    {
        lintIndent(node, source, step, warnings);
    }
    return warnings;
}

/** @internal The column of `offset` when it is the first non-whitespace on its line; -1 otherwise. */
function ownLineColumn(source: string, offset: number): number
{
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    for (let i = lineStart; i < offset; i += 1)
    {
        const ch = source[i];
        if (ch !== ' ' && ch !== '\t')
        {
            return -1;
        }
    }
    return offset - lineStart;
}

/** @internal Reports `offset`'s line if it opens one and sits at the wrong column. */
function checkColumn(source: string, offset: number, expected: number, warnings: LintWarning[]): void
{
    const column = ownLineColumn(source, offset);
    if (column < 0 || column === expected)
    {
        return;
    }
    warnings.push({
        code: 'azeroth/markup-indent',
        message: `Expected an indent of ${ expected } spaces, found ${ column }.`,
        start: offset - column,
        end: offset,
        fix: { range: [offset - column, offset], text: ' '.repeat(expected) }
    });
}

/**
 * Checks that every tag which OPENS a line sits at `depth * step` past the region's root.
 *
 * An element is judged as a WHOLE - its opening tag, each attribute that starts a line, the
 * `>` that closes a multi-line opening tag, and its closing tag. Moving the opening tag alone
 * is how an indentation autofix leaves a file worse than it found it.
 *
 * Deliberately narrow otherwise, because this rewrites whitespace the author owns:
 *
 * - only lines a tag OPENS are judged - `<b>a</b><i>b</i>` on one line is an authoring
 *   choice, not an indentation error;
 * - expression holes are skipped ENTIRELY, children and all. Their contents are TypeScript,
 *   the projection re-flows them, and the interpolation rule already lets multiline holes
 *   indent freely;
 * - text is skipped. Reflowing prose is a formatter's job and a lossy one;
 * - the baseline is the root tag's own column, so a component indented four spaces inside a
 *   function body is measured relative to itself rather than to column zero.
 *
 * @internal
 */
function lintIndent(root: MarkupElement | MarkupFragment, source: string, step: number, warnings: LintWarning[]): void
{
    const base = ownLineColumn(source, root.start);
    if (base < 0)
    {
        // The root shares its line with code (`return <div>...`); there is no baseline to
        // measure the children against, so the whole region is left alone.
        return;
    }

    const walk = (node: MarkupChild | MarkupElement | MarkupFragment, column: number, depth: number): void =>
    {
        if (node.kind === 'expression' || node.kind === 'text')
        {
            return;
        }

        if (node.kind === 'element')
        {
            for (const attribute of node.attributes)
            {
                checkColumn(source, attribute.start, column + step, warnings);
            }
            // A tag whose attributes wrapped ends on its own line; that `>` belongs under the
            // tag it closes, not under the attributes it follows.
            const openEnd = source.lastIndexOf('>', node.children[0]?.start ?? node.end);
            if (openEnd > node.start && node.attributes.length > 0)
            {
                checkColumn(source, openEnd, column, warnings);
            }
        }

        for (const child of node.children)
        {
            const childColumn = base + (depth + 1) * step;
            if (child.kind === 'element' || child.kind === 'fragment')
            {
                checkColumn(source, child.start, childColumn, warnings);
            }
            walk(child, childColumn, depth + 1);
        }

        // `</tag>` / `</>` - back at the opening tag's column.
        if (!source.startsWith('/>', node.end - 2))
        {
            const closeStart = source.lastIndexOf('</', node.end);
            if (closeStart > node.start)
            {
                checkColumn(source, closeStart, column, warnings);
            }
        }
    };

    walk(root, base, 0);
}

/** @internal */
function visit(
    node: MarkupElement | MarkupFragment | MarkupChild,
    warnings: LintWarning[],
    source: string,
    spacing: 'always' | 'never' | 'off'
): void
{
    if (node.kind === 'element')
    {
        if (node.tag === 'Show')
        {
            lintShowNarrowing(node, warnings);
        }
        if (spacing !== 'off')
        {
            for (const attr of node.attributes)
            {
                lintAttributeSpacing(attr, source, spacing, warnings);
            }
        }
    }
    if (node.kind === 'expression' && spacing !== 'off')
    {
        // A child hole's span covers `{...}`; the inner text sits between the braces.
        lintBraceSpacing(node.start + 1, node.end - 1, source, spacing, warnings);
    }
    if (node.kind === 'element' || node.kind === 'fragment')
    {
        for (const child of node.children)
        {
            visit(child, warnings, source, spacing);
        }
    }
}

/**
 * Locates the braces of an expression attribute value (`name={ ... }`) and checks their spacing.
 * Spreads are exempt; static and bare attributes have no braces. The parser guarantees the value's
 * opening `{` is the first non-whitespace character after `=` and that the attribute span ends
 * exactly at the closing `}`.
 * @internal
 */
function lintAttributeSpacing(
    attr: MarkupAttribute,
    source: string,
    spacing: 'always' | 'never',
    warnings: LintWarning[]
): void
{
    if (attr.spread || attr.name === null || attr.value.kind !== 'expression')
    {
        return;
    }
    const equals = source.indexOf('=', attr.start + attr.name.length);
    if (equals === -1 || equals >= attr.end)
    {
        return;
    }
    const brace = source.indexOf('{', equals);
    if (brace === -1 || brace >= attr.end)
    {
        return;
    }
    lintBraceSpacing(brace + 1, attr.end - 1, source, spacing, warnings);
}

/**
 * The interpolation-spacing check for one brace pair, given the offsets of its INNER region
 * (`{` at innerStart-1, `}` at innerEnd). A side whose whitespace contains a newline passes in
 * both modes (multiline expressions lay out freely); an all-whitespace inner region is skipped
 * (nothing to space). The fix rewrites only the inner region, preserving the expression verbatim.
 * @internal
 */
function lintBraceSpacing(
    innerStart: number,
    innerEnd: number,
    source: string,
    spacing: 'always' | 'never',
    warnings: LintWarning[]
): void
{
    const inner = source.slice(innerStart, innerEnd);
    const expression = inner.trim();
    // Nothing to space; and spread syntax stays tight ({...props}) wherever it appears - the
    // attribute path never reaches here for spreads, but a child-position `{...list}` parses as a
    // plain expression hole, so the exemption must live at the brace level.
    if (expression === '' || expression.startsWith('...'))
    {
        return;
    }
    const leading = inner.slice(0, inner.length - inner.trimStart().length);
    const trailing = inner.slice(inner.trimEnd().length);

    const sideOk = (ws: string): boolean =>
        (ws.includes('\n') || (spacing === 'always' ? ws === ' ' : ws === ''));

    if (sideOk(leading) && sideOk(trailing))
    {
        return;
    }
    const pad = spacing === 'always' ? ' ' : '';
    const fixedLeading = leading.includes('\n') ? leading : pad;
    const fixedTrailing = trailing.includes('\n') ? trailing : pad;
    warnings.push({
        code: 'azeroth/interpolation-spacing',
        message: spacing === 'always'
            ? 'Expected exactly one space inside the braces of a markup expression - write `{ expression }`.'
            : 'Unexpected space inside the braces of a markup expression - write `{expression}`.',
        start: innerStart - 1,
        end: innerEnd + 1,
        fix: { range: [innerStart, innerEnd], text: fixedLeading + expression + fixedTrailing }
    });
}

/** True for identifier characters (`[\w$]`), false for `undefined` (past the string's start). @internal */
function isIdentChar(ch: string | undefined): boolean
{
    return ch !== undefined && /[\w$]/.test(ch);
}

/** True for identifier-START characters (`[A-Za-z_$]`, no leading digit), false for `undefined`. @internal */
function isIdentStart(ch: string | undefined): boolean
{
    return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

/**
 * The last zero-argument call chain in a `when` expression - the value a `<Show>` is actually
 * guarding (`config()` in `config()`, `configs.lastReport()` in `done ? configs.lastReport() :
 * null`). `null` when `when` has no such call (a plain boolean, a comparison with no guarded
 * object): nothing to check.
 *
 * Deliberately NOT `/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\(\s*\)/` run over the whole
 * string: a self-repeating group with a flexible run of whitespace on each side is a textbook
 * polynomial-regex shape, AND (independent of that) any unanchored `.match(/…/g)` whose pattern
 * can consume a long prefix before failing costs O(n) per start position it's retried at - O(n^2)
 * together on adversarial input (a large `.azeroth` source is exactly "uncontrolled data" here:
 * it can arrive from an untrusted PR built in CI, or a file opened in an editor). Finding every
 * `()` first via a trivially-safe fixed-bracket pattern, then walking backward from the LAST one
 * a plain character at a time, is linear regardless of the input's shape.
 * @internal
 */
function extractGuardedCall(whenCode: string): string | null
{
    const parenRe = /\(\s*\)/g;
    let openParenIndex = -1;
    let callEnd = -1;
    let m: RegExpExecArray | null;

    while ((m = parenRe.exec(whenCode)) !== null)
    {
        openParenIndex = m.index;
        callEnd = m.index + m[0].length; // end of this call's closing `)`
    }
    if (openParenIndex === -1)
    {
        return null;
    }

    let cursor = openParenIndex;
    let chainStart = cursor;

    for (;;)
    {
        let segmentStart = cursor;

        while (segmentStart > 0 && isIdentChar(whenCode[segmentStart - 1]))
        {
            segmentStart--;
        }
        if (segmentStart === cursor || !isIdentStart(whenCode[segmentStart]))
        {
            break; // no identifier segment immediately before the cursor - stop
        }
        chainStart = segmentStart;
        cursor = segmentStart;

        if (cursor > 0 && whenCode[cursor - 1] === '.')
        {
            cursor--;
            chainStart = cursor;
            continue; // a `.` extends the chain - look for another segment before it
        }
        break;
    }

    // Includes the call's own `(...)` - the returned text is matched verbatim as a
    // needle (`${guarded}!.`) against descendant code, so it must read as a call.
    return chainStart === openParenIndex ? null : whenCode.slice(chainStart, callEnd);
}

/**
 * True when the element already declares a binding name (`let={ value }`) - the form
 * {@link lintShowNarrowing} recommends, so there is nothing left to warn about. The bound
 * name is a plain non-null value, which is exactly what makes the second `guard()!` read
 * unnecessary.
 * @internal
 */
function isNarrowedBindingForm(el: MarkupElement): boolean
{
    return el.attributes.some((attr) => attr.name !== null && !attr.spread && isBindingAttr(el.tag, attr.name));
}

/**
 * azeroth/unsafe-narrow-in-show: flags `guard()!.x` inside a `<Show when={ guard() }>` whose
 * children are plain (not the callback form) - see the module doc comment for why this is a
 * real bug pattern, not a style nit. Reports the whole offending attribute/expression span
 * (no `source` dependency, no auto-fix: rewriting the branch into the callback form is a
 * structural change, not a mechanical one).
 * @internal
 */
function lintShowNarrowing(el: MarkupElement, warnings: LintWarning[]): void
{
    const whenAttr = el.attributes.find((attr) => attr.name === 'when' && attr.value.kind === 'expression');
    if (whenAttr === undefined || whenAttr.value.kind !== 'expression' || isNarrowedBindingForm(el))
    {
        return;
    }
    const guarded = extractGuardedCall(whenAttr.value.code);
    if (guarded === null)
    {
        return;
    }
    scanForUnsafeNarrowing(el.children, guarded, warnings);
}

/** @internal */
function scanForUnsafeNarrowing(children: MarkupChild[], guarded: string, warnings: LintWarning[]): void
{
    const needle = `${ guarded }!.`;
    for (const child of children)
    {
        if (child.kind === 'expression' && child.code.includes(needle))
        {
            warnings.push(unsafeNarrowWarning(guarded, child.start, child.end));
        }
        if (child.kind === 'element')
        {
            for (const attr of child.attributes)
            {
                if (!attr.spread && attr.value.kind === 'expression' && attr.value.code.includes(needle))
                {
                    warnings.push(unsafeNarrowWarning(guarded, attr.start, attr.end));
                }
            }
            scanForUnsafeNarrowing(child.children, guarded, warnings);
        }
        if (child.kind === 'fragment')
        {
            scanForUnsafeNarrowing(child.children, guarded, warnings);
        }
    }
}

/** @internal */
function unsafeNarrowWarning(guarded: string, start: number, end: number): LintWarning
{
    return {
        code: 'azeroth/unsafe-narrow-in-show',
        message: `\`${ guarded }!\` re-reads the value this <Show>'s \`when\` already checked - a second, `
            + 'independent read that can observe null even while the branch is mounted, and `!` is erased '
            + 'at compile time so it gives no runtime protection. Declare the checked value instead: '
            + `<Show when={ ${ guarded } } let={ value }>...</Show>, and read \`value\` bare instead `
            + `of \`${ guarded }!\`.`,
        start,
        end
    };
}

/**
 * lintSource
 *
 * PURPOSE:
 * Lints every parseable top-level markup region in a module and returns all findings.
 *
 * WHY IT EXISTS:
 * It is the build-time lint entry the Vite plugin runs before compiling, so syntax slips (duplicate
 * attributes, lowercase event names) surface as warnings where they reliably reach every contributor.
 *
 * COMPILER / RUNTIME ROLE:
 * Build-time, compiler; called by the Vite plugin's transform, and usable by any tooling.
 *
 * INPUT CONTRACT:
 * - source: the module text (JS/TS that may embed markup regions).
 *
 * OUTPUT CONTRACT:
 * - A {@link LintWarning}[] aggregated across regions, each with a stable `code`, a `message`, and a
 *   source span.
 *
 * WHY THIS DESIGN:
 * It scans for markup starts and lints each region, but SKIPS unparseable ones - a half-typed markup's
 * parse error is reported elsewhere (a CompileError diagnostic), and shouldn't also spray lint noise.
 * Spans let callers map findings to file:line:col.
 *
 * WHEN TO USE:
 * Linting a whole `.azeroth`/JS module.
 *
 * WHEN NOT TO USE:
 * A single already-parsed region - use {@link lintMarkup}.
 *
 * EDGE CASES:
 * - The scan stops at the first region that fails to parse (the rest is assumed mid-edit).
 * - Clean source returns an empty array.
 *
 * PERFORMANCE NOTES:
 * A linear scan; pure and allocation-light.
 *
 * DEVELOPER WARNING:
 * Lint is WARNING-only - it never fails a build. Don't rely on it to block bad markup; use it to
 * surface conventions.
 *
 * @param source - The module source to lint.
 * @returns All lint warnings found, across every parseable markup region.
 * @see {@link lintMarkup}
 *
 * @example
 * ```ts
 * lintSource('const x = <button label={f}>go</button>;')[0].code;
 * // 'azeroth/interpolation-spacing'
 * ```
 */
export function lintSource(source: string, options?: LintOptions): LintWarning[]
{
    const warnings: LintWarning[] = [];
    let i = 0;
    for (;;)
    {
        const start = findMarkupStart(source, i);
        if (start === -1)
        {
            break;
        }
        try
        {
            const { node, end } = parseMarkup(source, start);
            warnings.push(...lintMarkup(node, source, options));
            i = end;
        }
        catch
        {
            break;
        }
    }
    return warnings;
}
