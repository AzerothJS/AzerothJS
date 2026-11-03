// A cart server whose requests wait for the test: a GET reads the count when it arrives and a POST
// commits only when told, so every ordering in a race spec comes from a release, never a sleep.
import { cached, createEffect, createMutation, createResource, createRoot, revalidate } from 'azerothjs';
import type { AnyCachedFetcher, CachedFetcher, CachedOptions, Mutation, Resource } from 'azerothjs';
import { cachedFamilyOf, getDataCache } from 'azerothjs/internal';
import type { CacheEntry } from 'azerothjs/internal';

export interface Cart
{
    count: number;
}

export type CartFetcher = CachedFetcher<[], Cart>;

/** One macrotask hop: settles, microtasks and effects queued before it have run after it. */
function turn(): Promise<void>
{
    return new Promise((resolve) =>
    {
        setTimeout(resolve, 0);
    });
}

export async function turns(n = 5): Promise<void>
{
    for (let i = 0; i < n; i++)
    {
        await turn();
    }
}

const UNTIL_HOPS = 400;

export async function until(ready: () => boolean, what: string): Promise<void>
{
    for (let i = 0; i < UNTIL_HOPS; i++)
    {
        if (ready())
        {
            return;
        }
        await turn();
    }
    throw new Error(`gave up waiting for ${ what }`);
}

/** A promise's outcome, readable without awaiting it. */
export interface Tracked<T>
{
    done: () => boolean;
    value: () => T | undefined;
    failure: () => unknown;
}

export function track<T>(promise: Promise<T>): Tracked<T>
{
    let done = false;
    let value: T | undefined;
    let failure: unknown;
    const fulfilled = (settled: T): void =>
    {
        done = true;
        value = settled;
    };
    const rejected = (error: unknown): void =>
    {
        done = true;
        failure = error ?? 'rejected';
    };
    promise.then(fulfilled, rejected);
    return { done: () => done, value: () => value, failure: () => failure };
}

export interface ParkedGet
{
    done: boolean;
    aborted: boolean;

    /** Answers with the arrival snapshot, or with the live count on a server that reads late. */
    release: () => void;

    /** Answers with the count the server holds now, as a server that processed the GET late. */
    releaseNow: () => void;
    fail: () => void;
}

export interface ParkedPost
{
    done: boolean;
    committed: boolean;

    /** Applies the write on the server without answering it. */
    commit: () => void;
    answer: () => void;
    release: () => void;
    refuse: () => void;
}

const DRAIN_ROUNDS = 80;

export class GatedServer
{
    public count: number;
    public readonly gets: ParkedGet[] = [];
    public readonly posts: ParkedPost[] = [];

    /** Read by each GET as it arrives: when set, an abort neither answers nor rejects that GET. */
    public ignoreAbort = false;

    /** Reads the count when a GET answers, the shape of a fixture that reads at response time. */
    readonly #readAtAnswer: boolean;

    constructor(start = 0, readAtAnswer = false)
    {
        this.count = start;
        this.#readAtAnswer = readAtAnswer;
    }

    public get(signal?: AbortSignal): Promise<Cart>
    {
        const snapshot = this.count;
        const ignoreAbort = this.ignoreAbort;
        return new Promise((resolve, reject) =>
        {
            const parked: ParkedGet = {
                done: false,
                aborted: false,
                release: () =>
                {
                    if (!parked.done)
                    {
                        parked.done = true;
                        resolve({ count: this.#readAtAnswer ? this.count : snapshot });
                    }
                },
                releaseNow: () =>
                {
                    if (!parked.done)
                    {
                        parked.done = true;
                        resolve({ count: this.count });
                    }
                },
                fail: () =>
                {
                    if (!parked.done)
                    {
                        parked.done = true;
                        reject(new Error('the cart read failed'));
                    }
                }
            };
            const onAbort = (): void =>
            {
                parked.aborted = true;
                if (!ignoreAbort && !parked.done)
                {
                    parked.done = true;
                    reject(new DOMException('aborted', 'AbortError'));
                }
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.gets.push(parked);
        });
    }

    public post(op: (n: number) => number, signal?: AbortSignal): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const parked: ParkedPost = {
                done: false,
                committed: false,
                commit: () =>
                {
                    if (!parked.committed && !parked.done)
                    {
                        parked.committed = true;
                        this.count = op(this.count);
                    }
                },
                answer: () =>
                {
                    if (!parked.done)
                    {
                        parked.done = true;
                        resolve(this.count);
                    }
                },
                release: () =>
                {
                    parked.commit();
                    parked.answer();
                },
                refuse: () =>
                {
                    if (!parked.done)
                    {
                        parked.done = true;
                        reject(new Error('the server refused the write'));
                    }
                }
            };
            const onAbort = (): void =>
            {
                if (!parked.done)
                {
                    parked.done = true;
                    reject(new DOMException('aborted', 'AbortError'));
                }
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.posts.push(parked);
        });
    }

    public pending(): ParkedGet[]
    {
        return this.gets.filter((get) => !get.done);
    }

    public aborted(): number
    {
        return this.gets.filter((get) => get.aborted).length;
    }

    /** Waits for the n-th GET (0-based) to arrive. */
    public async arrived(n: number): Promise<ParkedGet>
    {
        await until(() => this.gets.length > n, `GET #${ n }`);
        return this.gets[n]!;
    }

    public async postArrived(n: number): Promise<ParkedPost>
    {
        await until(() => this.posts.length > n, `POST #${ n }`);
        return this.posts[n]!;
    }

    /** Answers the n-th GET and lets its settle run. */
    public async releaseGet(n: number): Promise<void>
    {
        (await this.arrived(n)).release();
        await turns();
    }

    /** Answers every waiting GET, oldest first, until none arrives for a while. */
    public async drain(): Promise<void>
    {
        for (let i = 0; i < DRAIN_ROUNDS; i++)
        {
            await turns(3);
            const open = this.pending()[0];
            if (open === undefined)
            {
                await turns(5);
                if (this.pending().length === 0)
                {
                    return;
                }
                continue;
            }
            open.release();
        }
        throw new Error('drain: GETs kept arriving');
    }
}

let serial = 0;

/** A cached cart family over the server, under a name no other test shares. */
export function cartFamily(server: GatedServer, tag: string, options: CachedOptions = {}): CartFetcher
{
    serial += 1;
    return cached(`gated-${ tag }-${ serial }`, (signal: AbortSignal) => server.get(signal), options);
}

export interface Mounted
{
    cart: Resource<Cart>;

