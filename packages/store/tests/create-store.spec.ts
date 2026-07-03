// @vitest-environment node
//
// Full behavioral coverage for createStore (create-store.ts): the lazy-singleton
// store factory. Verifies single-run factory + cached identity, shared reactive
// state, effect/memo ownership inside the internal createRoot, store composition,
// SSR scope isolation via runInStoreScope, and the null/undefined caching edge.
// Real execution - the genuine reactivity core drives every assertion, no mocks.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createMemo,
    createEffect,
    createRoot,
    runInStoreScope,
    getStoreScope,
    subscriberCount
} from '@azerothjs/reactivity';
import { createStore } from '@azerothjs/store';

describe('createStore - lazy singleton', () =>
{
    it('runs the factory at most once, on the first useStore() call', () =>
    {
        let factoryRuns = 0;
        const useStore = createStore(() =>
        {
            factoryRuns++;
            const [count, setCount] = createSignal(0);
            return { count, setCount };
        });

        expect(factoryRuns).toBe(0); // lazy: nothing built until first use

        useStore();
        expect(factoryRuns).toBe(1);

        useStore();
        useStore();
        expect(factoryRuns).toBe(1); // never re-runs within the same scope
    });

    it('returns the SAME instance object on every call within a scope', () =>
    {
        const useStore = createStore(() =>
        {
            const [value] = createSignal('x');
            return { value };
        });

        const a = useStore();
        const b = useStore();
        const c = useStore();

        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('shares state: a mutation through one reference is visible through another', () =>
    {
        const useStore = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            return { count, inc: () => setCount((n) => n + 1) };
        });

        const refA = useStore();
        const refB = useStore();

        refA.inc();
        refA.inc();

        // Same underlying signal - the second reference observes the writes.
        expect(refB.count()).toBe(2);
        expect(refA.count()).toBe(refB.count());
    });
});

describe('createStore - reactivity & ownership', () =>
{
    it('a store signal drives an external reader effect', () =>
    {
        const useStore = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            return { count, inc: () => setCount((n) => n + 1) };
        });

        const store = useStore();
        const seen: number[] = [];

        // The reader effect needs its own owner; mirror real consumer code.
        createRoot(() =>
        {
            createEffect(() =>
            {
                seen.push(store.count());
            });
        });

        expect(seen).toEqual([0]); // effects run once on creation

        store.inc();
        store.inc();
        expect(seen).toEqual([0, 1, 2]); // each store mutation propagates
    });

    it('a method updating a signal notifies a reader that depends on it', () =>
    {
        const useStore = createStore(() =>
        {
            const [name, setName] = createSignal('anon');
            return { name, rename: (next: string) => setName(next) };
        });

        const store = useStore();
        let latest = '';
        createRoot(() =>
        {
            createEffect(() =>
            {
                latest = store.name();
            });
        });

        expect(latest).toBe('anon');
        store.rename('ada');
        expect(latest).toBe('ada');
    });

    it('an internal createMemo computes eagerly and tracks its source signal', () =>
    {
        let memoComputes = 0;
        const useStore = createStore(() =>
        {
            const [count, setCount] = createSignal(2);
            const doubled = createMemo(() =>
            {
                memoComputes++;
                return count() * 2;
            });
            return { count, doubled, inc: () => setCount((n) => n + 1) };
        });

        const store = useStore();
        // Eager first compute happens during factory execution (inside the root).
        expect(memoComputes).toBe(1);
        expect(store.doubled()).toBe(4);

        store.inc(); // 2 -> 3
        expect(store.doubled()).toBe(6);
        expect(memoComputes).toBe(2);
    });

    it('the internal createRoot owns the factory effects (they are live, not no-ops)', () =>
    {
        const [external, setExternal] = createSignal(0);
        const runs: number[] = [];
        const useStore = createStore(() =>
        {
            // An effect declared inside the factory must have a real owner so it
            // actually subscribes - proving the factory ran inside a createRoot.
            createEffect(() =>
            {
                runs.push(external());
            });
            return {};
        });

        useStore();
        expect(runs).toEqual([0]); // effect ran once at creation

        // It is genuinely subscribed to the external signal, not a dead no-op.
        expect(subscriberCount(external)).toBe(1);
        setExternal(1);
        expect(runs).toEqual([0, 1]);
    });
});

