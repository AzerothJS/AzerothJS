// ============================================================================
// QUANTUM FRAMEWORK — Dynamic (Swap Components at Runtime)
// ============================================================================
//
// Dynamic renders different components based on a reactive signal.
// The component itself can change at runtime.
//
// WITHOUT Dynamic:
//   h('div', {}, () => {
//     const View = currentView();
//     if (View === 'home') return Home({});
//     if (View === 'about') return About({});
//     return NotFound({});
//   })
//   // Manual, messy, doesn't handle component references cleanly
//
// WITH Dynamic:
//   Dynamic({
//     component: currentView,
//     props: () => ({ user: currentUser() }),
//   })
//   // Clean — just swap the component signal
//
// USE CASES:
//   - Tab panels (swap between tab content components)
//   - Role-based rendering (Admin vs User component)
//   - Plugin systems (load components dynamically)
//   - Wizard/stepper UIs (step 1, step 2, step 3...)
//   - Nullable modals (null = hidden, Component = shown)
//
// NOTE ON STORING FUNCTIONS IN SIGNALS:
//   When using setView(NewComponent), you must wrap it:
//     setView(() => NewComponent)
//   Because the setter can't distinguish "store this function"
//   from "use this function to compute next value."
//
// ============================================================================

import { createEffect } from '../reactivity/effect.ts';

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
 * // Nullable — renders nothing when null
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
    const container = document.createElement('span');
    container.style.display = 'contents';

    createEffect(() =>
    {
        // Clear previous component properly
        while (container.firstChild)
        {
            container.removeChild(container.firstChild);
        }

        const Component = dynamicProps.component();

        if (Component)
        {
            // Get props (or empty object)
            const props = dynamicProps.props ? dynamicProps.props() : {};

            // Render the new component
            container.appendChild(Component(props));
        }
    });

    return container as unknown as HTMLElement;
}
