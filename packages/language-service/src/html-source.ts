// Produces a *virtual HTML document* for the markup in a `.azeroth` file, so the
// HTML language service (the engine behind VS Code's HTML support) can answer
// tag/attribute/value completion and MDN-backed hover for host elements.
//
// The trick that keeps it cheap: the virtual document is the same length as the
// source, with every non-markup character replaced by a space (newlines kept).
// So a caret offset in the `.azeroth` file is the *same* offset in the HTML
// document - no second mapping layer is needed. Markup is copied verbatim;
// inside `{ ... }` holes and attribute expressions the JavaScript is blanked
// (its braces kept), except for any markup nested in a hole, which is restored
// so `{cond && <p class="x"/>}` still gets HTML intelligence on the `<p>`.
//
// Reuses the compiler's scanner (findMarkupStart) and parser (parseMarkup); a
// half-typed tail is copied verbatim so completion keeps working mid-edit.

import { findMarkupStart } from '@azerothjs/compiler';
import { parseMarkup } from '@azerothjs/compiler';
import type { MarkupElement, MarkupFragment } from '@azerothjs/compiler';

/**
 * Builds the embedded HTML view of `source`: markup preserved at its original
 * offsets, everything else turned into whitespace.
 *
 * @example
 * ```ts
 * generateHtmlSource('const x = <a href="/">hi</a>;');
 * //                  '          <a href="/">hi</a> '
 * ```
 */
export function generateHtmlSource(source: string): string
{
    const chars = new Array<string>(source.length);
    for (let k = 0; k < source.length; k++)
    {
        const c = source[k];
        chars[k] = c === '\n' || c === '\r' ? c : ' ';
    }

    const copyVerbatim = (a: number, b: number): void =>
    {
        for (let k = a; k < b && k < source.length; k++)
        {
            const c = source[k];
            if (c !== '\n' && c !== '\r')
            {
                chars[k] = c ?? ' ';
            }
        }
    };

    const blank = (a: number, b: number): void =>
    {
        for (let k = a; k < b && k < source.length; k++)
        {
            const c = source[k];
            if (c !== '\n' && c !== '\r')
            {
                chars[k] = ' ';
            }
        }
    };

    const copyRegions = (lo: number, hi: number): void =>
    {
        let i = lo;
        for (;;)
        {
            const s = findMarkupStart(source, i);
            if (s === -1 || s >= hi)
            {
                return;
            }
            let node: MarkupElement | MarkupFragment;
            let end: number;
            try
            {
                ({ node, end } = parseMarkup(source, s));
            }
            catch
            {
                // Half-typed tail: copy it so the HTML service still sees the
                // partial tag and offers completions while the author types.
                copyVerbatim(s, hi);
                return;
            }
            copyVerbatim(node.start, node.end);
            blankHoles(node);
            i = end;
        }
    };

    const blankHoles = (node: MarkupElement | MarkupFragment): void =>
    {
        if (node.kind === 'element')
        {
            for (const attr of node.attributes)
            {
                const open = source.indexOf('{', attr.start);
                const close = attr.end - 1;
                if (open === -1 || close <= open)
                {
                    continue;
                }
                if (attr.spread)
                {
                    // `{...rest}` has no attribute name; drop it entirely so it
                    // doesn't break the surrounding tag's attribute parsing.
                    blank(open, close + 1);
                }
                else if (attr.value.kind === 'expression')
                {
                    // Turn `name={expr}` into `name="   "`: a clean quoted value
                    // keeps the HTML scanner's attribute boundaries intact, so
                    // hover/completion still work on neighbouring attributes.
                    chars[open] = '"';
                    chars[close] = '"';
                    blank(open + 1, close);
                }
            }
        }
        for (const child of node.children)
        {
            if (child.kind === 'expression')
            {
                blank(child.start + 1, child.end - 1);
                copyRegions(child.start + 1, child.end - 1);
            }
            else if (child.kind === 'element' || child.kind === 'fragment')
            {
                blankHoles(child);
            }
        }
    };

    copyRegions(0, source.length);
    return chars.join('');
}
