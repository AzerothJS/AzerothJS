/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The SLOT HANDLE: the branded, NON-CALLABLE value a route layout receives as its
 * `children` prop and places where the nested route's content goes (normally through
 * `<Outlet>`).
 *
 * The handle is an opaque object, deliberately not a function: every renderer path treats
 * a function child as a reactive hole, and `resolveThunks`' loop condition is
 * `typeof === 'function'`, so a non-callable object passes through every thunk-resolution
 * site untouched (pinned by spec). Instead, each DOM/string/hydration WRITER a child value
 * can travel through carries one branded check that dispatches to the driver this module
 * defines - the router supplies the driver, the writers never learn anything about routing.
 *
 * Live-placement cardinality lives here because every writer must agree on it: a handle
 * has AT MOST ONE LIVE placement; disposing a placement re-arms the handle; a second
 * placement while the first is live throws in DEV and is a warn-and-no-op in production.
 */

import { DEV } from './dev.ts';

/** The brand key. A registry symbol so duplicated module instances still agree. */
const SLOT_BRAND: unique symbol = Symbol.for('azerothjs.slot') as never;

/**
 * What the router supplies for one slot: how to place it in each render mode. The writers
 * call exactly one of these per placement; the driver owns everything route-shaped.
 */
export interface SlotDriver
{
    /**
     * dom mode: create the slot's marker pair and driving effect, inserting the markers
     * (and the initially rendered content) into `parent` before `before` (append when
     * `before` is null). Returns the placement's disposer, which the placing writer may
     * discard - the slot registers its own teardown with the current ownership scope.
     */
    place(parent: Node, before: ChildNode | null): void;

    /** string mode: the serialized `azc:outlet` range (or bare content, markers off). */
    serialize(): string;

    /**
     * hydrate mode: adopt the slot's `azc:outlet` range from `cursor` (the expected-label
     * check lives inside), construct the nested segment inline, and wire the consumed-run
     * effect per the contract.
     */
    adopt(cursor: unknown): void;
}

/** The handle's shape: the brand plus its live-placement bookkeeping. */
export interface SlotHandle
{
    [SLOT_BRAND]: SlotDriver;

    /** True while a placement is live; re-armed (set false) when that placement disposes. */
    live: boolean;
}

/** Creates a handle over `driver`. Router-internal; applications never construct one. */
export function createSlotHandle(driver: SlotDriver): SlotHandle
{
    return { [SLOT_BRAND]: driver, live: false };
}

/** Whether `value` is a slot handle. The one branded check every writer shares. */
export function isSlotHandle(value: unknown): value is SlotHandle
{
    return typeof value === 'object' && value !== null && SLOT_BRAND in value;
}

/** The driver behind a handle. @internal */
export function slotDriverOf(handle: SlotHandle): SlotDriver
{
    return handle[SLOT_BRAND];
}

/**
 * Claims the handle for a new live placement, enforcing the cardinality rule: a second
 * placement while the first is live throws in DEV and warn-and-no-ops in production
 * (first placement wins). Returns false when the placement must not proceed.
 *
 * The RELEASE side is the placement's own teardown calling {@link releaseSlotPlacement} -
 * disposing a placement (an ErrorBoundary reset, a Show-wrapped outlet toggling away)
 * re-arms the handle, and a later placement rebuilds the segment fresh.
 */
export function claimSlotPlacement(handle: SlotHandle): boolean
{
    if (handle.live)
    {
        const message = 'A route slot (a layout\'s `children`) is already placed. A slot may have '
            + 'one live placement at a time; dispose the first (or let its branch dispose) before '
            + 'placing it again.';
        if (DEV)
        {
            throw new Error(`[azeroth router] ${ message }`);
        }
        console.warn(`[azeroth router] ${ message }`);
        return false;
    }
    handle.live = true;
    return true;
}

/** Re-arms the handle after its live placement disposed. @internal */
export function releaseSlotPlacement(handle: SlotHandle): void
{
    handle.live = false;
}

/**
 * The refusal shared by hosts that cannot contain a slot (Transition's single-element
 * machine, Portal's out-of-tree target): DEV throws, production warns and no-ops.
 * Returns true when the caller must skip the value.
 */
export function refuseSlotHandle(value: unknown, host: string, hint: string): value is SlotHandle
{
    if (!isSlotHandle(value))
    {
        return false;
    }
    const message = `A route slot (a layout's \`children\`) cannot be placed inside <${ host }>. ${ hint }`;
    if (DEV)
    {
        throw new Error(`[azeroth router] ${ message }`);
    }
    console.warn(`[azeroth router] ${ message }`);
    return true;
}
