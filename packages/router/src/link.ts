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

import { h } from '@azerothjs/renderer';
import type { Child } from '@azerothjs/renderer';
import type { NavigateTarget } from './types.ts';
import type { Router } from './router.ts';
import { EXTERNAL_URL } from './router.ts';

/**
 * Props for the `<Link>` component.
 *
 * Any extra keys are passed through to the underlying `<a>` element, so `id`,
 * `style`, `aria-label`, `data-*`, and any other valid anchor attribute work
 * transparently.
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
     * Class to apply when this link's pathname matches the current router
     * location's pathname exactly. Toggling is reactive. When set,
     * `aria-current="page"` is also toggled in lockstep.
     */
    activeClass?: string;

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
 * - to: a NavigateTarget (string fullPath or structured); treated as STATIC (computed once).
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
 * For a reactive destination (the `to` is read once - rebuild via {@link Show} for a changing
 * target). A purely external link can be a plain <a> (Link will pass it through anyway).
 *
 * EDGE CASES:
 * - Modifier/middle clicks, target!=_self, external URLs, and an upstream preventDefault all pass
 *   through untouched.
 * - Active matching is path-level (query and hash are ignored).
 *
 * PERFORMANCE NOTES:
 * href and pathname are computed once at construction; active bindings are effects only when
 * activeClass is set.
 *
 * DEVELOPER WARNING:
 * `to` is static - a changing target needs a rebuild. The user `onClick` runs BEFORE interception;
 * calling preventDefault() in it cancels navigation entirely.
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
    // The href is computed once at construction; the `to` prop is treated as
    // static. Users who need a reactive `to` can wrap the link in a `<Show>` or
    // rebuild it.
    //
    // router.href() applies the configured base prefix to internal targets (and
    // leaves external URLs untouched), so the rendered anchor points at the real
    // URL even when the app is served under a sub-path.
    const href = props.router.href(props.to);
    const isExternal = EXTERNAL_URL.test(href);
    const linkPathname = targetPathname(props.to);

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

    // Active-state bindings (only when activeClass is set): both class and
    // aria-current become reactive getters so h() wires them up as effects.
    // Without activeClass we leave the user's class as-is (string, getter, or
    // undefined; h() handles all three).
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