    /** Every distinct count the resource showed, in order. */
    timeline: number[];
    dispose: () => void;
}

/** A resource over the cart in its own root; `beside` runs first in that root, a router say. */
export function mount(getCart: CartFetcher, beside?: () => void): Mounted
{
    let dispose!: () => void;
    const built = createRoot((d) =>
    {
        dispose = d;
        beside?.();
        const cart = createResource(getCart);
        const timeline: number[] = [];
        createEffect(() =>
        {
            const value = cart.data();
            if (value !== undefined && timeline[timeline.length - 1] !== value.count)
            {
                timeline.push(value.count);
            }
        });
        return { cart, timeline };
    });
    return { ...built, dispose };
}

export const inc = (n: number): number => n + 1;
export const double = (n: number): number => n * 2;
export const add10 = (n: number): number => n + 10;

export interface Op
{
    op: (n: number) => number;
}

export interface AdderOptions
{
    invalidates?: readonly AnyCachedFetcher[];

    /** Projects over a base that never loaded instead of reading its count. */
    tolerant?: boolean;

    /** Applies the op twice per run: twice on the server, and as two patches of the cart. */
    twice?: boolean;
}

/** A mutation whose write applies `op` on the server and whose guess applies it to the cart. */
export function adder(server: GatedServer, getCart: CartFetcher, options: AdderOptions = {}): Mutation<Op, number>
{
    const tolerant = options.tolerant === true;
    const twice = options.twice === true;
    return createMutation
    (
        (input: Op, signal: AbortSignal) => server.post(twice ? (n) => input.op(input.op(n)) : input.op, signal),
        {
            optimistic: (input, patch) =>
            {
                const guess = (cart: Cart | undefined): Cart => ({ count: input.op(tolerant ? cart?.count ?? 0 : cart!.count) });
                patch(getCart, guess);
                if (twice)
                {
                    patch(getCart, guess);
                }
            },
            ...(options.invalidates === undefined ? {} : { invalidates: options.invalidates })
        }
    );
}

export interface PairSpec
{
    tag: string;
    start: number;
    slow: (n: number) => number;
    fast: (n: number) => number;
    slowOutcome: 'ok' | 'fail' | 'cancel';
    empty?: boolean;

    /** A fire-and-forget revalidate between the two landings, as a poll or a focus refresh. */
    foreign?: boolean;

    /** The server applies the slow write before the fast one lands and answers it last. */
    slowCommitsFirst?: boolean;
    explicitRevalidate?: boolean;
    beside?: () => void;
}

export interface PairOutcome
{
    timeline: number[];
    final: number | undefined;
    server: number;
    slow: 'ok' | 'failed' | 'cancelled';
    afterExplicitRevalidate: number | undefined;
}

/** Two parallel runs of one mutation where the second-called run lands first. */
export async function parallelPair(spec: PairSpec): Promise<PairOutcome>
{
    const server = new GatedServer(spec.start);
    const getCart = cartFamily(server, spec.tag);
    const m = mount(getCart, spec.beside);
    await server.releaseGet(0);
    const mutation = adder(server, getCart, spec.empty === true ? { invalidates: [] } : {});
    const slowSignal = new AbortController();
    const slow = mutation.run({ op: spec.slow }, { signal: slowSignal.signal });
    const fast = mutation.run({ op: spec.fast });
    const slowPost = await server.postArrived(0);
    const fastPost = await server.postArrived(1);
    if (spec.slowCommitsFirst === true)
    {
        slowPost.commit();
    }
    fastPost.release();
    await fast;
    await turns();
    if (spec.foreign === true)
    {
        void revalidate(getCart);
        await turns();
    }
    // Every fetch begun so far answers before the slow write does.
    for (const get of server.pending())
    {
        get.release();
        await turns();
    }
    if (spec.slowOutcome === 'ok')
    {
        slowPost.release();
    }
    else if (spec.slowOutcome === 'fail')
    {
        slowPost.refuse();
    }
    else
    {
        slowSignal.abort();
    }
    const slowResult = await slow;
    await server.drain();
    const final = m.cart.data()?.count;
    let afterExplicitRevalidate: number | undefined;
    if (spec.explicitRevalidate === true)
    {
        const again = revalidate(getCart);
        await server.drain();
        await again;
        afterExplicitRevalidate = m.cart.data()?.count;
    }
    const outcome = slowResult.ok ? 'ok' : slowResult.cancelled === true ? 'cancelled' : 'failed';
    m.dispose();
    return { timeline: [...m.timeline], final, server: server.count, slow: outcome, afterExplicitRevalidate };
}

/** The cache entry behind an argument-less family, for the bookkeeping no public read shows. */
export function entryOf(fetcher: CachedFetcher<[], unknown>): CacheEntry | undefined
{
    const family = cachedFamilyOf(fetcher);
    const cache = getDataCache();
    return family === null || cache === null ? undefined : cache.peek(family, []);
}
