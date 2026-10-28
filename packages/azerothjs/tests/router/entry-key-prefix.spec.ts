// @vitest-environment happy-dom
//
// The prefix each evaluation of the runtime puts before its entry keys: where its randomness
// comes from, what a host that refuses a source while the module evaluates gets, and its spelling.
import { describe, expect, it, vi } from 'vitest';
import type { HistoryAdapter, Route, Router } from 'azerothjs';

type Runtime = typeof import('azerothjs');

const routes = (): Route[] => ['/p1', '/p2', '/p3'].map((path) => ({ path, component: () => document.createElement('div') }));
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const SPELLING = /^az[0-9a-z]{8}-[1-9][0-9]*$/;

async function evaluate(): Promise<Runtime>
{
    vi.resetModules();
    return await import('azerothjs');
}

function boot(runtime: Runtime, history: HistoryAdapter): { router: Router; dispose: () => void }
{
    let router!: Router;
    let dispose!: () => void;
    runtime.createRoot((d) =>
    {
        dispose = d;
        router = runtime.createRouter({ routes: routes(), history });
    });
    return { router, dispose };
}

/** The keys one router mints on a fresh history: its first entry, then two pushes. */
function mint(runtime: Runtime): string[]
{
    const { router, dispose } = boot(runtime, runtime.createMemoryHistory('/p1'));
    const keys = [router.location().key];
    router.navigate('/p2');
    keys.push(router.location().key);
    router.navigate('/p3');
    keys.push(router.location().key);
    dispose();
    return keys;
}

/** A crypto that refuses getRandomValues at module scope, and one that is not there at all. */
const CRYPTO: Array<[string, () => void]> = [
    ['refuses', () =>
    {
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() =>
        {
            throw new Error('Disallowed operation called within global scope');
        });
    }],
    ['is missing', () =>
    {
        vi.stubGlobal('crypto', undefined);
    }]
];

const refuseRandom = (): void =>
{
    vi.spyOn(Math, 'random').mockImplementation(() =>
    {
        throw new TypeError('Math.random is tamed');
    });
};

/** Evaluates the runtime while `refuse` holds, as on a host refusing a source at module scope. */
async function evaluateRefusing(refuse: () => void): Promise<Runtime>
{
    try
    {
        refuse();
        return await evaluate();
    }
    finally
    {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
}

describe('the entry key prefix', () =>
{
    for (const documents of [true, false])
    {
        const name = documents
            ? 'keeps two evaluations apart when Math.random returns a constant in both, so the push after a reload scrolls to the top'
            : 'CONTROL: one evaluation under a constant Math.random keeps its keys apart, so the push after a reload scrolls to the top';
        it(name, async () =>
        {
            window.scrollTo({ top: 0, left: 0 });
            vi.spyOn(Math, 'random').mockReturnValue(42);
            expect(Math.random()).toBe(42);
            const first = await evaluate();
            const history = first.createMemoryHistory('/p1');
            const before = boot(first, history);
            const left = before.router.location().key;
            before.dispose();
            const after = boot(documents ? await evaluate() : first, history);
            window.scrollTo({ top: 1500, left: 0 });
            after.router.navigate('/p2');
            await flush();
            const pushed = after.router.location().key;
            const y = window.scrollY;
            after.dispose();
            expect(pushed).not.toBe(left);
            expect(y).toBe(0);
        });
    }

    for (const [shape, refuseCrypto] of CRYPTO)
    {
        it(`draws from Math.random when crypto ${ shape } while the module evaluates`, async () =>
        {
            const refuse = (): void =>
            {
                refuseCrypto();
                expect(() => globalThis.crypto.getRandomValues(new Uint32Array(1))).toThrow();
            };
            const keys = [...mint(await evaluateRefusing(refuse)), ...mint(await evaluateRefusing(refuse))];
            expect(new Set(keys).size).toBe(keys.length);
            expect(keys.filter((key) => !SPELLING.test(key))).toEqual([]);
            expect(keys.map((key) => CSS.escape(key))).toEqual(keys);
        });

        it(`imports and keeps its keys unique when crypto ${ shape } and Math.random throws while it evaluates`, async () =>
        {
            const runtime = await evaluateRefusing(() =>
            {
                refuseCrypto();
                refuseRandom();
                expect(() => globalThis.crypto.getRandomValues(new Uint32Array(1))).toThrow();
                expect(() => Math.random()).toThrow();
            });
            const keys = mint(runtime);
            expect(new Set(keys).size).toBe(keys.length);
            expect(keys.filter((key) => !SPELLING.test(key))).toEqual([]);
            expect(keys.map((key) => CSS.escape(key))).toEqual(keys);
        });
    }

    it('spells a key as az, eight base-36 characters, a dash and the count', async () =>
    {
        const keys = [...mint(await evaluate()), ...mint(await evaluate())];
        expect(keys.filter((key) => !SPELLING.test(key))).toEqual([]);
    });

    it('mints keys CSS takes unescaped, as an id, a class or a view-transition-name', async () =>
    {
        const keys = [...mint(await evaluate()), ...mint(await evaluate())];
        expect(keys.map((key) => CSS.escape(key))).toEqual(keys);
    });
});
