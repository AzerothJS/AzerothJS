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
     */
    component: () => ((props: Record<string, unknown>) => HTMLElement) | null;

    /**
     * Optional reactive getter that returns props to pass to the component.
     *
     * Re-evaluated when the component changes.
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
 * const Home = () => h('div', {}, 'Home Page');
 * const About = () => h('div', {}, 'About Page');
 * const Contact = () => h('div', {}, 'Contact Page');
 *
 * const [currentView, setCurrentView] = createSignal(Home);
 *
 * // This renders Home. When currentView changes, it swaps.
 * Dynamic({ component: currentView });
 *
 * // Switch to About page:
 * setCurrentView(About);
 * ```
 *
 * @example
 * ```ts
 * // With props
 * const [activeTab, setActiveTab] = createSignal(TabOne);
 * const [tabData, setTabData] = createSignal({ title: 'Tab 1' });
 *
 * Dynamic({
 *   component: activeTab,
 *   props: tabData,
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
 * // Show modal:
 * setModal(ConfirmDialog);
 *
 * // Hide modal:
 * setModal(null);
 * ```
 */
export function Dynamic(dynamicProps: DynamicProps): HTMLElement
{
    const container = document.createElement('span');
    container.style.display = 'contents';

    createEffect(() =>
    {
        container.innerHTML = '';

        const Component = dynamicProps.component();

        if (Component)
        {
            const props = dynamicProps.props ? dynamicProps.props() : {};

            container.appendChild(Component(props));
        }
    });

    return container as unknown as HTMLElement;
}
