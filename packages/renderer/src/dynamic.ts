// Dynamic renders a component chosen by a reactive signal; the component itself
// can change at runtime.
//
// Why: an if/return chain over component references inside h() works but is
// noisy and easy to get wrong.
//
// Without Dynamic: a reactive child that re-selects and re-invokes the
// component by hand.
//
//     h('div', {},
//         () => currentView()({ user: currentUser() })
//     ); // a prop change rebuilds the whole subtree, losing its state
//
// With Dynamic: resolve the current component from a signal and swap it.
//
//     Dynamic({
//         component: currentView,
//         props: () => ({ user: currentUser() })
//     }); // props read untracked, so a prop change won't rebuild the subtree
//
// Use cases:
//   - Tab panels (swap between tab content components)
//   - Role-based rendering (Admin vs User component)
//   - Plugin systems (load components dynamically)
//   - Wizard/stepper UIs (step 1, step 2, step 3...)
//   - Nullable modals (null = hidden, Component = shown)
//
// Gotcha - storing functions in signals: a setter treats a function argument as
// an updater that computes the next value. To store a component reference you
// must wrap it: setView(() => NewComponent).

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, untrack, isStringMode, isHydrating, serializeChild, wrapContents, hydrationNode, HydrationCursor } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';
import { hydrateChild } from './h.ts';

/**
 * Props for the Dynamic component.
 */
export interface DynamicProps
{
    /**
     * A reactive getter that returns the component function to render.
     *
     * When this signal changes, the old component is removed and
     * the new component is rendered in its place.
     *
     * Return null to render nothing.
     */
    component: () => ((props: Record<string, unknown>) => HTMLElement) | null;

    /**
     * Optional reactive getter that returns props to pass
     * to the component. Re-evaluated when the component changes.
     */
    props?: () => Record<string, unknown>;
}

/**
 * Renders a component that can be swapped at runtime.
 *
 * When the `component` signal changes, the current component is
 * removed and the new one is rendered. Props are passed through.
 *
 * @param dynamicProps - DynamicProps with `component` and optional `props`
 *
 * @returns An HTMLElement that reactively swaps its content
 *
 * @example
 * ```ts
 * // Basic tab switching
 * const Home = () => h('div', {}, 'Home Page');
 * const About = () => h('div', {}, 'About Page');
 *
 * const [currentView, setCurrentView] = createSignal(Home);
 *
 * Dynamic({ component: currentView });
 *
 * // Switch to About page (wrap in arrow function!):
 * setCurrentView(() => About);
 * ```
 *
 * @example
 * ```ts
 * // With props
 * const [activeTab, setActiveTab] = createSignal(TabOne);
 *
 * Dynamic({
 *   component: activeTab,
 *   props: () => ({ title: 'My Tab' })
 * });
 * ```
 *
 * @example
 * ```ts
 * // Nullable - renders nothing when null
 * const [modal, setModal] = createSignal<(() => HTMLElement) | null>(null);
 *
 * Dynamic({ component: modal });
 *
 * setModal(() => ConfirmDialog);  // Show
 * setModal(null);                  // Hide
 * ```
 */
export function Dynamic(dynamicProps: DynamicProps): HTMLElement
{
    // Server-side rendering.
    // Resolve the component and its props ONCE and emit its output,
    // wrapped in a contents anchor for hydration.
    if (isStringMode())
    {
        const Component = untrack(() => dynamicProps.component());
        if (!Component)
        {
            return wrapContents('dynamic', '') as unknown as HTMLElement;
        }

        const resolvedProps = dynamicProps.props ? untrack(() => dynamicProps.props!()) : {};
        return wrapContents('dynamic', serializeChild(Component(resolvedProps))) as unknown as HTMLElement;
    }

    // Hydration.
    // Adopt the wrapper span and its current component on the first
    // effect run; a later component swap uses the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            driveDynamic(dynamicProps, cursor.takeElement('span'), true);
        }) as unknown as HTMLElement;
    }

    const container = document.createElement('span');
    container.style.display = 'contents';

    driveDynamic(dynamicProps, container, false);

    return container as unknown as HTMLElement;
}

/**
 * Wires the component-swap effect onto `container`. Shared by the DOM path
 * (a fresh span) and hydration (the adopted server span).
 *
 * @param dynamicProps - The Dynamic props
 * @param container - The contents wrapper
 * @param hydrateFirstRun - When true, the first run adopts the existing
 *                          server children instead of building new ones
 *
 * @internal
 */
function driveDynamic(dynamicProps: DynamicProps, container: HTMLElement, hydrateFirstRun: boolean): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;

    // Track ONLY the component signal - we don't want a prop signal
    // change to tear down and rebuild the entire component tree.
    // Components are expected to subscribe to their own props
    // internally for fine-grained updates.
    createEffect(() =>
    {
        // Reading `component()` is what subscribes this effect - so a
        // component swap re-runs it, but a props change does not.
        const Component = dynamicProps.component();

        if (Component)
        {
            // Read props WITHOUT subscribing - initial value only.
            // Components subscribe to their own props internally for
            // fine-grained updates, so a prop change must not tear
            // down and rebuild the whole component tree.
            const props = dynamicProps.props ? untrack(() => dynamicProps.props!()) : {};

            if (firstRun)
            {
                firstRun = false;
                createRoot((d) =>
                {
                    branchDispose = d;
                    hydrateChild(untrack(() => Component(props)), new HydrationCursor(container));
                });
                return teardownBranch;
            }

            createRoot((d) =>
            {
                branchDispose = d;
                // untrack: only the `component` signal drives this effect.
                // A synchronous signal read in the component's setup must
                // not subscribe it, or that signal would rebuild the whole
                // component tree on every change.
                container.appendChild(untrack(() => Component(props)));
            });
        }
        else
        {
            firstRun = false;
        }

        // Single teardown path - runs before every re-render (swap)
        // and on dispose.
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
