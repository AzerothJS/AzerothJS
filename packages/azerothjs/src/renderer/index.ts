/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The DOM layer. h() builds real elements directly; render, hydrate and hydrateIslands
 * mount, adopt and partially hydrate trees; the control-flow components cover conditional,
 * list, async and relocated rendering; and the bindings cover element refs and reactive
 * styling. Every symbol re-exported here is documented at its definition.
 *
 * The compiler-emitted runtime - bindHole, bindSlot, bindProps, setProp, hydrateChild, tmpl
 * - is exported only so generated output can resolve it. It is internal and may change
 * between releases.
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
export { TransitionGroup } from './transition-group.ts';
export { createVirtualizer, VirtualList } from './virtual.ts';
export type { VirtualizerOptions, Virtualizer, VirtualRange, VirtualListProps } from './virtual.ts';
export type { TransitionGroupProps } from './transition-group.ts';

// Bindings: refs and reactive styling.
export { createRef } from './ref.ts';
export { classList } from './class-binding.ts';
export { styleMap } from './style-binding.ts';
export { css, collectStyleSheet, resetStyleSheet, type ScopedClasses } from './css.ts';
export { useHead, type HeadInput, type HeadMeta, type HeadLink, type HeadValue, type JsonLdValue } from './head.ts';

// Public type contracts.
export type { Props, Child } from './types.ts';
export type { MountNode } from '../component/index.ts';
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
