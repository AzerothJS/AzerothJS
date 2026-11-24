/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { DEV } from './dev.ts';

/** A fetched outcome. JSON omits d when the fulfilled value was undefined. */
export interface StreamSeed
{
    d?: unknown;
    e?: string;
    n?: string;
}

interface Receiver
{
    name: string | undefined;
    apply: (seed: StreamSeed) => boolean;
    release: () => void;
    forget: () => void;
}

const receivers = new WeakMap<object, Receiver>();
let windowHolds: Set<Receiver> | undefined;

function seedStore(): Record<string, unknown> | undefined
{
    return (globalThis as { __AZS_S?: Record<string, unknown> }).__AZS_S;
}

/** A hydration call, island or deferred route holds work only through its own synchronous walk. */
export function withStreamSeedWindow<T>(build: () => T, inDom: (work: () => void) => void): T
{
    const previous = windowHolds;
    const store = seedStore();
    let holds: Set<Receiver> | undefined;
    for (const key in store)
    {
        if (/^\d+\.\d+$/.test(key))
        {
            holds = new Set();
            break;
        }
    }
    windowHolds = holds;
    try
    {
        const value = build();
        if (holds !== undefined && holds.size > 0)
        {
            const waiting = holds;
            inDom(() =>
            {
                for (const receiver of waiting)
                {
                    receiver.release();
                }
            });
        }
        return value;
    }
    catch (error)
    {
        if (holds !== undefined)
        {
            for (const receiver of holds)
            {
                receiver.forget();
            }
        }
        throw error;
    }
    finally
    {
        holds?.clear();
        windowHolds = previous;
    }
}

export function hasSeedWindow(): boolean
{
    return windowHolds !== undefined;
}

/** A released first fetch can still accept a seed from a subsequently adopted boundary. */
export function holdStreamSeed(resource: object, apply: (seed: StreamSeed) => boolean, release: () => void, name?: string): () => void
{
    const holds = windowHolds;
    function forget(): void
    {
        holds?.delete(receiver);
        receivers.delete(resource);
    }
    const receiver = { name, apply, release, forget };
    receivers.set(resource, receiver);
    holds?.add(receiver);
    return forget;
}

function isOutcome(value: unknown): value is StreamSeed
{
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.keys(value).every(key => key === 'd' || key === 'e' || key === 'n')
        && !('d' in value && 'e' in value)
        && (!('e' in value) || typeof value.e === 'string')
        && (!('n' in value) || typeof value.n === 'string');
}

function watchListMismatch(id: string, resources: readonly object[], store: Record<string, unknown>, serverLength: number): string | undefined
{
    if (serverLength !== resources.length)
    {
        return `[azeroth] Streamed Suspense ${ id } listed ${ serverLength } resources on the server and ${ resources.length } on the client.`;
    }
    for (const [index, resource] of resources.entries())
    {
        const seed = store[`${ id }.${ index }`];
        const name = receivers.get(resource)?.name;
        if (name && isOutcome(seed) && seed.n && seed.n !== name)
        {
            return `[azeroth] Streamed Suspense ${ id } slot ${ index } changed from ${ seed.n } to ${ name }.`;
        }
    }
    return undefined;
}

/** Returns true for a complete addressed group, false for an unusable one and undefined for no group. */
export function seedBoundary(id: string, resources: readonly object[]): boolean | undefined
{
    const store = seedStore();
    if (store === undefined)
    {
        return undefined;
    }
    const sizeKey = `${ id }.l`;
    const serverLength = store[sizeKey];
    const diagnostic = DEV && typeof serverLength === 'number';
    if (diagnostic)
    {
        // Validate the entire list before publishing even its first slot to a cache.
        const mismatch = watchListMismatch(id, resources, store, serverLength);
        if (mismatch !== undefined)
        {
            console.warn(mismatch);
            const prefix = `${ id }.`;
            for (const key of Object.keys(store))
            {
                if (key.startsWith(prefix))
                {
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- retire the mismatched group
                    delete store[key];
                }
            }
            return false;
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- boundary metadata is consumed once
    delete store[sizeKey];
    let found = false;
    let missing = false;
    for (let index = 0; index < resources.length; index++)
    {
        const key = `${ id }.${ index }`;
        const resource = resources[index] as object;
        const receiver = receivers.get(resource);
        if (!Object.hasOwn(store, key))
        {
            missing ||= receiver !== undefined;
            continue;
        }
        found = true;
        const seed = store[key];
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- consumed once even for a repeated resource
        delete store[key];
        if (!isOutcome(seed))
        {
            missing = true;
            continue;
        }
        if (receiver !== undefined)
        {
            if (receiver.apply(seed))
            {
                receiver.forget();
            }
            else
            {
                missing = true;
            }
        }
    }
    if (diagnostic && missing && found)
    {
        console.warn(`[azeroth] Streamed Suspense ${ id } has an unavailable resource seed.`);
    }
    return found ? !missing : undefined;
}

/** Only inspect live numbered ranges in the root which just finished adoption. */
export function warnUnclaimedSeeds(root: HTMLElement): void
{
    const store = seedStore();
    if (!DEV || !store || !Object.keys(store).some(key => key.endsWith('.l')))
    {
        return;
    }
    const walker = root.ownerDocument.createTreeWalker(root, 128 /* SHOW_COMMENT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
    {
        const id = /^azc:suspense:(\d+)$/.exec((node as Comment).data)?.[1];
        const island = node.parentElement?.closest('[data-azeroth-island]');
        if (id !== undefined && Object.hasOwn(store, `${ id }.l`) && (!island || island === root)
            && !node.parentElement?.closest('noscript'))
        {
            console.warn(`[azeroth] No Suspense adopted streamed boundary ${ id } in this hydrated root.`);
        }
    }
}
