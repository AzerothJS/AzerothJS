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
 *     camelCase (onClick).
 *
 * Rules walk the parsed element tree of each top-level markup region. Warnings carry source spans, so
 * the Vite plugin can print file:line:col (and any tooling can squiggle them).
 *
 * @see {@link lintSource} - lint a whole module
 * @see {@link lintMarkup} - lint one parsed region
 */

import type { MarkupElement, MarkupFragment, MarkupChild } from './types.ts';
import { findMarkupStart } from './scanner.ts';
import { parseMarkup } from './markup-parser.ts';

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
export function lintMarkup(node: MarkupElement | MarkupFragment): LintWarning[]
{
    const warnings: LintWarning[] = [];
    visit(node, warnings);
    return warnings;
}

/** @internal */
function visit(node: MarkupElement | MarkupFragment | MarkupChild, warnings: LintWarning[]): void
{
    if (node.kind === 'element')
    {
        lintElement(node, warnings);
    }
    if (node.kind === 'element' || node.kind === 'fragment')
    {
        for (const child of node.children)
        {
            visit(child, warnings);
        }
    }
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
            const camel = `on${ name[2].toUpperCase() }${ name.slice(3) }`;
            warnings.push({
                code: 'azeroth/event-case',
                message: `\`${ name }\` - AzerothJS event handlers are camelCase: use \`${ camel }\`.`,
                start: attr.start,
                end: attr.end
            });
        }
    }
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
export function lintSource(source: string): LintWarning[]
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
            warnings.push(...lintMarkup(node));
            i = end;
        }
        catch
        {
            break;
        }
    }
    return warnings;
}