describe('createStore - composition', () =>
{
    it('one store factory consuming another shares the inner instance', () =>
    {
        let userFactoryRuns = 0;
        const useUser = createStore(() =>
        {
            userFactoryRuns++;
            const [name, setName] = createSignal('guest');
            return { name, setName };
        });

        const useGreeting = createStore(() =>
        {
            const user = useUser(); // compose: pull the inner store
            const greeting = createMemo(() => `hi ${ user.name() }`);
            return { greeting, user };
        });

        const greetingStore = useGreeting();
        const directUser = useUser();

        // The composed store and a direct consumer reference the SAME inner instance.
        expect(greetingStore.user).toBe(directUser);
        expect(userFactoryRuns).toBe(1); // inner factory ran exactly once

        expect(greetingStore.greeting()).toBe('hi guest');
        directUser.setName('ada'); // mutate via the direct reference
        expect(greetingStore.greeting()).toBe('hi ada'); // composed memo sees it
    });
});

describe('createStore - SSR scope isolation', () =>
{
    it('the client default scope yields a stable app-wide singleton', () =>
    {
        const useStore = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            return { count, setCount };
        });

        const a = useStore();
        const b = useStore();
        expect(a).toBe(b);

        // getStoreScope is stable outside any runInStoreScope.
        expect(getStoreScope()).toBe(getStoreScope());
    });

    it('two runInStoreScope renders produce DISTINCT instances with independent state', () =>
    {
        const useStore = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            return { count, inc: () => setCount((n) => n + 1) };
        });

        const requestA = runInStoreScope(() =>
        {
            const store = useStore();
            store.inc();
            store.inc();
            return store;
        });

        const requestB = runInStoreScope(() =>
        {
            const store = useStore();
            store.inc();
            return store;
        });

        // Per-request isolation: different instances, no cross-request leakage.
        expect(requestA).not.toBe(requestB);
        expect(requestA.count()).toBe(2);
        expect(requestB.count()).toBe(1);
    });

    it('the same scope returns the same instance; a nested scope is isolated', () =>
    {
        let factoryRuns = 0;
        const useStore = createStore(() =>
        {
            factoryRuns++;
            const [count] = createSignal(0);
            return { count };
        });

        runInStoreScope(() =>
        {
            const first = useStore();
            const second = useStore();
            expect(first).toBe(second); // same scope -> same instance

            const nested = runInStoreScope(() => useStore());
            expect(nested).not.toBe(first); // fresh nested scope -> new instance
        });

        // One run per distinct scope: the outer scope + the nested scope = 2.
        expect(factoryRuns).toBe(2);
    });

    it('a client instance and an SSR-scope instance are distinct', () =>
    {
        const useStore = createStore(() =>
        {
            const [count] = createSignal(0);
            return { count };
        });

        const client = useStore();
        const ssr = runInStoreScope(() => useStore());
        expect(ssr).not.toBe(client);

        // After the SSR scope returns, the client scope still serves its singleton.
        expect(useStore()).toBe(client);
    });
});

describe('createStore - edge cases', () =>
{
    it('caches a factory that returns null exactly once', () =>
    {
        let factoryRuns = 0;
        const useStore = createStore<null>(() =>
        {
            factoryRuns++;
            return null;
        });

        expect(useStore()).toBe(null);
        expect(useStore()).toBe(null);
        expect(factoryRuns).toBe(1); // `has`, not a truthy check
    });

    it('caches a factory that returns undefined exactly once', () =>
    {
        let factoryRuns = 0;
        const useStore = createStore<undefined>(() =>
        {
            factoryRuns++;
            return undefined;
        });

        expect(useStore()).toBe(undefined);
        expect(useStore()).toBe(undefined);
        expect(factoryRuns).toBe(1);
    });

    it('keeps separate factories independent within one scope', () =>
    {
        const useA = createStore(() =>
        {
            const [value, setValue] = createSignal('a');
            return { value, setValue };
        });
        const useB = createStore(() =>
        {
            const [value, setValue] = createSignal('b');
            return { value, setValue };
        });

        const a = useA();
        const b = useB();

        expect(a).not.toBe(b); // distinct WeakMaps, distinct instances
        a.setValue('a2');
        expect(a.value()).toBe('a2');
        expect(b.value()).toBe('b'); // unaffected by sibling store
    });
});
