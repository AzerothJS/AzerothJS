// ErrorBoundary wraps a child factory and swaps to a fallback when the child
// throws. It's sugar over `catchError` from @azerothjs/reactivity, catching
// both synchronous setup errors and errors thrown later by effects/memos
// created inside the child subtree.
//
// Contract:
//   - children() runs inside catchError. Anything that throws - directly or
//     from a descendant effect/memo on a re-run - swaps the displayed content
//     to fallback(error, reset).
//   - reset() clears the captured error and re-attempts children.
//   - The fallback is NOT wrapped in catchError. If the fallback itself
//     throws, the error propagates outside the boundary (to a parent
//     ErrorBoundary, or the page). This avoids loops where a broken fallback
//     keeps re-triggering the boundary.
//
// Swap pattern: same as Show / Switch / Dynamic / Routes - an invisible
// `display: contents` placeholder, one branch alive at a time, each branch
// owned by its own `createRoot` so effects and destroy hooks fire in the right
// order. Covered by the same leak-regression tests as the other branchers.
//
// The captured error is stored as `{ value } | null`, not `unknown | null`,
// because user code may `throw null` or `throw undefined`; without the
// wrapper, a captured `null` couldn't be distinguished from "no error". The
// wrapper makes that distinction explicit at zero runtime cost.

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import {
    createSignal,
    createEffect,
    createRoot,
    catchError,
    isStringMode,
    isHydrating,
    runInMode,
    serializeChild,
    wrapContentsAnchored,
    hydrationNode
} from '@azerothjs/reactivity';
import { createCoMarkers, appendToCo, clearCo } from './co-range.ts';

/**
 * Props for the `<ErrorBoundary>` component.
 */
export interface ErrorBoundaryProps
{
    /**
     * Renders the error UI. Receives the caught error and a
     * `reset` callback that, when invoked, clears the captured
     * error and re-renders children. Use `reset` to wire up
     * "Try again" buttons.
     */
    fallback: (error: unknown, reset: () => void) => HTMLElement;

    /**
     * The protected subtree. Re-evaluated every time the boundary
     * resets. Anything thrown synchronously here, or by any
     * effect/memo created here on a later run, is caught.
     */
    children: () => HTMLElement;
}

/**
 * Internal wrapper that lets us distinguish "no error" (`null`)
 * from "an error happened to be `null` or `undefined`" (`{ value:
 * null }` / `{ value: undefined }`).
 *
 * @internal
 */
interface ErrorState
{
    value: unknown;
}

/**
 * Catches errors thrown inside `children` and renders `fallback`
 * in their place.
 *
 * Synchronous errors during `children()`, plus errors from
 * effects/memos created inside the children subtree (even when
 * they fire on much later signal changes), all route to the
 * fallback. Async errors from data fetchers do NOT route here -
 * those are observable via `Resource.error()` and meant to be
 * handled at the call site.
 *
 * Without ErrorBoundary: a throw in a child effect/memo bubbles up and tears
 * down the surrounding subtree, so you catchError() by hand and swap the
 * displayed content yourself:
 *
 *     catchError(
 *         () => container.appendChild(Risky({})),
 *         (err) => container.appendChild(Fallback({ err }))
 *     );  // no reset() to retry, and you own the swap
 *
 * With ErrorBoundary: declare fallback + children; it catches, swaps the
 * branch, and hands the fallback a reset() to re-attempt children:
 *
 *     ErrorBoundary({
 *         fallback: (err, reset) =>
 *             h('button', { onClick: reset }, String(err)),  // built-in retry
 *         children: () => Risky({})
 *     });
 *
 * @param props - `{ fallback, children }`
 *
 * @returns An invisible (`display: contents`) container that
 *          holds either the children subtree or the fallback,
 *          swapping reactively as errors come and go.
 *
 * @example
 * ```ts
 * ErrorBoundary({
 *     fallback: (err, reset) => h('div', { class: 'error' },
 *         h('p', {}, `Something broke: ${ String(err) }`),
 *         h('button', { onClick: reset }, 'Try again')
 *     ),
 *     children: () => RiskyComponent({})
 * });
 * ```
 *
 * @example
 * ```ts
 * // Nested boundaries - the inner one catches first, outer is
 * // a safety net for things the inner can't render either.
 * ErrorBoundary({
 *     fallback: (err) => h('p', {}, 'Outer: ' + String(err)),
 *     children: () => ErrorBoundary({
 *         fallback: (err) => h('p', {}, 'Inner: ' + String(err)),
 *         children: () => MyComponent({})
 *     })
 * });
 * ```
 */
