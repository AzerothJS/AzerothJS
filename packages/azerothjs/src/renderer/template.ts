/**
 * MODULE: renderer/template (internal)
 *
 * tmpl() backs the compiler's `dom` target: a region's static structure is parsed ONCE into a
 * <template> and instantiated per use with cloneNode - one native clone instead of
 * createElement + per-element attribute wiring. Dynamic parts are bound into the clone
 * afterwards via bindProps/bindHole (see ./h). Client-only by design: SSR string mode has no
 * DOM to clone and hydration adopts existing nodes, so the compiler keeps those paths on the
 * universal h() output (the Vite plugin forces it for SSR transforms); reaching tmpl() in
 * either mode is a build misconfiguration, so it throws rather than render nothing.
 */

import { isStringMode, isHydrating } from '../reactivity/index.ts';
import { parseContainerFor } from './namespace.ts';

/** @internal The template root's tag name, or '' when the html does not start with one. */
function rootTagOf(html: string): string
{
    const match = /^\s*<([A-Za-z][^\s/>]*)/.exec(html);
    return match?.[1] ?? '';
}

/**
 * Interns an HTML string as a lazily-parsed template and returns the
 * instantiation function compiled `dom`-target code calls per use.
 *
 * @param html - The region's static structure, serialized by the compiler
 * @returns A function returning a fresh deep clone of the template content
 *
 * @example
 * ```ts
 * // What the compiler emits for <li class="row">{name()}</li>:
 * const _tmpl$1 = tmpl('<li class="row"><!--[--><!--]--></li>');
 * const _r = _tmpl$1();           // cloned <li>
 * bindHole(_r.firstChild!, () => name());  // _r.firstChild is the <!--[--> anchor
 * ```
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function tmpl(html: string): () => HTMLElement
{
    let template: HTMLTemplateElement | null = null;

    return (): HTMLElement =>
    {
        if (isStringMode() || isHydrating())
        {
            throw new Error(
                'tmpl() output is client-only. This module was compiled with target "dom"; ' +
                'SSR and hydrate() need the default (universal) compile target.'
            );
        }

        if (template === null)
        {
            template = document.createElement('template');
            // The HTML fragment parser only applies foreign-content rules once it has
            // entered <svg>/<math>, so a region whose ROOT is an SVG child (`<g>`, `<path>`
            // - what a For row or a nested region serializes to) would parse as an unknown
            // HTML element and never paint, while the same markup built through h() lands
            // in the SVG namespace. Parsing inside the container and unwrapping keeps the
            // two paths identical.
            const container = parseContainerFor(rootTagOf(html));
            template.innerHTML = container === null ? html : `<${ container }>${ html }</${ container }>`;
            if (container !== null)
            {
                const wrapper = template.content.firstChild as Element | null;
                template.content.replaceChildren(...(wrapper === null ? [] : Array.from(wrapper.childNodes)));
            }
        }

        const root = template.content.firstChild;
        if (root === null)
        {
            // Compiled templates always carry one root element; an empty one means
            // corrupted compiler output - fail with a message, not a TypeError.
            throw new Error('tmpl(): compiled template HTML produced no root node.');
        }
        return root.cloneNode(true) as HTMLElement;
    };
}
