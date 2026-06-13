// Switch renders the first matching case from a list of Match cases - a
// switch/case statement for reactive UI, where only one branch is mounted at
// a time.
//
// Why: a chain of if/return inside h() works but gets messy with many
// conditions and obscures that the branches are mutually exclusive.
//
// Without Switch: a reactive if/else-if chain inside h().
//
//     h('div', {}, () =>
//     {
//         if (status() === 'loading') return h('p', {}, 'Loading...');
//         if (status() === 'error')   return h('p', {}, 'Error!');
//         return h('p', {}, 'Done!'); // exclusivity is implicit in the order
//     })
//
// With Switch/Match: each case is a separate, declarative unit.
//
//     Switch({
//         fallback: () => h('p', {}, 'Unknown'),
//         children: [
//             Match({ when: () => status() === 'loading', children: () => h('p', {}, 'Loading...') }),
//             Match({ when: () => status() === 'error',   children: () => h('p', {}, 'Error!') }),
//             Match({ when: () => status() === 'success', children: () => h('p', {}, 'Done!') })
//         ]
//     }) // only the first match (or fallback) is mounted; exclusivity is explicit

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, isStringMode, isHydrating, untrack, serializeChild, wrapContents, hydrationNode, HydrationCursor } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';
import { hydrateChild } from './h.ts';

/**
 * A single case in a Switch block.
 *
 * Created by the Match() function. Contains a condition
 * and a render function.
 */
export interface MatchCase
{
    /** Reactive condition - returns true when this case should render. */
    when: () => boolean;

    /** Render function - creates the DOM element for this case. */
    render: () => HTMLElement;
}

/**
 * Props for a {@link Match} case.
 */
export interface MatchProps
{
    /** Reactive condition - true when this case should render. */
    when: () => boolean;

    /** Thunk that builds this case's content (passed as a prop so
     *  it matches the compiled `<Match when={...}>...</Match>` form). */
    children: () => HTMLElement;
}

/**
 * Creates a single case for use inside Switch().
 *
 * @param props - `{ when, children }`
 *
 * @returns A MatchCase object for use in Switch()
 *
 * @example
 * ```ts
 * Match({
 *   when: () => status() === 'loading',
 *   children: () => h('div', {}, 'Loading...')
 * });
 * ```
 */
export function Match(props: MatchProps): MatchCase
{
    return {
        when: props.when,
        render: props.children
    };
}

/**
 * Renders the first matching case from a list of Match cases.
 *
 * Reactively watches all conditions and swaps to the correct case when they
 * change. Only one case is rendered at a time. If no case matches, the
 * optional `fallback` is rendered (or nothing).
 *
 * @param props - `{ children: MatchCase[], fallback? }`
 *
 * @returns An HTMLElement that reactively shows the matching case
 *
 * @example
 * ```ts
 * const [status, setStatus] = createSignal('idle');
 *
 * Switch({
 *   fallback: () => h('div', {}, 'Idle'),
 *   children: [
 *     Match({ when: () => status() === 'loading', children: () => h('div', {}, 'Loading...') }),
 *     Match({ when: () => status() === 'error',   children: () => h('div', {}, 'Error!') }),
 *     Match({ when: () => status() === 'success', children: () => h('div', {}, 'Done!') })
 *   ]
 * });
 * ```
 */
export interface SwitchProps
{
    /**
     * The Match cases, in priority order (first match wins). Accepts
     * an array (manual API) or a thunk returning one/many cases -
     * the latter is what compiled `.azeroth` markup produces from
     * `<Switch><Match/>...</Switch>`.
     */
    children: MatchCase[] | (() => MatchCase[] | MatchCase);

    /** Optional content when no case matches. */
    fallback?: () => HTMLElement;
}

export function Switch(props: SwitchProps): HTMLElement
{
    // Normalize once: a thunk is evaluated to its cases, and a lone
    // case is wrapped into an array. Building Match cases doesn't read
    // signals (only their `when` getters do, inside the effect below),
    // so this is safe to do outside the reactive scope.
    const raw = typeof props.children === 'function' ? props.children() : props.children;
    const cases: MatchCase[] = Array.isArray(raw) ? raw : [raw];

    // Server-side rendering.
    // Emit the first case whose `when` is true (read once), else the
    // optional fallback - wrapped in a contents anchor for hydration.
    if (isStringMode())
    {
        for (const matchCase of cases)
        {
            if (untrack(() => matchCase.when()))
            {
                return wrapContents('switch', serializeChild(matchCase.render())) as unknown as HTMLElement;
            }
        }

        const fallbackInner = props.fallback ? serializeChild(props.fallback()) : '';
        return wrapContents('switch', fallbackInner) as unknown as HTMLElement;
    }

    // Hydration.
    // Adopt the wrapper span and its current matching case on the first
    // effect run; subsequent condition changes use the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            driveSwitch(props, cases, cursor.takeElement('span'), true);
        }) as unknown as HTMLElement;
    }

    const container = document.createElement('span');
    container.style.display = 'contents';

    driveSwitch(props, cases, container, false);

    return container as unknown as HTMLElement;
}

/**
 * Wires the case-selection effect onto `container`. Shared by the DOM path
 * (a fresh span) and hydration (the adopted server span).
 *
 * @param props - The Switch props
 * @param cases - The normalized list of Match cases
 * @param container - The contents wrapper
 * @param hydrateFirstRun - When true, the first run adopts the existing
 *                          server children instead of building new ones
 *
 * @internal
 */
function driveSwitch(props: SwitchProps, cases: MatchCase[], container: HTMLElement, hydrateFirstRun: boolean): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;

    createEffect(() =>
    {
        // Find the first matching case - stopping at the first match means a
        // lower case's condition is only tracked (and thus only triggers a
        // re-render) when no higher case is already winning - else fallback.
        let factory: (() => HTMLElement) | null = null;
        for (const matchCase of cases)
        {
            if (matchCase.when())
            {
                factory = matchCase.render;
                break;
            }
        }

        if (!factory && props.fallback)
        {
            factory = props.fallback;
        }

        if (firstRun)
        {
            firstRun = false;
            if (factory)
            {
                const build = factory;
                createRoot((d) =>
                {
                    branchDispose = d;
                    hydrateChild(untrack(build), new HydrationCursor(container));
                });
            }
            return teardownBranch;
        }

        if (factory)
        {
            const build = factory;
            createRoot((d) =>
            {
                branchDispose = d;
                // untrack: only the `when` conditions drive this effect. A
                // synchronous signal read inside the case's render function
                // must not subscribe the selection effect - that would
                // rebuild the branch on every change of that signal.
                container.appendChild(untrack(build));
            });
        }

        // `teardownBranch` is the SINGLE teardown path: the effect
        // runs it before every re-render AND on dispose - disposing
        // the losing branch's effects before its DOM is discarded.
        return teardownBranch;
    });

    function teardownBranch(): void
    {
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }

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
}
