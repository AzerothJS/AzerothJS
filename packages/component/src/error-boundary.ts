// ============================================================================
// AZEROTHJS — <ErrorBoundary>
// ============================================================================
//
// Wraps a child factory and swaps to a fallback when the child
// throws. Sugar on top of `catchError` from @azerothjs/reactivity:
// the boundary catches synchronous setup errors AND errors thrown
// later by effects/memos created inside the child subtree.
//
// CONTRACT:
//
//   ErrorBoundary({
//       fallback: (error, reset) => h(...),
//       children: () => MyChild({...})
//   });
//
//   - children() runs inside catchError. Anything that throws —
//     directly or from a descendant effect/memo on a re-run —
//     swaps the displayed content to fallback(error, reset).
//   - reset() clears the captured error and re-attempts children.
//   - The fallback is NOT wrapped in catchError. If the fallback
//     itself throws, the throw propagates to whatever is outside
//     the boundary (a parent ErrorBoundary, or the page). This
//     prevents pathological loops where a broken fallback keeps
//     re-triggering the boundary.
//
// SWAP PATTERN:
//
//   Same as Show / Switch / Dynamic / Routes. An invisible
//   `display: contents` placeholder, one branch alive at a time,
//   each branch owned by its own `createRoot` so its effects and
//   destroy hooks fire in the right order. Covered by the same
//   leak-regression machinery as the other branchers.
//
// WHY THE STATE IS WRAPPED:
//
//   We store the captured error as `{ value } | null`, not as
//   `unknown | null`. A user is allowed to `throw null` or `throw
//   undefined`; without the wrapper, `null` couldn't be told from
//   "no error captured". The wrapper makes the distinction
//   explicit at zero runtime cost.
//
// ============================================================================

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
    wrapContents,
    hydrationNode
} from '@azerothjs/reactivity';
import { destroyComponent } from './define-component.ts';

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
 * fallback. Async errors from data fetchers do NOT route here —
 * those are observable via `Resource.error()` and meant to be
 * handled at the call site.
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
 * // Nested boundaries — the inner one catches first, outer is
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
    // ── Server-side rendering ─────────────────────────────────
    // Render children; if they throw synchronously, fall back. A plain
    // try/catch suffices on the server — there are no later effect runs
    // to route through catchError, and reset() is a no-op in static HTML.
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
        return wrapContents('errorboundary', inner) as unknown as HTMLElement;
    }

    // ── Hydration ─────────────────────────────────────────────
    // Adopt the wrapper span, then rebuild the boundary's subtree fresh in
    // DOM mode and swap it in. (The error-effect machinery lives outside the
    // renderer, so v1 recreates the boundary's children rather than adopting
    // them in place — a localized, one-time rebuild of matching content.)
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const serverSpan = cursor.takeElement('span');
            const real = runInMode('dom', () => ErrorBoundary(props));
            serverSpan.parentNode?.replaceChild(real, serverSpan);
        }) as unknown as HTMLElement;
    }

    // Invisible container so the boundary doesn't disturb the
    // surrounding layout.
    const container = document.createElement('span');
    container.style.display = 'contents';

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
            // Render children. Errors are routed to setError —
            // which triggers this very effect to re-run, this
            // time taking the fallback branch.
            createRoot((dispose) =>
            {
                branchDispose = dispose;
                catchError(
                    () =>
                    {
                        container.appendChild(props.children());
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
            // Render fallback. NOT wrapped in catchError — see
            // the file header for the rationale (avoid loops).
            createRoot((dispose) =>
            {
                branchDispose = dispose;
                container.appendChild(props.fallback(captured.value, reset));
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

        // Remove children one by one so MutationObserver-based
        // primitives (Portal) can detect their removal, and run
        // destroy hooks on each element on the way out.
        while (container.firstChild)
        {
            const node = container.firstChild;
            container.removeChild(node);
            if (node instanceof HTMLElement)
            {
                destroyComponent(node);
            }
        }
    }

    return container as unknown as HTMLElement;
}
