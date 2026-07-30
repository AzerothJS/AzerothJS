/**
 * MODULE: router/link
 *
 * <Link> is a SPA link that behaves like a normal <a> for everything the user expects
 * (right-click "Copy link", middle-click "Open in new tab", screen-reader announcement) and
 * intercepts ONLY the clicks where in-app navigation is clearly intended:
 *
 *   default primary click                 -> router.navigate(to)
 *   modifier (ctrl/meta/shift/alt)        -> pass through
 *   middle-click (event.button !== 0)     -> pass through
 *   target other than _self               -> pass through
 *   defaultPrevented upstream             -> pass through
 *   external URL (mailto:, https://, ...) -> pass through
 *
 * Handling that whole bail-out table is what avoids the usual "this router broke ctrl-click"
 * complaints.
 *
 * ACCESSIBILITY: the rendered element is a real <a href>, not a div+onclick, giving native
 * keyboard focus, the context menu, screen-reader semantics, and a crawlable destination URL.
 * With activeClass set, aria-current="page" toggles in lockstep so assistive tech announces the
 * current location correctly.
 */

import { h } from '../renderer/index.ts';
import type { Child } from '../renderer/index.ts';
import type { NavigateTarget } from './types.ts';
import { resolveRouter } from './provider.ts';
import type { Router } from './router.ts';
import { isExternalUrl } from './router.ts';

/**
 * Props for the `<Link>` component.
 *
 * Any extra keys are passed through to the underlying `<a>` element, so `id`,
 * `style`, `aria-label`, `data-*`, and any other valid anchor attribute work
 * transparently.
 */
export interface LinkProps
{
    /**
     * Where to navigate. `string` is treated as a `fullPath`. The FUNCTION form makes
     * the destination reactive: href, active state, and the click target all track it.
     */
    to: NavigateTarget | (() => NavigateTarget);

    /** The router instance to drive; omit inside a <RouterProvider> (or a <Routes> chain). */
    router?: Router;

    /** If `true`, replaces the current history entry instead of pushing. */
    replace?: boolean;

    /** If `true`, scrolls the window to top after navigating. Off by default. */
    scroll?: boolean;

    /** Anchor `target` attribute. Anything other than `_self` (or absent) skips interception. */
    target?: string;

    /**
     * Class to apply when this link is ACTIVE. Toggling is reactive; when set,
     * `aria-current="page"` toggles in lockstep. Active means the location
     * matches this link's pathname or any DESCENDANT of it (`/users` is active
     * at `/users/42` - the nav-menu behavior) unless `end` demands exactness.
     */
    activeClass?: string;

    /**
     * `true` = active only on the EXACT pathname (index links). Default: prefix
     * matching - except for `to="/"`, which would otherwise be active
     * everywhere and defaults to exact.
     */
    end?: boolean;

    /** Optional user click handler. Runs before the interception logic. */
    onClick?: (event: MouseEvent) => void;

    /** Class string or reactive class getter passed to the `<a>`. */
    class?: string | (() => string);

    /** Children (text, elements, reactive getters, arrays - anything h() accepts). */
    children?: Child;

    /** Pass-through for any other anchor attribute the user wants to set. */
    [key: string]: unknown;
}

