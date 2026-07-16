/**
 * MODULE: @azerothjs/component - public API
 *
 * The component-runtime layer beneath the renderer: destroyComponent() (node-bound subtree
 * teardown), <ErrorBoundary> (catch errors in a subtree and render a fallback), and the
 * co-range helpers (comment-marker placement ranges) the renderer's control-flow components
 * build on. The co-range helpers are framework infrastructure consumed by the renderer, not
 * app-facing API; they live here because they need destroyComponent and renderer depends on
 * component, not the reverse.
 */

export { destroyComponent } from './destroy-component.ts';

export { ErrorBoundary } from './error-boundary.ts';
export type { ErrorBoundaryProps } from './error-boundary.ts';

// Shared control-flow placement helpers (comment-marker ranges). Consumed by the renderer's
// control-flow components; here because they need destroyComponent and renderer depends on
// component, not the reverse.
export {
    adoptCoRange,
    createCoMarkers,
    appendToCo,
    clearCo
} from './co-range.ts';
export type { CoTarget } from './co-range.ts';

// The client-side return contract for components and control-flow components.
export type { MountNode } from './types.ts';
