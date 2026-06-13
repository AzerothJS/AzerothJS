// tmpl() backs the compiler's `dom` target: a region's static structure is
// parsed ONCE into a <template> and instantiated per use with cloneNode -
// one native clone instead of createElement + attribute wiring per element.
// Dynamic parts are bound into the clone afterwards via bindProps/bindHole
// (see h.ts).
//
// Client-only by design: in SSR string mode there is no DOM to clone, and
// hydration adopts existing nodes instead of creating them. The compiler
// keeps those paths on the universal h() output (the Vite plugin forces it
// for SSR transforms); reaching here in either mode means a build
// misconfiguration, so fail loudly rather than render nothing.

import { isStringMode, isHydrating } from '@azerothjs/reactivity';

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
 * const _tmpl$1 = tmpl('<li class="row"><!--$--></li>');
 * const _r = _tmpl$1();           // cloned <li>
 * bindHole(_r.firstChild!, () => name());
 * ```
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
            template.innerHTML = html;
        }

        return template.content.firstChild!.cloneNode(true) as HTMLElement;
    };
}
