// @vitest-environment happy-dom
//
// Stacked guesses whose runs land out of order, in an app with a router beside the cart.
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'azerothjs';
import type { Route } from 'azerothjs';
import { inc, parallelPair } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

function beside(): void
{
    const routes: Route[] = [{ path: '/', component: () => document.createElement('div') }];
    createRouter({ routes, history: createMemoryHistory('/') });
}

describe('two parallel runs, the second-called landing first, with a router', () =>
{
    it('under the default invalidation the confirmed add is never counted twice over refetched data', async () =>
    {
        const r = await parallelPair({ tag: 'pair-default', start: 0, slow: inc, fast: inc, slowOutcome: 'ok', beside });
        expect(Math.max(...r.timeline)).toBeLessThanOrEqual(2);
        expect(r.final).toBe(2);
    });

    it('when the slow run fails after the fast one landed the page ends at the server value', async () =>
    {
        const r = await parallelPair({ tag: 'slow-fails', start: 0, slow: inc, fast: inc, slowOutcome: 'fail', beside });
        expect(r.final).toBe(r.server);
    });
});
