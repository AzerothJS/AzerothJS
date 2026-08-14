/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The `style { ... }` section's compile-time half: the module's CSS, and the class-name map the
 * markup rewrite runs on.
 *
 * The section is what makes a `.azeroth` file a COMPOSITION format rather than three files in a
 * trench coat. It earns its syntax on one point: the compiler rewrites `.field-error` in the CSS
 * and `class="field-error"` in the markup to the same scoped name. That needs simultaneous
 * knowledge of both languages, which neither plain CSS nor plain TypeScript has.
 *
 * The scoping itself is NOT implemented here. It is `hashCss` + `scopeSelectors` from
 * azerothjs/semantics - byte-for-byte the functions the runtime `css` template calls - so the
 * name this module tells the markup to use is the name the stylesheet will actually define. The
 * emitted code passes the section's RAW text to `css()` and lets the runtime derive the same
 * scope again, rather than shipping pre-scoped text: one algorithm, one input, no way for the
 * two to disagree.
 *
 * @see {@link styleScopeOf} - the whole surface.
 */

import { hashCss, scopeSelectors } from 'azerothjs/semantics';

import type { Module, StyleSection } from './ast.ts';

/** A module's stylesheet, resolved to the names its markup must use. */
export interface StyleScope
{
    /** The parsed section, for diagnostics and for the projection to skip. */
    section: StyleSection;

    /**
     * The section's CSS, trimmed. This exact text is hashed, emitted as the `css()` argument,
     * and re-scoped by the runtime - so trimming here and emitting the trimmed text keeps both
     * sides on one input.
     */
    css: string;

    /**
     * Base class name to scoped class name, for every `.class` the CSS defines. A class the
     * markup uses but the section never defines is ABSENT, and the rewrite leaves such names
     * alone - that is what keeps global stylesheets and utility frameworks working untouched.
     */
    classes: Record<string, string>;
}

/**
 * Resolves a module's style section, or null when it has none.
 *
 * The FIRST section wins. A module with two of them is rejected by `diagnoseModule` before any
 * emit, so codegen never has to answer which stylesheet a shared class name belongs to.
 *
 * @param source - The module source the section's spans index into.
 * @param module - The parsed module.
 * @returns The scope, or null when there is no section (or it is empty).
 * @example
 * ```ts
 * const source = 'style { .btn { color: red } }\ncomponent B { <b class="btn"/> }';
 * const scope = styleScopeOf(source, parseModule(source));
 *
 * scope?.classes.btn; // 'btn_<hash>'
 * ```
 */
export function styleScopeOf(source: string, module: Module): StyleScope | null
{
    for (const item of module.items)
    {
        if (item.kind !== 'style')
        {
            continue;
        }
        const css = source.slice(item.bodyStart, item.bodyEnd).trim();
        // An empty section is a no-op rather than a scope over nothing: registering it would
        // add an empty stylesheet to every collected document.
        if (css === '')
        {
            return null;
        }
        const classes: Record<string, string> = {};
        scopeSelectors(css, hashCss(css), classes);
        return { section: item, css, classes };
    }
    return null;
}