export function ErrorBoundary(props: ErrorBoundaryProps): HTMLElement
{
    // Server-side rendering: render children; if they throw synchronously,
    // fall back. A plain try/catch suffices on the server - there are no later
    // effect runs to route through catchError, and reset() is a no-op in
    // static HTML.
    if (isStringMode())
    {
        let inner: string;
        try
        {
            inner = serializeChild(props.children());
        }
        catch (err)
        {
            inner = serializeChild(props.fallback(err, () => undefined));
        }
        return wrapContentsAnchored('errorboundary', inner) as unknown as HTMLElement;
    }

    // Hydration: adopt the comment markers and rebuild the boundary's subtree
    // fresh in DOM mode, splicing it in where the server content was. The
    // error-effect machinery lives outside the renderer, so v1 recreates the
    // boundary's children rather than adopting them in place - a localized,
    // one-time rebuild of matching content.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const start = cursor.takeCoOpen();
            const { content, end } = cursor.takeCoBalanced();
            const parent = cursor.parent;

            const real = runInMode('dom', () => ErrorBoundary(props));
            parent.insertBefore(real, start);
            for (const node of content)
            {
                parent.removeChild(node);
            }
            parent.removeChild(start);
            parent.removeChild(end);
        }) as unknown as HTMLElement;
    }

    // No wrapper element: comment markers bracket the active branch so the
    // boundary works inside <table>/<select>/<ul>. See ./co-range.ts.
    const { fragment, target } = createCoMarkers('errorboundary');

    const [error, setError] = createSignal<ErrorState | null>(null);

    let branchDispose: DisposeFn | null = null;

    /**
     * Clears the captured error and re-mounts `children()`.
     *
     * Passed to the fallback so user code can present "Try again"
     * affordances. Calling reset when no error is captured is a
     * no-op (the signal already holds null).
     */
    function reset(): void
    {
        setError(null);
    }

    createEffect(() =>
    {
        // Tear the previous branch down before drawing the next.
        teardownBranch();

        const captured = error();

        if (captured === null)
        {
            // Render children. Errors route to setError, which re-runs this
            // effect - this time taking the fallback branch.
            createRoot((dispose) =>
            {
                branchDispose = dispose;
                catchError(
                    () =>
                    {
                        appendToCo(target, props.children());
                    },
                    (err) =>
                    {
                        // The set is allowed to be re-entrant
                        // here: it triggers our own subscriber
                        // synchronously, which tears the half-
                        // constructed children down (nothing was
                        // appended to the container if the throw
                        // happened during construction) and
                        // mounts the fallback. The repeated
                        // teardownBranch on the next re-run is a
                        // benign no-op.
                        setError({ value: err });
                    }
                );
            });
        }
        else
        {
            // Render fallback. NOT wrapped in catchError - see the file
            // header for the rationale (avoid loops).
            createRoot((dispose) =>
            {
                branchDispose = dispose;
                appendToCo(target, props.fallback(captured.value, reset));
            });
        }

        return teardownBranch;
    });

    function teardownBranch(): void
    {
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }

        // Remove the branch's nodes one by one (so Portal's MutationObserver
        // can detect their removal) and run destroy hooks on each. clearCo
        // never touches the markers themselves.
        clearCo(target);
    }

    return fragment as unknown as HTMLElement;
}
