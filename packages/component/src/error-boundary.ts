/**
 * MODULE: component/error-boundary
 *
 * <ErrorBoundary> wraps a child factory and swaps to a fallback when the child throws - sugar
 * over catchError from @azerothjs/reactivity, catching BOTH synchronous setup errors and errors
 * thrown later by effects/memos created inside the child subtree.
 *
 * CONTRACT: children() runs inside catchError; anything that throws (directly or from a
 * descendant effect/memo on a re-run) swaps the displayed content to fallback(error, reset).
 * reset() clears the captured error and re-attempts children. The fallback is NOT wrapped in
 * catchError - if it throws, the error propagates OUTSIDE the boundary (to a parent boundary or
 * the page), avoiding loops where a broken fallback keeps re-triggering the boundary.
 *
 * The swap is the same co-range pattern as Show/Switch/Dynamic/Routes: a comment-marker range,
 * one branch alive at a time, each branch owned by its own createRoot so effects and destroy
 * hooks fire in order. The captured error is stored as `{ value } | null` (not `unknown | null`)
 * so a thrown null/undefined is distinguishable from "no error", at zero runtime cost.
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import type { MountNode } from './types.ts';
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
    fallback: (error: unknown, reset: () => void) => MountNode;

    /**
     * The protected subtree. Re-evaluated every time the boundary
     * resets. Anything thrown synchronously here, or by any
     * effect/memo created here on a later run, is caught.
     */
    children: () => MountNode;
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
 * ErrorBoundary
 *
 * PURPOSE:
 * Catches errors thrown inside `children` - synchronously during children(), and from
 * effects/memos created in the subtree even on much later signal changes - and renders
 * `fallback(error, reset)` in their place, with reset() to re-attempt children.
 *
 * WHY IT EXISTS:
 * A throw in a child effect/memo otherwise bubbles up and tears down the surrounding subtree.
 * Doing catchError() + a manual content swap by hand is verbose and offers no retry.
 * ErrorBoundary declares fallback + children, catches at the boundary, swaps the branch, and
 * hands the fallback a reset(), so recoverable error UI is one component.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, component; a control-flow brancher built on catchError. Mode-dispatched: a plain
 * try/catch in SSR (no later effect runs; reset is a no-op in static HTML), a localized rebuild
 * on hydration, and catchError + co-range swap on the client.
 *
 * INPUT CONTRACT:
 * - fallback: (error, reset) => HTMLElement; renders the error UI.
 * - children: () => HTMLElement; the protected subtree, re-evaluated on each reset.
 *
 * OUTPUT CONTRACT:
 * - Returns a co-range handle holding either the children subtree or the fallback, swapping
 *   reactively as errors are caught and reset.
 *
 * WHY THIS DESIGN:
 * children() runs in catchError inside a per-branch createRoot, so the whole failing subtree
 * disposes on swap. The captured error lives in a `{ value } | null` signal so a thrown
 * null/undefined is distinguishable from "no error". The fallback is deliberately NOT wrapped in
 * catchError, so a broken fallback escapes to a parent boundary instead of looping.
 *
 * WHEN TO USE:
 * Around any subtree that may throw and should degrade to recoverable error UI; nest boundaries
 * so an inner one catches first and the outer is a safety net.
 *
 * WHEN NOT TO USE:
 * For async data-fetch errors (observe Resource.error() at the call site - they do NOT route
 * here). For ordinary conditional rendering (use {@link Show}). It does not catch event-handler
 * or promise-rejection errors.
 *
 * EDGE CASES:
 * - A thrown null/undefined is still caught (the `{ value }` wrapper distinguishes it).
 * - A throw inside the fallback propagates outside the boundary (no loop).
 * - reset() with no captured error is a no-op.
 *
 * PERFORMANCE NOTES:
 * One branch alive at a time; a swap happens only when an error is caught or reset is called.
 *
 * DEVELOPER WARNING:
 * Keep the fallback safe - if it can throw, the error escapes to a parent boundary or the page.
 * Only reactive throws (setup + effect/memo) are caught; route async failures through Resource.
 *
 * @param props - {@link ErrorBoundaryProps}: `fallback`, `children`.
 * @returns A co-range handle that swaps children/fallback on error and reset.
 * @see {@link Show}
 * @example
 * ErrorBoundary({
 *   fallback: (err, reset) => h('div', { class: 'error' },
 *     h('p', {}, `Something broke: ${ String(err) }`),
 *     h('button', { onClick: reset }, 'Try again')
 *   ),
 *   children: () => RiskyComponent({})
 * });
 */
export function ErrorBoundary(props: ErrorBoundaryProps): MountNode
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
        return wrapContentsAnchored('errorboundary', inner) as unknown as MountNode;
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
        }) as unknown as MountNode;
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
                        // benign no-op. The loop CONVERGES (error
                        // null -> caught -> fallback branch, which
                        // does not re-throw into this handler), so
                        // the syntactic self-write rule's warning
                        // does not apply.
                        // eslint-disable-next-line azeroth/no-self-write-in-effect -- convergent by design; see above
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

    return fragment;
}
