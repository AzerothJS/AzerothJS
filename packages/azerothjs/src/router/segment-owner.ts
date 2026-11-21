/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createEffect, createMemo, getOwner, isStringMode, type Resource } from '../reactivity/index.ts';
import { paramNamesOf } from './path-pattern.ts';
import type { Router } from './router.ts';
import type { RouteMatch } from './types.ts';

export interface RouteSelection
{
    match: RouteMatch | null;
    search: string;
    loaders: readonly (Resource<unknown> | undefined)[];
}

export interface RouteFrame
{
    router: Router;
    level: number;
    match: () => RouteMatch | null;
    loader: (level: number) => Resource<unknown> | undefined;
    rendered: () => RouteMatch | null;
    active: () => boolean;
}

export interface SegmentPlacement
{
    frame: RouteFrame;
    selection: () => RouteSelection;
    available: () => RouteSelection | null;
    record: (selection: RouteSelection) => void;
    mount: () => void;
    outlet?: { readonly live: boolean };
    retire: () => void;
}

export function currentSelection(router: Router, match: RouteMatch | null): RouteSelection
{
    return {
        match,
        search: router.acceptedSearch?.() ?? router.location().search,
        loaders: router.loaderPresentation?.() ?? router.loaders
    };
}

/**
 * A placement belongs to its original parent and the params bound by its own pattern.
 * Validate on read so an old observer cannot race the outlet that will retire it.
 */
export function createSegmentPlacement(router: Router, level: number, initial: RouteSelection,
    presented: () => RouteSelection, rendered: () => RouteMatch | null, parent?: SegmentPlacement): SegmentPlacement
{
    const owner = getOwner();
    const route = initial.match?.matched[level];
    const names = route === undefined ? [] : paramNamesOf(route.path);
    let held = initial;
    let mounted = false;
    let retired = false;

    function available(): RouteSelection | null
    {
        if (retired || owner?.disposed)
        {
            return null;
        }
        const next = parent === undefined ? presented() : parent.available();
        if (next === null || next.match?.matched[level] !== route
            || (level < 0 && next.match !== null)
            || names.some(name => next.match?.params[name] !== initial.match?.params[name]))
        {
            // A synchronous read inside batch() can see an intermediate destination.
            // Only the slot that actually demotes this branch can retire it permanently.
            return null;
        }
        return next;
    }

    const selection = (): RouteSelection => available() ?? held;
    const readMatch = (): RouteMatch | null => selection().match;
    const match = isStringMode() ? readMatch : createMemo(readMatch);

    // Actual outlet construction/adoption records descendant history. A component
    // reading a ready sibling before its outlet runs must not rewrite that history.
    const record = (next: RouteSelection): void =>
    {
        held = next;
        if (mounted)
        {
            parent?.record(next);
        }
    };
    const placement: SegmentPlacement = {
        frame: {
            router, level,
            match: () => retired || owner?.disposed ? held.match : match(),
            loader: depth => selection().loaders[depth],
            rendered,
            active: () => available() !== null
        },
        selection,
        available,
        record,
        mount: () =>
        {
            mounted = true;
            parent?.record(held);
        },
        retire: () =>
        {
            retired = true;
        }
    };
    if (!isStringMode() && level >= 0)
    {
        createEffect(() =>
        {
            const next = available();
            if (mounted && next !== null && (next.match === held.match || !placement.outlet?.live))
            {
                // A query can change the binding without changing the displayed match.
                // Without a placed outlet this component itself is the deepest display.
                record(next);
            }
        });
    }
    return placement;
}
