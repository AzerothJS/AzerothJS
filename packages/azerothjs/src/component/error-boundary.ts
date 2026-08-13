/**
 * Wraps a child factory and swaps to a fallback when the child throws - sugar
 * over catchError from azerothjs, catching BOTH synchronous setup errors and errors
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

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import type { MountNode } from './types.ts';
import { createSignal, createEffect, createRoot, catchError, isStringMode, isHydrating, runInMode } from '../reactivity/index.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode } from '../reactivity/internal.ts';
import { createCoMarkers, appendToCo, clearCo, resolveMountNode } from './co-range.ts';

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
 * Catches errors thrown inside `children` and renders `fallback(error, reset)` in their place.
 *
 * Both the synchronous throw during construction and a throw from an effect or memo created
 * in the subtree are caught, however much later that happens. What is NOT caught: async
 * data-fetch failures, which you observe through `Resource.error()` at the call site, and
 * errors in event handlers or promise rejections.
 *
 * Keep the fallback safe. It is deliberately NOT wrapped in the boundary's own handler, so a
 * fallback that throws escapes to a parent boundary or the page - which is what stops a
 * broken fallback from re-triggering its own boundary forever.
 *
 * A thrown `null` or `undefined` is still caught, because the captured error is stored
 * wrapped rather than as a bare value. `reset()` with nothing captured is a no-op.
 *
 * Nest boundaries freely: the innermost catches first, the outer ones are the safety net.
 *
 * @param props - `fallback` renders the error UI and receives `reset`; `children` is the
 *                protected subtree, re-evaluated on every reset.
 * @returns A handle that swaps between children and fallback.
 * @example
 * ErrorBoundary({
 *     fallback: (error, reset) => h('div', { class: 'error' },
 *         h('p', {}, `Something broke: ${ String(error) }`),
 *         h('button', { onClick: reset }, 'Try again')
 *     ),
 *     children: () => RiskyComponent({})
 * });
 *
 * @see {@link Show} for ordinary conditional rendering.
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
                        appendToCo(target, resolveMountNode(props.children()));
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
                appendToCo(target, resolveMountNode(props.fallback(captured.value, reset)));
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
