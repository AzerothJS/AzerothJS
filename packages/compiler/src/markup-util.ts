/**
 * MODULE: compiler/markup-util - shared codegen string/markup utilities
 *
 * The small shared EMITTER helpers (codegen and the type projection consult them). Language
 * FACTS - the event namespace, content properties, factory props, builtins - live in
 * `azerothjs/semantics`, the one owner every backend imports; this module keeps only the
 * emission mechanics:
 *   - wrapDynamic   - the reactivity-shape heuristic (wrap a computed expression in a getter; leave a
 *                     bare getter / fn-literal / collection verbatim);
 *   - isFunctionLiteral / isBareReference / isCollectionLiteral - the expression-shape predicates the
 *                     reactive-wrapping heuristic is built from (shared by codegen, the IR lowerer, and
 *                     the type projection so all three classify `{expr}` identically);
 *   - quoteString   - string-literal quoting;
 *   - objectKey     - object-key quoting;
 *   - alreadyImports - whether a module already names-imports a symbol (used by both emitters before they
 *                     inject runtime imports);
 *   - walkComponentTags - walk a markup tree's component tags.
 *
 * All of these are compiler-internal EXCEPT {@link walkComponentTags}, which is re-exported from the
 * package index.
 */

import type {
    MarkupElement,
    MarkupFragment
} from './types.ts';

/**
 * True when `code` is an arrow/function literal - pass it through unwrapped.
 *
 * @example
 * ```ts
 * isFunctionLiteral('(item) => item.name'); // true
 * isFunctionLiteral('count() + 1');         // false
 * ```
 */
export function isFunctionLiteral(code: string): boolean
{
    const t = code.trim();
    if (/^async\s+function\b/.test(t) || /^function\b/.test(t))
    {
        return true;
    }
    // Arrow: `x => ...`, `(...) => ...`, `async x => ...`, `async (...) => ...`.
    return /^(async\s+)?(\([^]*?\)|[A-Za-z_$][\w$]*)\s*=>/.test(t);
}

/**
 * True when `code` is a single bare identifier or dotted path (e.g. `draft`, `props.x`).
 *
 * @example
 * ```ts
 * isBareReference('props.value'); // true
 * isBareReference('a + b');       // false
 * ```
 */
export function isBareReference(code: string): boolean
{
    return /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(code.trim());
}

/**
 * True when `code` is an array or object literal (`[...]` / `{...}`).
 *
 * @example
 * ```ts
 * isCollectionLiteral('[resource]'); // true
 * isCollectionLiteral('count()');    // false
 * ```
 */
export function isCollectionLiteral(code: string): boolean
{
    const t = code.trim();
    return t.startsWith('[') || t.startsWith('{');
}

/**
 * Decides how a dynamic `{expr}` is emitted. Passed through verbatim when it's
 * already the right shape for the runtime:
 *   - an event handler,
 *   - a function literal (handler / render fn / key fn),
 *   - a bare reference (a signal getter, a component, props.x),
 *   - an array/object literal (e.g. `on={[res]}`, a props bag).
 * Everything else is a computed value, wrapped in a getter so h() (and
 * reactive props like `when`/`each`) stay fine-grained.
 *
 * @example
 * ```ts
 * wrapDynamic('a + b', false);   // '() => (a + b)' (computed -> wrapped)
 * wrapDynamic('count', false);   // 'count' (bare reference -> verbatim)
 * wrapDynamic('save()', true);   // 'save()' (event handler -> verbatim)
 * ```
 */
export function wrapDynamic(code: string, isEventHandler: boolean): string
{
    const compiled = code.trim();
    if (
        isEventHandler ||
        isFunctionLiteral(compiled) ||
        isBareReference(compiled) ||
        isCollectionLiteral(compiled)
    )
    {
        return compiled;
    }
    return `() => (${ compiled })`;
}

/**
 * Escape for every character that cannot appear RAW inside an emitted single-quoted literal. The four
 * line terminators are the load-bearing ones: a raw CR reaches the emitter from `<style>`/`<script>`
 * CDATA, a static attribute value, a folded constant, and `&#13;`, and a CRLF checkout puts one in
 * front of every newline - unescaped, each terminates the literal and the emitted module is a syntax
 * error attributed to the author's markup.
 */
const LITERAL_ESCAPES: Readonly<Record<string, string>> =
{
    '\\': '\\\\',
    '\'': '\\\'',
    '\n': '\\n',
    '\r': '\\r',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029'
};

/**
 * Escapes a literal string for emission inside single quotes.
 *
 * @example
 * ```ts
 * quoteString('a\'b'); // "'a\\'b'" (the inner quote is escaped)
 * ```
 */
export function quoteString(value: string): string
{
    return `'${ value.replace(/[\\'\n\r\u2028\u2029]/g, ch => LITERAL_ESCAPES[ch] ?? ch) }'`;
}

/**
 * Quotes an object key when it isn't a valid bare identifier.
 *
 * @example
 * ```ts
 * objectKey('class');   // 'class' (bare identifier, unquoted)
 * objectKey('data-id'); // "'data-id'" (hyphen -> quoted)
 * ```
 */
export function objectKey(name: string): string
{
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${ name }'`;
}

/**
 * True when the module source already names-imports `name` (so an emitter must not re-declare it when
 * injecting runtime imports). Shared by the runtime codegen and the type projection.
 *
 * @example
 * ```ts
 * alreadyImports("import { h } from 'x'", 'h'); // true
 * alreadyImports("import { h } from 'x'", 'Show'); // false
 * ```
 */
export function alreadyImports(source: string, name: string): boolean
{
    return new RegExp(`import\\s*\\{[^}]*\\b${ name }\\b[^}]*\\}\\s*from`).test(source);
}

/**
 * Visits the markup element tree (NOT expression holes) and calls `visit` with the tag of every
 * component (capitalised/dotted) element. Use it to discover which components/built-ins a markup tree
 * references - e.g. to drive auto-import. Expression holes are handled by the caller's own recursion.
 *
 * @param node - The markup element or fragment to walk.
 * @param visit - Called once per component tag encountered (in source order).
 * @returns Nothing; results are delivered through `visit`.
 * @example
 * ```ts
 * const { node } = parseMarkup('<Show><p>hi</p></Show>', 0);
 * const tags: string[] = [];
 * walkComponentTags(node, (tag) => tags.push(tag));
 * tags; // ['Show'] (the lowercase <p> host element is skipped)
 * ```
 */
export function walkComponentTags(node: MarkupElement | MarkupFragment, visit: (tag: string) => void): void
{
    if (node.kind === 'element' && node.isComponent)
    {
        visit(node.tag);
    }
    for (const child of node.children)
    {
        if (child.kind === 'element' || child.kind === 'fragment')
        {
            walkComponentTags(child, visit);
        }
    }
}
