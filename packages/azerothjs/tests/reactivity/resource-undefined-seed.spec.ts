// @vitest-environment happy-dom
//
// createResource decides a seed by its value: an undefined initialValue, and an undefined or null
// initialError, are no seed and the resource fetches. null, 0, '', false and NaN still seed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cached, createEffect, createMemoryHistory, createResource, createRoot, createRouter, h, render, renderToString, Routes, useLoader } from 'azerothjs';
import type { Resource, ResourceOptions, Route, Router } from 'azerothjs';
import { getDataCache, resetDataCache } from 'azerothjs/internal';

let families = 0;
beforeEach(() =>
{
    resetDataCache();
});
afterEach(() =>
{
    resetDataCache();
    document.body.innerHTML = '';
});

const flush = async (): Promise<void> =>
{
    for (let i = 0; i < 6; i++)
    {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

/** A printable tag, so NaN, null and Errors compare by what they are. */
function tag(value: unknown): string
{
    if (value === undefined)
    {
        return 'U';
    }
    if (value === null)
    {
        return 'N';
    }
    if (typeof value === 'number' && Number.isNaN(value))
    {
        return 'NaN';
    }
    if (value instanceof Error)
    {
        return `Error(${ value.message })`;
    }
    return JSON.stringify(value);
}

type Path = 'island' | 'cached';
type Form = 'standalone' | 'source';

interface Counter
{
    fetches: number;
    aborts: number;
}

interface Fetchers
{
    name: string;
    standalone: (signal: AbortSignal) => Promise<string>;
    keyed: (key: string, signal: AbortSignal) => Promise<string>;
}

/** One fetcher of each form, counting calls and aborts; each fetch waits for `gate` to settle. */
function fetchers(path: Path, counter: Counter, options: { gate?: Promise<void>; fresh?: number } = {}): Fetchers
{
    families += 1;
    const name = `seed.${ families }`;
    const run = async (signal: AbortSignal): Promise<string> =>
    {
        counter.fetches += 1;
        signal.addEventListener('abort', () =>
        {
            counter.aborts += 1;
        });
        if (options.gate !== undefined)
        {
            await options.gate;
        }
        return 'fetched';
    };
    const keyed = (_key: string, signal: AbortSignal): Promise<string> => run(signal);
    if (path === 'island')
    {
        return { name, standalone: run, keyed };
    }
    const fresh = { fresh: options.fresh ?? 0 };
    return { name, standalone: cached(name, run, fresh), keyed: cached(`${ name }.keyed`, keyed, fresh) };
}

interface Reader
{
    resource: Resource<unknown>;
    loadingSeen: boolean[];
    dispose: () => void;
}

/** A resource over `source` with `bag`, in a root of its own. */
function read(source: Fetchers, form: Form, bag: ResourceOptions<unknown> | undefined): Reader
{
    const loadingSeen: boolean[] = [];
    let resource!: Resource<unknown>;
    let dispose!: () => void;
    createRoot((d) =>
    {
        dispose = d;
        resource = form === 'standalone'
            ? createResource<unknown>(source.standalone, bag)
            : createResource<unknown, string>(() => 'k', source.keyed, bag);
        createEffect(() =>
        {
            loadingSeen.push(resource.loading());
        });
    });
    return { resource, loadingSeen, dispose };
}

const state = (reader: Reader): { data: string; error: string } =>
    ({ data: tag(reader.resource.data()), error: tag(reader.resource.error()) });

const entryOf = (source: Fetchers): { hasValue: boolean; value: string; inflight: boolean } | null =>
{
    const entry = getDataCache()?.allEntries().find((candidate) => candidate.key.startsWith(`${ source.name }|`));
    return entry === undefined ? null : { hasValue: entry.hasValue, value: tag(entry.value), inflight: entry.inflight !== null };
};

const PATHS: Path[] = ['island', 'cached'];
const FORMS: Form[] = ['standalone', 'source'];

describe('an undefined seed is no seed', () =>
{
    const shapes: Array<[string, () => ResourceOptions<unknown>]> = [
        ['initialValue undefined', () => ({ initialValue: undefined })],
        ['initialError undefined', () => ({ initialError: undefined })],
        ['initialError null', () => ({ initialError: null })],
        ['initialValue undefined beside initialError null', () => ({ initialValue: undefined, initialError: null })]
    ];
    for (const path of PATHS)
    {
        for (const form of FORMS)
        {
            for (const [name, bag] of shapes)
            {
                it(`${ path } ${ form }: ${ name } fetches once, reports no failure and lands the data`, async () =>
                {
                    const counter = { fetches: 0, aborts: 0 };
                    const source = fetchers(path, counter);
                    const reader = read(source, form, bag());
                    const atStart = tag(reader.resource.error());
                    await flush();
                    const end = state(reader);
                    reader.dispose();
                    expect({ atStart, fetches: counter.fetches, loadingSeen: reader.loadingSeen, ...end })
                        .toEqual({ atStart: 'N', fetches: 1, loadingSeen: [true, false], data: '"fetched"', error: 'N' });
                });
            }

            it(`${ path } ${ form }: a value beside initialError undefined is a value seed, with no failure`, async () =>
            {
                const counter = { fetches: 0, aborts: 0 };
                const reader = read(fetchers(path, counter), form, { initialValue: 's', initialError: undefined });
                await flush();
                const end = state(reader);
                reader.dispose();
                expect({ fetches: counter.fetches, ...end }).toEqual({ fetches: 0, data: '"s"', error: 'N' });
            });
        }
    }

    for (const form of FORMS)
    {
        it(`cached ${ form }: a value beside initialError null goes into the shared entry, so a second reader does not fetch`, async () =>
        {
            const counter = { fetches: 0, aborts: 0 };
            const source = fetchers('cached', counter);
            const first = read(source, form, { initialValue: 'm', initialError: null });
            await flush();
            const second = read(source, form, undefined);
            await flush();
            const seen = { fetches: counter.fetches, first: state(first), second: state(second) };
            first.dispose();
            second.dispose();
            expect(seen).toEqual({ fetches: 0, first: { data: '"m"', error: 'N' }, second: { data: '"m"', error: 'N' } });
        });
    }

    it('a server render reads error() as null for an initialError of undefined', () =>
    {
        const html = renderToString(() =>
        {
            const resource = createResource<string>(async () => 'fetched', { initialError: undefined });
            return h('p', {}, () => `${ tag(resource.data()) }|${ tag(resource.error()) }`);
        });
        expect(html.replace(/<!--[^]*?-->/g, '')).toBe('<p>U|N</p>');
    });
});

describe('CONTROL: a seed that is a value still seeds', () =>
{
    const values: Array<[string, unknown]> = [['null', null], ['0', 0], ['an empty string', ''], ['false', false], ['NaN', NaN]];
    for (const path of PATHS)
    {
        for (const form of FORMS)
        {
            for (const [name, value] of values)
            {
                it(`CONTROL: ${ path } ${ form }: initialValue ${ name } seeds with no fetch${ path === 'cached' ? ', and a second reader shares it' : '' }`, async () =>
                {
                    const counter = { fetches: 0, aborts: 0 };
                    const source = fetchers(path, counter);
                    const first = read(source, form, { initialValue: value });
                    await flush();
                    const second = path === 'cached' ? read(source, form, undefined) : null;
                    await flush();
                    const seen = { fetches: counter.fetches, loadingSeen: first.loadingSeen, first: state(first), second: second === null ? null : state(second) };
                    first.dispose();
                    second?.dispose();
                    const want = { data: tag(value), error: 'N' };
                    expect(seen).toEqual({ fetches: 0, loadingSeen: [false], first: want, second: path === 'cached' ? want : null });
                });
            }

            for (const [name, failure] of [['0', 0], ['an empty string', ''], ['false', false], ['an Error', new Error('server said no')]] as Array<[string, unknown]>)
            {
                it(`CONTROL: ${ path } ${ form }: initialError ${ name } is a failure seed with no fetch`, async () =>
                {
                    const counter = { fetches: 0, aborts: 0 };
                    const reader = read(fetchers(path, counter), form, { initialError: failure });
                    await flush();
                    const end = state(reader);
                    reader.dispose();
                    expect({ fetches: counter.fetches, ...end }).toEqual({ fetches: 0, data: 'U', error: tag(failure) });
                });
            }

            it(`CONTROL: ${ path } ${ form }: no options, an empty bag and a name alone each fetch once`, async () =>
            {
                for (const bag of [undefined, {}, { name: 'r' }])
                {
                    const counter = { fetches: 0, aborts: 0 };
                    const reader = read(fetchers(path, counter), form, bag);
                    await flush();
                    const end = state(reader);
                    reader.dispose();
                    resetDataCache();
                    expect({ fetches: counter.fetches, ...end }).toEqual({ fetches: 1, data: '"fetched"', error: 'N' });
                }
            });
        }
    }

    it('CONTROL: island: a value beside initialError null seeds that value', async () =>
    {
        const counter = { fetches: 0, aborts: 0 };
        const reader = read(fetchers('island', counter), 'standalone', { initialValue: 'm', initialError: null });
        await flush();
        const end = state(reader);
        reader.dispose();
        expect({ fetches: counter.fetches, ...end }).toEqual({ fetches: 0, data: '"m"', error: 'N' });
    });

    it('CONTROL: a server render reads a failure seed as written', () =>
    {
        const html = renderToString(() =>
        {
            const resource = createResource<string>(async () => 'fetched', { initialError: new Error('down') });
            return h('p', {}, () => `${ tag(resource.data()) }|${ tag(resource.error()) }`);
        });
        expect(html.replace(/<!--[^]*?-->/g, '')).toBe('<p>U|Error(down)</p>');
    });
});

describe('an undefined seed on a cached fetcher', () =>
{
    it('is not written into the shared entry while the fetch is in flight', () =>
    {
        const counter = { fetches: 0, aborts: 0 };
        const source = fetchers('cached', counter);
        const reader = read(source, 'standalone', { initialValue: undefined });
        const entry = entryOf(source);
        reader.dispose();
        expect({ entry, fetches: counter.fetches }).toEqual({ entry: { hasValue: false, value: 'U', inflight: true }, fetches: 1 });
    });

    it('leaves a second plain reader sharing the one fetch', async () =>
    {
        const counter = { fetches: 0, aborts: 0 };
        const source = fetchers('cached', counter);
        const first = read(source, 'standalone', { initialValue: undefined });
        await flush();
        const second = read(source, 'standalone', undefined);
        await flush();
        const seen = { fetches: counter.fetches, first: state(first), second: state(second) };
        first.dispose();
        second.dispose();
        expect(seen).toEqual({ fetches: 1, first: { data: '"fetched"', error: 'N' }, second: { data: '"fetched"', error: 'N' } });
    });

    it('does not abort the fetch of a sibling that is in flight', async () =>
    {
        let release!: () => void;
        const gate = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        const counter = { fetches: 0, aborts: 0 };
        const source = fetchers('cached', counter, { gate });
        const first = read(source, 'standalone', undefined);
        await Promise.resolve();
        const second = read(source, 'standalone', { initialValue: undefined });
        release();
        await flush();
        const seen = { fetches: counter.fetches, aborts: counter.aborts, first: state(first).data, second: state(second).data };
        first.dispose();
        second.dispose();
        expect(seen).toEqual({ fetches: 1, aborts: 0, first: '"fetched"', second: '"fetched"' });
    });

    it('leaves a later page within the fresh window reading the real value', async () =>
    {
        const counter = { fetches: 0, aborts: 0 };
        const source = fetchers('cached', counter, { fresh: 60_000 });
        const first = read(source, 'standalone', { initialValue: undefined });
        await flush();
        first.dispose();
        await flush();
        const later = read(source, 'standalone', undefined);
        await flush();
        const data = state(later).data;
        later.dispose();
        expect(data).toBe('"fetched"');
    });

    it('lets a reader created after the seeded page was disposed mid-flight fetch the value', async () =>
    {
        let release!: () => void;
        const gate = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        const counter = { fetches: 0, aborts: 0 };
        const source = fetchers('cached', counter, { gate, fresh: 60_000 });
        const first = read(source, 'standalone', { initialValue: undefined });
        await Promise.resolve();
        first.dispose();
        await flush();
        release();
        const later = read(source, 'standalone', undefined);
        await flush();
        const data = state(later).data;
        later.dispose();
        expect(data).toBe('"fetched"');
    });

    it('CONTROL: two plain readers share one fetch', async () =>
    {
        const counter = { fetches: 0, aborts: 0 };
        const source = fetchers('cached', counter);
        const first = read(source, 'standalone', undefined);
        const second = read(source, 'standalone', undefined);
        await flush();
        const seen = { fetches: counter.fetches, second: state(second).data };
        first.dispose();
        second.dispose();
        expect(seen).toEqual({ fetches: 1, second: '"fetched"' });
    });

    it('CONTROL: a plain sibling created mid-flight joins the fetch and nothing is aborted', async () =>
    {
        let release!: () => void;
        const gate = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        const counter = { fetches: 0, aborts: 0 };
        const source = fetchers('cached', counter, { gate });
        const first = read(source, 'standalone', undefined);
        await Promise.resolve();
        const second = read(source, 'standalone', undefined);
        release();
        await flush();
        const seen = { fetches: counter.fetches, aborts: counter.aborts, first: state(first).data, second: state(second).data };
        first.dispose();
        second.dispose();
        expect(seen).toEqual({ fetches: 1, aborts: 0, first: '"fetched"', second: '"fetched"' });
    });
});

describe('an option getter is read once', () =>
{
    /** A getter that hands `seed` over on its first read only. */
    function once<T>(log: string[], name: string, seed: T): () => T | undefined
    {
        let held: T | undefined = seed;
        return () =>
        {
            log.push(name);
            const handed = held;
            held = undefined;
            return handed;
        };
    }

    /** A bag whose getters hand each seed over on the first read only. */
    function takeOnce(log: string[], seeds: { value: string; failure?: Error }): ResourceOptions<unknown>
    {
        const value = once(log, 'initialValue', seeds.value);
        if (seeds.failure === undefined)
        {
            return {
                get initialValue(): string | undefined
                {
                    return value();
                }
            };
        }
        const failure = once(log, 'initialError', seeds.failure);
        return {
            get initialValue(): string | undefined
            {
                return value();
            },
            get initialError(): Error | undefined
            {
                return failure();
            }
        };
    }

    for (const path of PATHS)
    {
        it(`${ path }: a value handed over once is the seed${ path === 'cached' ? ' the shared entry holds' : '' }`, async () =>
        {
            const log: string[] = [];
            const counter = { fetches: 0, aborts: 0 };
            const source = fetchers(path, counter);
            const first = read(source, 'standalone', takeOnce(log, { value: 'seed' }));
            await flush();
            const second = path === 'cached' ? read(source, 'standalone', undefined) : null;
            await flush();
            const seen = { log, fetches: counter.fetches, first: state(first).data, second: second === null ? null : state(second).data };
            first.dispose();
            second?.dispose();
            expect(seen).toEqual({ log: ['initialValue'], fetches: 0, first: '"seed"', second: path === 'cached' ? '"seed"' : null });
        });

        it(`${ path }: a value and a failure handed over once seed the failure from one read of each`, async () =>
        {
            const log: string[] = [];
            const counter = { fetches: 0, aborts: 0 };
            const reader = read(fetchers(path, counter), 'standalone', takeOnce(log, { value: 'both', failure: new Error('seeded') }));
            await flush();
            const seen = { log: [...log].sort(), fetches: counter.fetches, ...state(reader) };
            reader.dispose();
            expect(seen).toEqual({ log: ['initialError', 'initialValue'], fetches: 0, data: '"both"', error: 'Error(seeded)' });
        });
    }
});

describe('a page that seeds its own resource from its route loader', () =>
{
    function mount(seedFromLoader: boolean): { router: Router; container: HTMLElement; fetches: string[] }
    {
        const fetches: string[] = [];
        const Page = (): HTMLElement =>
        {
            const loader = useLoader<string>();
            const fetcher = async (): Promise<string> =>
            {
                fetches.push('detail');
                return 'detail';
            };
            const detail = seedFromLoader
                ? createResource<string>(fetcher, { initialValue: loader.data(), initialError: loader.error() })
                : createResource<string>(fetcher);
            return h('p', { id: 'detail' }, () => detail.data() ?? 'EMPTY');
        };
        const routes: Route[] = [
            { path: '/', component: () => h('p', { id: 'home' }, 'home') },
            { path: '/item', component: Page, loader: async () => 'from-loader' }
        ];
        const container = document.createElement('div');
        document.body.appendChild(container);
        let router!: Router;
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/') });
            return h('div', {}, Routes({ router }));
        }, container);
        return { router, container, fetches };
    }

    it('fetches on a client navigation when it passes initialValue: loader.data() with initialError: loader.error()', async () =>
    {
        const { router, container, fetches } = mount(true);
        await flush();
        router.navigate('/item');
        await flush();
        expect({ fetches, text: container.querySelector('#detail')?.textContent }).toEqual({ fetches: ['detail'], text: 'detail' });
    });

    it('CONTROL: an unseeded page fetches on a client navigation', async () =>
    {
        const { router, container, fetches } = mount(false);
        await flush();
        router.navigate('/item');
        await flush();
        expect({ fetches, text: container.querySelector('#detail')?.textContent }).toEqual({ fetches: ['detail'], text: 'detail' });
    });
});

