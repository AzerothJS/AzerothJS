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
 * Creates a single case for use inside Switch().
 *
 * @param props - Object with a `when` condition function
 * @param render - Function that creates the DOM element
 *
 * @returns A MatchCase object for use in Switch()
 *
 * @example
 * ```ts
 * Match({ when: () => status() === 'loading' },
 *   () => h('div', {}, 'Loading...')
 * );
 * ```
 */
export function Match(props: { when: () => boolean }, render: () => HTMLElement): MatchCase
{
    return {
        when: props.when,
        render
    };
}

/**
 * Renders the first matching case from a list of Match cases.
 *
 * Reactively watches all conditions. When conditions change,
 * automatically swaps to the correct case. Only ONE case is
 * rendered at a time.
 *
 * If no case matches, nothing is rendered.
 *
 * @param cases - One or more MatchCase objects created by Match()
 *
 * @returns An HTMLElement that reactively shows the matching case
 *
 * @example
 * ```ts
 * const [status, setStatus] = createSignal('idle');
 *
 * Switch(
 *   Match({ when: () => status() === 'loading' },
 *     () => h('div', {}, 'Loading...')),
 *
 *   Match({ when: () => status() === 'error' },
 *     () => h('div', {}, 'Error!')),
 *
 *   Match({ when: () => status() === 'success' },
 *     () => h('div', {}, 'Done!')),
 *
 *   // Default fallback
 *   Match({ when: () => true },
 *     () => h('div', {}, 'Idle'))
 * );
 * ```
 */
export function Switch(...cases: MatchCase[]): HTMLElement
{
    const container = document.createElement('span');
    container.style.display = 'contents';

    let branchDispose: DisposeFn | null = null;

    createEffect(() =>
    {
        // Render the FIRST matching case inside its own root. We
        // stop at the first match, so a lower case's condition is
        // only tracked — and thus only triggers a re-render — when
        // no higher case is already winning.
        for (const matchCase of cases)
        {
            if (matchCase.when())
            {
                createRoot((d) =>
                {
                    branchDispose = d;
                    container.appendChild(matchCase.render());
                });
                break;
            }
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
