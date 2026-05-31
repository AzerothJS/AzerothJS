// ============================================================================
// AZEROTHJS — <Link> Component
// ============================================================================
//
// A polished SPA link: behaves like a normal `<a>` for everything
// the user expects (right-click → "Copy link", middle-click →
// "Open in new tab", screen-reader announcement), and intercepts
// only the cases where intercepting is the obviously right thing
// to do.
//
// THE WHEN-TO-INTERCEPT TABLE:
//
//   Default click                        →  router.navigate(to)
//   Modifier (ctrl / meta / shift / alt) →  pass through
//   Middle-click  (event.button !== 0)   →  pass through
//   target other than `_self`            →  pass through
//   defaultPrevented from upstream       →  pass through
//   external URL (mailto:, https://, …)  →  pass through
//
// Skipping any of these is what every "ugh, this router broke
// ctrl-click" complaint is about. We get all of them right.
//
// ACCESSIBILITY:
//
//   The rendered element is a real `<a href="...">`, not a div
//   with an onclick. That's what gives us native keyboard focus,
//   right-click context menu, screen-reader semantics, and the
//   crawler-friendly destination URL.
//
//   When `activeClass` is set, we also toggle `aria-current="page"`
//   so assistive tech announces the current location correctly.
//
// ============================================================================

import { h } from '@azerothjs/renderer';
import type { Child } from '@azerothjs/renderer';
import type { NavigateTarget } from './types.ts';
import type { Router } from './router.ts';
import { EXTERNAL_URL } from './router.ts';

/**
 * Props for the `<Link>` component.
 *
 * Any extra keys are passed through to the underlying `<a>`
 * element — so `id`, `style`, `aria-label`, `data-*`, and any
 * other valid anchor attribute work transparently.
 */
export interface LinkProps
{
    /** Where to navigate. `string` is treated as a `fullPath`. */
    to: NavigateTarget;

    /** The router instance to drive. */
    router: Router;

    /** If `true`, replaces the current history entry instead of pushing. */
    replace?: boolean;

    /** If `true`, scrolls the window to top after navigating. Off by default. */
    scroll?: boolean;

    /** Anchor `target` attribute. Anything other than `_self` (or absent) skips interception. */
    target?: string;

    /**
     * Class to apply when this link's pathname matches the current
     * router location's pathname exactly. Toggling is reactive.
     *
     * When set, `aria-current="page"` is also toggled in lockstep.
     */
    activeClass?: string;

    /** Optional user click handler — runs BEFORE our interception logic. */
    onClick?: (event: MouseEvent) => void;

    /** Class string or reactive class getter passed to the `<a>`. */
    class?: string | (() => string);

    /** Children (text, elements, reactive getters, arrays — anything h() accepts). */
    children?: Child;

    /** Pass-through for any other anchor attribute the user wants to set. */
    [key: string]: unknown;
}

/**
 * Extracts the pathname portion of a `NavigateTarget`.
 *
 * Used for active-link comparison (`router.location().pathname`
 * vs. the link's pathname). We don't need to compare query or
 * hash for active matching — the URL bar shows them but the
 * "you are here" semantic is path-level.
 *
 * @internal
 */
function targetPathname(target: NavigateTarget): string
{
    if (typeof target !== 'string')
    {
        return target.pathname;
    }

    const searchAt = target.indexOf('?');
    const hashAt = target.indexOf('#');

    let stop = target.length;
    if (searchAt >= 0 && searchAt < stop)
    {
        stop = searchAt;
    }
    if (hashAt >= 0 && hashAt < stop)
    {
        stop = hashAt;
    }

    return target.slice(0, stop);
}

