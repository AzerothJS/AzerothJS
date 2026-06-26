// @vitest-environment happy-dom
//
// Re-export integrity for the @azerothjs/core umbrella. core has no implementation of
// its own: it MUST forward every public runtime value from the originating package
// unchanged. For an umbrella, a dropped or renamed re-export is a real regression that
// silently breaks `import { x } from '@azerothjs/core'`, so each value is asserted to be
// (a) defined and (b) the SAME reference as the export from its source package. A pure
// star-re-export or a typo in a named re-export would fail these identity checks.
import { describe, it, expect } from 'vitest';

import * as core from '@azerothjs/core';
import * as reactivity from '@azerothjs/reactivity';
import * as renderer from '@azerothjs/renderer';
import * as component from '@azerothjs/component';
import * as store from '@azerothjs/store';
import * as form from '@azerothjs/form';
import * as router from '@azerothjs/router';
import * as server from '@azerothjs/server';

// Each tuple is [exported-name, source-namespace]. Driven off the ACTUAL list in
// packages/core/src/index.ts - value exports only (types erase at runtime and cannot be
// reference-checked). Update this table only if core's index actually changes.
const reExports: Array<[string, Record<string, unknown>]> = [
    // Reactivity
    ['createSignal', reactivity],
    ['createEffect', reactivity],
    ['createMemo', reactivity],
    ['batch', reactivity],
    ['untrack', reactivity],
    ['on', reactivity],
    ['onCleanup', reactivity],
    ['onRootDispose', reactivity],
    ['createRoot', reactivity],
    ['createDeferred', reactivity],
    ['createSelector', reactivity],
    ['createResource', reactivity],
    ['createStream', reactivity],
    ['catchError', reactivity],
    ['onUncaughtError', reactivity],
    ['getRenderMode', reactivity],
    ['isStringMode', reactivity],
    ['isHydrating', reactivity],
    ['runInMode', reactivity],
    ['getStoreScope', reactivity],
    ['runInStoreScope', reactivity],

    // Renderer
    ['h', renderer],
    ['render', renderer],
    ['hydrate', renderer],
    ['hydrateIslands', renderer],
    ['Show', renderer],
    ['For', renderer],
    ['Switch', renderer],
    ['Match', renderer],
    ['Portal', renderer],
    ['destroyPortal', renderer],
    ['Dynamic', renderer],
    ['Suspense', renderer],
    ['Transition', renderer],
    ['createRef', renderer],
    ['classList', renderer],
    ['styleMap', renderer],
    ['css', renderer],
    ['collectStyleSheet', renderer],
    ['resetStyleSheet', renderer],

    // Compiler-emitted runtime (@internal but still re-exported so compiled output resolves)
    ['tmpl', renderer],
    ['bindHole', renderer],
    ['bindSlot', renderer],
    ['bindProps', renderer],
    ['setProp', renderer],

    // Component
    ['destroyComponent', component],
    ['ErrorBoundary', component],

    // Store
    ['createStore', store],

    // Form
    ['createForm', form],
    ['required', form],
    ['minLength', form],
    ['maxLength', form],
    ['min', form],
    ['max', form],
    ['pattern', form],
    ['email', form],
    ['url', form],
    ['oneOf', form],
    ['combine', form],
    ['phone', form],
    ['countries', form],
    ['getCountry', form],

    // Router
    ['createRouter', router],
    ['createBrowserHistory', router],
    ['createMemoryHistory', router],
    ['compilePath', router],
    ['parseQuery', router],
    ['stringifyQuery', router],
    ['targetToFullPath', router],
    ['Link', router],
    ['Routes', router],
    ['Outlet', router],
    ['useRoute', router],
    ['useMatch', router],
    ['useParams', router],
    ['useQuery', router],
    ['useNavigate', router],
    ['useLoader', router],

    // Server (SSR)
    ['renderToString', server],
    ['renderToStaticMarkup', server],
    ['renderToDocument', server]
];

describe('@azerothjs/core re-export integrity', () =>
{
    it.each(reExports)('re-exports "%s" as the same reference as its source package', (name, source) =>
    {
        const reExported = (core as Record<string, unknown>)[name];
        const original = source[name];

        // Source package actually exports it (guards against a typo in this test table).
        expect(original, `source package is missing "${ name }"`).toBeDefined();
        // core forwards it (guards against a dropped re-export).
        expect(reExported, `core dropped the re-export "${ name }"`).toBeDefined();
        // Same reference - not a wrapper, copy, or shadowing local.
        expect(reExported).toBe(original);
    });

    it('exposes every value listed in the re-export table', () =>
    {
        // The table itself is the contract; this asserts none are silently undefined,
        // independent of the per-row .each above (a single roll-up signal).
        const missing = reExports
            .map(([name]) => name)
            .filter((name) => (core as Record<string, unknown>)[name] === undefined);
        expect(missing).toEqual([]);
    });

    it('re-exports callables as functions (not accidentally a value snapshot)', () =>
    {
        // Everything in the table except the `countries` dataset is a function. A broken
        // re-export that resolved to `undefined` or a non-callable would slip past a mere
        // `toBeDefined`, so spot-check callability across the whole surface.
        for (const [name] of reExports)
        {
            if (name === 'countries')
            {
                continue;
            }
            expect(typeof (core as Record<string, unknown>)[name], `"${ name }" should be a function`).toBe('function');
        }

        // The one non-function value export: the countries dataset is an array.
        expect(Array.isArray(core.countries)).toBe(true);
        expect(core.countries.length).toBeGreaterThan(0);
    });
});
