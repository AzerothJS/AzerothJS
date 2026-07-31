// @vitest-environment node
//
// HISTORICAL RECORD, kept as an impossibility proof. Under the old trio, `implement()` keyed
// its handler map relative to the routes it was given while `mountApi` keyed from the contract
// root - so spreading one into the other COMPILED and failed at boot, and the framework grew a
// diagnostic error message to explain its own key-space split. The colocated design has no
// second map: a route's name keys the routes object, the manifest, the client surface, and the
// registered endpoints - one set, written once. This spec pins that the sets cannot disagree.
import { describe, expect, it, expectTypeOf } from 'vitest';

import { App } from '../../src/app.ts';
import { feature } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import type { ClientOf } from '../../src/api/client.ts';
import { object, string } from '@azerothjs/schema';

const issues = feature('/issues', (routes) => ({
    list: routes.get('/', { output: object({ ok: string() }) }, () => ({ ok: 'y' })),
    read: routes.get('/:id', { output: object({ ok: string() }) }, () => ({ ok: 'y' }))
}));

describe('the key space cannot split', () =>
{
    it('routes, manifest, and installed endpoints are the same set - behind a nested prefix too', () =>
    {
        const app = new App({ dev: false });
        const api = register(app, { issues }, { prefix: '/api/v2' });

        const routeKeys = Object.keys(api.issues.routes).sort();
        const manifestKeys = Object.keys(api.issues.manifest()).sort();
        expect(manifestKeys).toEqual(routeKeys);

        const installed = app.routes().filter((line) => line.includes('/api/v2/issues')).length;
        expect(installed).toBe(routeKeys.length);
    });

    it('the client surface has exactly the routes object keys - no map to spread, no key to spell twice', () =>
    {
        type Client = ClientOf<{ issues: typeof issues }>;
        expectTypeOf<keyof Client['issues']>().toEqualTypeOf<'list' | 'read'>();
    });
});