/**
 * Extracts the pathname portion of a `NavigateTarget`.
 *
 * Used for active-link comparison (`router.location().pathname` vs. the link's
 * pathname). Query and hash are not compared for active matching: the URL bar
 * shows them, but the "you are here" semantic is path-level.
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
 * Link
 *
 * PURPOSE:
 * Renders a real `<a href>` that intercepts only plain in-app clicks and routes them through the
 * router, with optional reactive active-link styling and aria-current.
 *
 * WHY IT EXISTS:
 * A hand-rolled anchor that preventDefaults every click breaks ctrl-click, middle-click,
 * copy-link, external URLs, and accessibility. Link renders a true anchor and intercepts
 * surgically, so all the native affordances keep working while in-app navigation stays SPA-fast.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; a component over h('a'). The href is computed via router.href() (the configured
 * base prefix is applied to internal targets, external URLs left untouched).
 *
 * INPUT CONTRACT:
 * - to: a NavigateTarget (string fullPath or structured), or a FUNCTION of one for a reactive destination.
 * - router: the Router to drive.
 * - replace/scroll/target/activeClass/onClick/class/children, plus any other anchor attribute
 *   (id, style, aria-*, data-*) which passes through to the <a>.
 *
 * OUTPUT CONTRACT:
 * - An <a> element. Clicks that match the bail-out table pass through to the browser; otherwise
 *   navigation is intercepted (push, or replace when `replace`).
 *
 * WHY THIS DESIGN:
 * The click handler runs the user's onClick first (which may preventDefault to cancel), then the
 * bail-out table (modifier/middle/target/external) so the browser handles new-tab/copy/external.
 * activeClass and aria-current are wired as reactive getters so h() updates them on location
 * change; own props are stripped so only real anchor attributes reach the element.
 *
 * WHEN TO USE:
 * For in-app navigation links.
 *
 * WHEN NOT TO USE:
 * A purely external link can be a plain <a> (Link will pass it through anyway).
 *
 * EDGE CASES:
 * - Modifier/middle clicks, target!=_self, external URLs, and an upstream preventDefault all pass
 *   through untouched.
 * - Active matching is path-level (query and hash are ignored), prefix-by-default (`end` for exact).
 *
 * PERFORMANCE NOTES:
 * With a plain `to`, href is computed once; the function form adds one reactive attribute.
 * Active bindings are effects only when activeClass is set.
 *
 * DEVELOPER WARNING:
 * The user `onClick` runs BEFORE interception; calling preventDefault() in it cancels
 * navigation entirely.
 *
 * @param props - {@link LinkProps}: `to`, `router`, and optional styling/behavior + pass-through attrs.
 * @returns An <a> element wired for SPA navigation.
 * @see {@link createRouter}
 * @example
 * Link({ to: '/users/42', router, activeClass: 'is-active', children: 'View User 42' });
 * Link({ to: { pathname: '/search', query: { q: 'azeroth js' } }, router, children: 'Search' });
 */
export function Link(props: LinkProps): HTMLElement
{
    const router = resolveRouter(props.router, 'Link');

    // The function form of `to` makes the destination REACTIVE: href becomes a
    // reactive attribute, active matching tracks it, and clicks read it fresh.
    // The plain form stays a one-time computation (no effect cost).
    const reactiveTo = typeof props.to === 'function';
    const target = (): NavigateTarget => (typeof props.to === 'function' ? props.to() : props.to);

    // router.href() applies the configured base prefix to internal targets (and
    // leaves external URLs untouched), so the rendered anchor points at the real
    // URL even when the app is served under a sub-path.
    const href = reactiveTo ? (): string => router.href(target()) : router.href(target());
    const isExternal = (): boolean => isExternalUrl(typeof href === 'function' ? href() : href);
    const linkPathname = (): string => targetPathname(target());

    // Runs the user's onClick first (if any), then applies the bail-out table
    // from the file header. Only when every condition says intercept do we
    // preventDefault and route through the router.
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

        // Modifier keys: user wants new tab / new window / save.
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        {
            return;
        }

        // target="_blank" (or any non-_self): user wants a new tab.
        if (props.target && props.target !== '_self')
        {
            return;
        }

        // External URL: don't intercept, let the browser go.
        if (isExternal())
        {
            return;
        }

        event.preventDefault();

        if (props.replace)
        {
            router.replace(target(), { scroll: props.scroll });
        }
        else
        {
            router.navigate(target(), { scroll: props.scroll });
        }
    }

    // Active matching: exact, or prefix at a SEGMENT boundary (never '/use' for
    // '/users'). Trailing slashes normalize away so '/users/' and '/users' agree.
    function isActive(): boolean
    {
        const strip = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
        const current = strip(router.location().pathname);
        const link = strip(linkPathname());
        if (current === link)
        {
            return true;
        }
        const end = props.end ?? link === '/';
        return !end && current.startsWith(link === '/' ? '/' : link + '/');
    }

    // Active-state bindings (only when activeClass is set): both class and
    // aria-current become reactive getters so h() wires them up as effects.
    // Without activeClass we leave the user's class as-is (string, getter, or
    // undefined; h() handles all three).
    const userClass = props.class;
    // Const capture so the undefined-narrowing below survives into the getter closure.
    const activeClass = props.activeClass;

    const classProp =
        activeClass === undefined
            ? userClass
            : (): string =>
            {
                const base =
                    typeof userClass === 'function'
                        ? userClass()
                        : (userClass ?? '');

                if (!isActive())
                {
                    return base;
                }
                return base.length > 0 ? `${ base } ${ activeClass }` : activeClass;
            };

    const ariaCurrentProp =
        props.activeClass === undefined
            ? undefined
            : (): string | null => (isActive() ? 'page' : null);

    // Pass-through for unknown attrs: pull our own props out so we don't leak
    // them onto the <a> element. Anything else (id, style, aria-label, data-*)
    // flows through.
    const {
        to: _to,
        router: _router,
        replace: _replace,
        scroll: _scroll,
        target: _target,
        activeClass: _activeClass,
        end: _end,
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

    return h('a', linkAttrs, props.children);
}
