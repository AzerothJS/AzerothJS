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

import type { DisposeFn } from '@azerothjs/reactivity';
import { createEffect, createRoot } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';

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
    const container = document.createElement('span');
    container.style.display = 'contents';

    // Normalize once: a thunk is evaluated to its cases, and a lone
    // case is wrapped into an array. Building Match cases doesn't read
    // signals (only their `when` getters do, inside the effect below),
    // so this is safe to do outside the reactive scope.
    const raw = typeof props.children === 'function' ? props.children() : props.children;
    const cases: MatchCase[] = Array.isArray(raw) ? raw : [raw];

    let branchDispose: DisposeFn | null = null;

    createEffect(() =>
    {
        // Render the FIRST matching case inside its own root. We
        // stop at the first match, so a lower case's condition is
        // only tracked — and thus only triggers a re-render — when
        // no higher case is already winning.
        let matched = false;
        for (const matchCase of cases)
        {
            if (matchCase.when())
            {
                matched = true;
                createRoot((d) =>
                {
                    branchDispose = d;
                    container.appendChild(matchCase.render());
                });
                break;
            }
        }

        // No case matched → render the optional fallback.
        if (!matched && props.fallback)
        {
            const fallback = props.fallback;
            createRoot((d) =>
            {
                branchDispose = d;
                container.appendChild(fallback());
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

    return container as unknown as HTMLElement;
}
