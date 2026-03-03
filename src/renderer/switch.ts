// ============================================================================
// QUANTUM FRAMEWORK — Switch/Match (Multi-Condition Rendering)
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

import { createEffect } from '../reactivity/effect.ts';

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

    createEffect(() =>
    {
        // Remove children properly (not innerHTML) for Portal support
        while (container.firstChild)
        {
            container.removeChild(container.firstChild);
        }

        // Find the FIRST matching case
        for (const matchCase of cases)
        {
            if (matchCase.when())
            {
                container.appendChild(matchCase.render());
                return;
            }
        }
    });

    return container as unknown as HTMLElement;
}