describe('the source form refuses a third argument that is not an options object', () =>
{
    const fetcher = async (_key: string): Promise<string> => 'fetched';
    const build = (third: unknown) => (): void =>
    {
        createRoot((dispose) =>
        {
            try
            {
                createResource<string, string>(() => 'k', fetcher, third as ResourceOptions<string>);
            }
            finally
            {
                dispose();
            }
        });
    };

    it('throws a TypeError that names what it received', () =>
    {
        expect(build(5)).toThrow(new TypeError('createResource expects an options object as its third argument, received a number.'));
    });

    const thirds: Array<[string, unknown]> = [['a string', 'my-name'], ['null', null], ['true', true], ['an array', []], ['a promise', Promise.resolve({ initialValue: 'x' })]];
    for (const [name, third] of thirds)
    {
        it(`throws that TypeError for ${ name }`, () =>
        {
            expect(build(third)).toThrow(TypeError);
            expect(build(third)).toThrow(/^createResource expects an options object as its third argument, received /);
        });
    }

    it('CONTROL: an undefined third argument and an options object are accepted', () =>
    {
        expect(() => createRoot((dispose) =>
        {
            createResource<string, string>(() => 'k', fetcher, undefined);
            createResource<string, string>(() => 'k', fetcher, { initialValue: 'v' });
            dispose();
        })).not.toThrow();
    });

    it('CONTROL: the standalone form refuses a number as its second argument', () =>
    {
        expect(() => createResource<string>(async () => 'fetched', 5 as never))
            .toThrow(/createResource expects the fetcher or an options object as its second argument, received a number/);
    });
});
