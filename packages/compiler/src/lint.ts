// Markup lint: the reactivity and correctness mistakes the TYPE system
// cannot see. Typed component props already catch the classic foot-guns
// (`when={visible}` where visible isn't a getter is a plain type error), so
// these rules target syntax-level slips with near-zero false-positive
// rates:
//
//   azeroth/handler-call    onClick={save()} - calls save() at setup and
//                           passes its RESULT as the handler. Only fires on
//                           ZERO-argument calls of a plain reference;
//                           onClick={makeHandler(id)} is a legitimate
//                           factory idiom and stays silent.
//   azeroth/duplicate-attr  the same attribute written twice on one element
//                           (the later one silently wins).
//   azeroth/event-case      onclick= for a known DOM event - the framework
//                           convention is camelCase (onClick), and the
//                           editor tooling only models the camelCase form.
//
// Rules walk the parsed element tree of each top-level markup region.
// Warnings carry source spans, so the language service can squiggle them
// and the Vite plugin can print file:line:col.

import type { MarkupElement, MarkupFragment, MarkupChild } from './types.ts';
import { findMarkupStart } from './scanner.ts';
import { parseMarkup } from './parser.ts';

/** One lint finding. Warning severity - lint never fails a build. */
export interface LintWarning
{
    /** Stable rule id, e.g. 'azeroth/handler-call'. */
    code: string;

    /** Human-readable message with the suggested fix. */
    message: string;

    /** Source span of the offending attribute/element. */
    start: number;
    end: number;
}

/** A zero-argument call of a bare reference: `save()`, `actions.reset()`. */
const ZERO_ARG_CALL = /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(\s*\)$/;

/** `on` + uppercase: the framework's event-handler convention. */
const CAMEL_EVENT = /^on[A-Z]/;

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
 * Lints one parsed markup region. Pure and allocation-light - the language
 * service calls this per region on every diagnostics pass.
 *
 * @example
 * ```ts
 * const { node } = parseMarkup('<button onClick={save()}>go</button>', 0);
 * lintMarkup(node)[0].code; // 'azeroth/handler-call'
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
                message: `Duplicate attribute "${ name }" - the later one silently wins.`,
                start: attr.start,
                end: attr.end
            });
        }
        seen.add(name);

        // onClick={save()} - the call runs at setup; its RESULT becomes the
        // handler. Zero-argument calls of a bare reference are flagged;
        // calls WITH arguments are the handler-factory idiom and stay quiet.
        if (CAMEL_EVENT.test(name) && attr.value.kind === 'expression' && ZERO_ARG_CALL.test(attr.value.code.trim()))
        {
            const callee = attr.value.code.trim().replace(/\s*\(\s*\)$/, '');
            warnings.push({
                code: 'azeroth/handler-call',
                message: `${ name }={${ attr.value.code.trim() }} calls ${ callee }() during setup and passes its result as the handler. Use ${ name }={${ callee }} or ${ name }={() => ${ callee }()}.`,
                start: attr.start,
                end: attr.end
            });
        }

        // onclick= on a host element: works at runtime, but the convention
        // (and all editor tooling) is camelCase.
        if (!el.isComponent && name.startsWith('on') && KNOWN_EVENTS.has(name.slice(2)))
        {
            const camel = `on${ name[2].toUpperCase() }${ name.slice(3) }`;
            warnings.push({
                code: 'azeroth/event-case',
                message: `"${ name }" - AzerothJS event handlers are camelCase: use ${ camel }.`,
                start: attr.start,
                end: attr.end
            });
        }
    }
}

/**
 * Lints every parseable top-level markup region in a module. Unparseable
 * regions are skipped - the parse error itself is reported elsewhere
 * (CompileError diagnostics), and half-typed markup should not also spray
 * lint noise.
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