/**
 * A SPA-aware anchor element.
 *
 * Renders a real `<a href="...">` so all native browser
 * behaviour (right-click, middle-click, copy, screen-readers)
 * works. Intercepts only the click cases where the user clearly
 * wants in-app navigation.
 *
 * Pass `activeClass` to get reactive active-link styling and
 * `aria-current="page"` for accessibility.
 *
 * @example
 * ```ts
 * Link({
 *     to: '/users/42',
 *     router,
 *     activeClass: 'is-active',
 *     children: 'View User 42'
 * });
 * ```
 *
 * @example
 * ```ts
 * // Structured target — router will encode and stringify
 * Link({
 *     to: { pathname: '/search', query: { q: 'azeroth js' } },
 *     router,
 *     children: 'Search'
 * });
 * ```
 *
 * @example
 * ```ts
 * // External URL — Link does not intercept; behaves like a plain anchor
 * Link({ to: 'https://example.com', router, children: 'External' });
 * ```
 */
export function Link(props: LinkProps): HTMLElement
{
    // The href is computed once at construction. The link's `to`
    // prop is treated as static — users who need a reactive `to`
    // can wrap the link in a `<Show>` or rebuild it.
    //
    // router.href() applies the configured base prefix to internal
    // targets (and leaves external URLs untouched), so the rendered
    // anchor points at the real URL even when the app is served
    // under a sub-path.
    const href = props.router.href(props.to);
    const isExternal = EXTERNAL_URL.test(href);
    const linkPathname = targetPathname(props.to);

    /**
     * Click handler. Runs the user's onClick first (if any), then
     * applies the bail-out table from the file header. Only when
     * every condition says "yes, intercept" do we preventDefault
     * and route through the router.
     */
    function handleClick(event: MouseEvent): void
    {
        if (props.onClick)
        {
            props.onClick(event);
        }

        // The user's onClick may have called preventDefault()
        // because they want to suppress navigation entirely.
        if (event.defaultPrevented)
        {
            return;
        }

        // Not a primary-button click (middle-click, right-click).
        if (event.button !== 0)
        {
            return;
        }

        // Modifier keys → user wants new tab / new window / save.
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        {
            return;
        }

        // target="_blank" (or any non-`_self`) → user wants new tab.
        if (props.target && props.target !== '_self')
        {
            return;
        }

        // External URL → don't intercept, let the browser go.
        if (isExternal)
        {
            return;
        }

        event.preventDefault();

        if (props.replace)
        {
            props.router.replace(props.to, { scroll: props.scroll });
        }
        else
        {
            props.router.navigate(props.to, { scroll: props.scroll });
        }
    }

    // ── Active-state bindings (only when activeClass is set) ──
    //
    // Both class and aria-current become reactive getters so h()
    // wires them up as effects. Without activeClass we leave the
    // user's class as-is (could be a string, a getter, or
    // undefined — h() handles all three).
    const userClass = props.class;

    const classProp =
        props.activeClass === undefined
            ? userClass
            : (): string =>
            {
                const base =
                    typeof userClass === 'function'
                        ? userClass()
                        : (userClass ?? '');

                const isActive = props.router.location().pathname === linkPathname;

                if (!isActive)
                {
                    return String(base);
                }
                return base.length > 0 ? `${ base } ${ props.activeClass }` : props.activeClass!;
            };

    const ariaCurrentProp =
        props.activeClass === undefined
            ? undefined
            : (): string | null =>
                props.router.location().pathname === linkPathname ? 'page' : null;

    // ── Pass-through for unknown attrs ───────────────────────
    //
    // Pull our own props out so we don't leak them onto the
    // <a> element. Anything else (id, style, aria-label, data-*)
    // flows through.
    const {
        to: _to,
        router: _router,
        replace: _replace,
        scroll: _scroll,
        target: _target,
        activeClass: _activeClass,
        onClick: _onClick,
        class: _class,
        children: _children,
        ...rest
    } = props;

    const linkAttrs: Record<string, unknown> =
    {
        ...rest,
        href,
        onClick: handleClick,
        class: classProp
    };

    if (props.target !== undefined)
    {
        linkAttrs.target = props.target;
    }
    if (ariaCurrentProp !== undefined)
    {
        linkAttrs['aria-current'] = ariaCurrentProp;
    }

    return h('a', linkAttrs, props.children as Child);
}
