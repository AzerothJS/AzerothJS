/**
 * MODULE: @azerothjs/renderer - public API
 *
 * The DOM layer of the framework. h() builds real elements directly (no virtual DOM);
 * render()/hydrate()/hydrateIslands() mount, adopt, and partially-hydrate trees; the
 * control-flow components (Show, For, Switch/Match, Dynamic, Suspense, Transition, Portal)
 * cover conditional, list, async, and relocated rendering; and the bindings (createRef,
 * classList, styleMap, css) cover element refs and reactive styling. Every symbol re-exported
 * here is documented at its definition.
 *
 * The compiler-emitted runtime (bindHole/bindSlot/bindProps/setProp/hydrateChild/tmpl) is
 * exported ONLY so generated `.azeroth` output can resolve it; it is @internal and may change
 * between releases - not part of the application API.
 */

// Core: element creation and mounting.
export { h } from './h.ts';
export { render } from './render.ts';
export { hydrate } from './hydrate.ts';
export { hydrateIslands } from './islands.ts';
export type { IslandRegistry, IslandComponent } from './islands.ts';

// Control-flow components.
export { Show } from './show.ts';
export { For } from './for.ts';
export { Switch, Match } from './switch.ts';
export { Portal, destroyPortal } from './portal.ts';
export { Dynamic } from './dynamic.ts';
export { Suspense } from './suspense.ts';
export { Transition } from './transition.ts';

// Bindings: refs and reactive styling.
export { createRef } from './ref.ts';
export { classList } from './class-binding.ts';
export { styleMap } from './style-binding.ts';
export { css, collectStyleSheet, resetStyleSheet, type ScopedClasses } from './css.ts';

// Compiler-emitted runtime: imported by generated `.azeroth` output, NOT part of the
// application API. Exported only so compiled modules resolve them; @internal, may change.
export { bindHole, bindSlot, bindProps, setProp, hydrateChild } from './h.ts';
export { tmpl } from './template.ts';

// Public type contracts.
export type { Props, Child } from './types.ts';
export type { ShowProps } from './show.ts';
export type { ForProps } from './for.ts';
export type { MatchCase, MatchProps, SwitchProps } from './switch.ts';
export type { PortalProps } from './portal.ts';
export type { DynamicProps } from './dynamic.ts';
export type { SuspenseProps } from './suspense.ts';
export type { TransitionProps } from './transition.ts';
export type { Ref } from './ref.ts';
export type { ClassObject } from './class-binding.ts';
export type { StyleObject } from './style-binding.ts';
