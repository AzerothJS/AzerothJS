/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSignal, isStringMode, untrack } from '../reactivity/index.ts';
import type { Getter, Resource } from '../reactivity/index.ts';
import type { ResourceKeyObserver } from '../reactivity/create-resource.ts';

type Outcome = Omit<Resource<unknown>, 'refetch'>;

const idle: Outcome = {
    data: () => undefined,
    error: () => null,
    loading: () => false,
    refreshing: () => false
};

/**
 * The router still drives one resource per level. A mounted page retains the view
 * for the key it displayed. Before that resource changes keys, freeze its last
 * published fields, even if the page has not yet read them. Only the current and
 * upcoming views are held here; old snapshots live as long as their mounted readers.
 */
export function loaderPresentation(keyNow: Getter<string | null>): ResourceKeyObserver<string, unknown> & {
    read: () => Resource<unknown> | undefined;
}
{
    interface View
    {
        key: string;
        resource: Resource<unknown>;
        publish: (value: Outcome) => void;
    }

    let raw: Resource<unknown>;
    let request: (key: string) => Promise<void>;
    let driven: string | undefined;
    let current: View | undefined;
    let selected: View | undefined;

    return {
        connect(resource, refetch)
        {
            raw = resource;
            request = refetch;
        },
        move(key)
        {
            if (key === driven)
            {
                return;
            }
            if (current !== undefined)
            {
                const data = raw.data();
                const error = raw.error();
                const loading = raw.loading();
                const refreshing = raw.refreshing();
                current.publish({ data: () => data, error: () => error, loading: () => loading, refreshing: () => refreshing });
                if (selected === current)
                {
                    selected = undefined;
                }
            }
            // A cache fetcher can synchronously read the new view before the resource
            // mirrors the destination entry. Expose that view only after publication.
            current = undefined;
            driven = undefined;
        },
        attach(key)
        {
            driven = key;
            current = selected?.key === key ? selected : undefined;
            current?.publish(raw);
        },
        read()
        {
            const key = keyNow();
            if (key === null)
            {
                selected = undefined;
                return;
            }
            if (isStringMode())
            {
                // StreamSession associates the server fetch with the original resource.
                return raw;
            }
            if (selected?.key === key)
            {
                return selected.resource;
            }
            if (current?.key === key)
            {
                selected = current;
                return current.resource;
            }
            const [outcome, publish] = createSignal<Outcome>(driven === key ? raw : idle);
            const view: View = {
                key,
                publish,
                resource: {
                    data: () => outcome().data(),
                    error: () => outcome().error(),
                    loading: () => outcome().loading(),
                    refreshing: () => outcome().refreshing(),
                    refetch: () => selected === view && untrack(keyNow) === key ? request(key) : Promise.resolve()
                }
            };
            selected = view;
            if (driven === key)
            {
                current = view;
            }
            return view.resource;
        }
    };
}
