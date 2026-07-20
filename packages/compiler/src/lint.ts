/**
 * MODULE: compiler/lint - markup lint
 *
 * Catches the SYNTAX-level slips in a markup region that neither the TYPE system nor the
 * component-semantic diagnostics catch. (A handler that runs at setup - onClick={save()} - is
 * diagnoseModule's azeroth/handler-not-function, so it is NOT duplicated here.) These rules have
 * near-zero false-positive rates:
 *   - azeroth/duplicate-attr - the same attribute written twice on one element (the later one
 *     silently wins);
 *   - azeroth/event-case - onclick= for a known DOM event, where the framework convention is
 *     camelCase (onClick);
 *   - azeroth/interpolation-spacing - spacing inside markup expression braces ({ expr }, not
 *     {expr}). The braces are markup punctuation, invisible to any TypeScript-based rule (the
 *     projection lowers them away), so this is the ONLY layer that can enforce it - the
 *     eslint-plugin and the editors both surface it from here;
 *   - azeroth/unsafe-narrow-in-show - `guard()!.x` inside a `<Show when={ guard() }>` whose
 *     children are NOT the narrowed-accessor callback form. `guard()` here is a second,
 *     independent read of the same nullable value `when` already checked - it can observe
 *     null even while the branch is mounted (a signal change between the two reads, an async
 *     race), and TypeScript's `!` is erased at compile time, so it gives no runtime
 *     protection. `<Show>`'s callback-children form (`{ (value) => ... }`) exists precisely
 *     for this: the accessor it hands back is backed by a signal Show only ever updates while
 *     truthy, so it cannot yield null while the branch is mounted - not "usually doesn't,"
 *     structurally cannot.
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
import { isFunctionLiteral } from './markup-util.ts';

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
}

/**
 * DOM events users actually write handlers for. The lowercase-event rule
 * only fires for these, so an unconventional attribute that merely starts
 * with "on" (onward-link, ...) is never flagged.
 */
const KNOWN_EVENTS = new Set([
    'click', 'dblclick', 'contextmenu',
    'input', 'change', 'submit', 'reset', 'invalid',
    'keydown', 'keyup', 'keypress',
    'focus', 'blur', 'focusin', 'focusout',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
    'pointerdown', 'pointerup', 'pointermove', 'pointerenter', 'pointerleave', 'pointercancel',
    'touchstart', 'touchend', 'touchmove', 'touchcancel',
    'wheel', 'scroll',
    'drag', 'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop',
    'load', 'error', 'abort',
    'animationstart', 'animationend', 'animationiteration', 'transitionend',
    'play', 'pause', 'ended', 'canplay', 'timeupdate', 'volumechange'
]);

/**
 * Lints one parsed markup region. Pure and allocation-light - safe to call per region on every
 * diagnostics/transform pass.
 *
 * @param node - The parsed markup element or fragment to lint.
 * @returns The lint warnings found in this region (empty when clean).
 * @see {@link lintSource}
 * @example
 * ```ts
 * const { node } = parseMarkup('<input onclick={f} />', 0);
 * lintMarkup(node)[0].code; // 'azeroth/event-case'
 * ```
 */
export function lintMarkup(node: MarkupElement | MarkupFragment, source?: string, options?: LintOptions): LintWarning[]
{
    const warnings: LintWarning[] = [];
    const spacing = options?.interpolationSpacing ?? 'always';
    visit(node, warnings, source, spacing);
    return warnings;
}

/** @internal */
function visit(
    node: MarkupElement | MarkupFragment | MarkupChild,
    warnings: LintWarning[],
    source: string | undefined,
    spacing: 'always' | 'never' | 'off'
): void
{
    if (node.kind === 'element')
    {
        lintElement(node, warnings);
        if (node.tag === 'Show')
        {
            lintShowNarrowing(node, warnings);
        }
        if (source !== undefined && spacing !== 'off')
        {
            for (const attr of node.attributes)
            {
                lintAttributeSpacing(attr, source, spacing, warnings);
            }
        }
    }
    if (node.kind === 'expression' && source !== undefined && spacing !== 'off')
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

/** @internal */
function lintElement(el: MarkupElement, warnings: LintWarning[]): void
{
    const seen = new Set<string>();

    for (const attr of el.attributes)
    {
        if (attr.spread || attr.name === null)
        {
            continue;
        }
        const name = attr.name;

        if (seen.has(name))
        {
            warnings.push({
                code: 'azeroth/duplicate-attr',
                message: `Duplicate attribute \`${ name }\` - the later value silently wins; remove one.`,
                start: attr.start,
                end: attr.end
            });
        }
        seen.add(name);

        // onclick= on a host element: works at runtime, but the convention
        // (and all editor tooling) is camelCase.
        if (!el.isComponent && name.startsWith('on') && KNOWN_EVENTS.has(name.slice(2)))
        {
            const camel = `on${ (name[2] ?? '').toUpperCase() }${ name.slice(3) }`;
            warnings.push({
                code: 'azeroth/event-case',
                message: `\`${ name }\` - AzerothJS event handlers are camelCase: use \`${ camel }\`.`,
                start: attr.start,
                end: attr.end
            });
        }
    }
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
 * True when `children` is already the narrowed-accessor callback form (`{ (value) => ... }`) -
 * a single expression child whose code is a function literal. That form is exactly the fix
 * {@link lintShowNarrowing} would otherwise suggest, so it is left alone.
 * @internal
 */
function isNarrowedCallbackForm(children: MarkupChild[]): boolean
{
    const meaningful = children.filter((child) => child.kind !== 'text' || child.value.trim() !== '');
    const only = meaningful.length === 1 ? meaningful[0] : undefined;
    return only !== undefined && only.kind === 'expression' && isFunctionLiteral(only.code.trim());
}

/**
 * azeroth/unsafe-narrow-in-show: flags `guard()!.x` inside a `<Show when={ guard() }>` whose
 * children are plain (not the callback form) - see the module doc comment for why this is a
 * real bug pattern, not a style nit. Reports the whole offending attribute/expression span,
 * matching {@link lintElement}'s other rules (no `source` dependency, no auto-fix: rewriting
 * the branch into the callback form is a structural change, not a mechanical one).
 * @internal
 */
function lintShowNarrowing(el: MarkupElement, warnings: LintWarning[]): void
{
    const whenAttr = el.attributes.find((attr) => attr.name === 'when' && attr.value.kind === 'expression');
    if (whenAttr === undefined || whenAttr.value.kind !== 'expression' || isNarrowedCallbackForm(el.children))
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
            + 'at compile time so it gives no runtime protection. Use the callback form instead: '
            + `<Show when={ ${ guarded } }>{ (value) => ... }</Show>, and read through \`value()\` instead `
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
 * lintSource('const x = <button onclick={f}>go</button>;')[0].code;
 * // 'azeroth/event-case'
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
