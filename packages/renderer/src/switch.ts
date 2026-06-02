// ============================================================================
// AZEROTHJS — Switch/Match (Multi-Condition Rendering)
// ============================================================================
//
// Switch renders different content based on which condition matches.
// Like a switch/case statement but for reactive UI rendering.
//
// WITHOUT Switch:
//   h('div', {}, () => {
//     const s = status();
//     if (s === 'loading') return h('p', {}, 'Loading...');
//     if (s === 'error') return h('p', {}, 'Error!');
//     if (s === 'success') return h('p', {}, 'Done!');
//     return h('p', {}, 'Unknown');
//   })
//   // Works but messy with many conditions
//
// WITH Switch:
//   Switch(
//     Match({ when: () => status() === 'loading' },
//       () => h('p', {}, 'Loading...')),
//     Match({ when: () => status() === 'error' },
//       () => h('p', {}, 'Error!')),
//     Match({ when: () => status() === 'success' },
//       () => h('p', {}, 'Done!')),
//   )
//   // Clean, readable, each case is separate
//
// ============================================================================

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
    /** Reactive condition — returns true when this case should render */
    when: () => boolean;

    /** Render function — creates the DOM element for this case */
    render: () => HTMLElement;
}

/**
 * Props for a {@link Match} case.
 */
export interface MatchProps
{
    /** Reactive condition — true when this case should render. */
    when: () => boolean;

    /** Thunk that builds this case's content (passed as a prop so
     *  it matches the compiled `<Match when={…}>…</Match>` form). */
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
 * Reactively watches all conditions. When conditions change,
 * automatically swaps to the correct case. Only ONE case is
 * rendered at a time.
 *
 * If no case matches, the optional `fallback` is rendered (or
 * nothing).
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
     * an array (manual API) or a thunk returning one/many cases —
     * the latter is what compiled `.azeroth` markup produces from
     * `<Switch><Match/>…</Switch>`.
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

    // ── Server-side rendering ─────────────────────────────────
    // Emit the first case whose `when` is true (read once), else the
    // optional fallback — wrapped in a contents anchor for hydration.
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

    // ── Hydration ─────────────────────────────────────────────
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
        // Find the first matching case — stopping at the first match means a
        // lower case's condition is only tracked (and thus only triggers a
        // re-render) when no higher case is already winning — else fallback.
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
                createRoot((d) =>
                {
                    branchDispose = d;
                    hydrateChild(factory(), new HydrationCursor(container));
                });
            }
            return teardownBranch;
        }

        if (factory)
        {
            createRoot((d) =>
            {
                branchDispose = d;
                container.appendChild(factory());
            });
        }

        // `teardownBranch` is the SINGLE teardown path: the effect
        // runs it before every re-render AND on dispose — disposing
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
