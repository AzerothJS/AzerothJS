// The CLIENT loader-redirect boundary.
//
// A redirect is consumed at four places: the SSR guard and loader paths (handoff.ts), and
// the client guard and loader paths (router.ts). Three of them run the target through
// `acceptRedirectTarget` and fail closed. The client loader path did not, so an app whose
// loader derived its redirect target from data could be steered off-origin by that data -
// the open-redirect shape, on the one boundary the audit of the other three never reached.
//
// Driven on MEMORY history deliberately. A browser's pushState refuses a cross-origin URL
// with SecurityError, which would mask the policy breach behind a crash and make the arm
// pass for the wrong reason; memory history accepts anything, so what is asserted here is
// the router's own judgement rather than the platform's.
import { describe, it, expect, vi } from 'vitest';
import { createRoot, createRouter, createMemoryHistory, redirect, unsafeUrl } from 'azerothjs';
import type { Route, Router } from 'azerothjs';

const leaf = (): HTMLElement => document.createElement('div');

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function withRouter(routes: Route[], initialUrl: string, fn: (router: Router) => Promise<void>): Promise<void>
{
    let dispose!: () => void;
    let router!: Router;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
    });
    try
    {
        await fn(router);
    }
    finally
    {
        dispose();
    }
}

// A route whose loader throws the given redirect target.
function routesRedirectingTo(to: unknown): Route[]
{
    return [{
        path: '/',
        component: leaf,
        loader: async () =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a redirect sentinel is a branded value, not an Error: throwing it IS the documented API
            throw redirect(to as string);
        }
    }];
}

describe('a loader redirect is judged like a guard redirect', () =>
{
    it('refuses an off-origin absolute URL instead of navigating to it', async () =>
    {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try
        {
            await withRouter(routesRedirectingTo('https://evil.example/'), '/', async (router) =>
            {
                await flush();
                expect(router.location().pathname).toBe('/');
                expect(errors).toHaveBeenCalled();
            });
        }
        finally
        {
            errors.mockRestore();
        }
    });

    it('refuses the OBJECT form, whose pathname is an unconstrained string', async () =>
    {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try
        {
            const routes: Route[] = [{
                path: '/',
                component: leaf,
                loader: async () =>
                {
                    // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
                    throw redirect({ pathname: '//evil.example' });
                }
            }];
            await withRouter(routes, '/', async (router) =>
            {
                await flush();
                expect(router.location().pathname).toBe('/');
                expect(errors).toHaveBeenCalled();
            });
        }
        finally
        {
            errors.mockRestore();
        }
    });

    it('CONTROL: an ordinary in-app redirect still navigates', async () =>
    {
        const routes: Route[] = [
            {
                path: '/',
                component: leaf,
                loader: async () =>
                {
                    // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
                    throw redirect('/login');
                }
            },
            { path: '/login', component: leaf }
        ];
        await withRouter(routes, '/', async (router) =>
        {
            await flush();
            expect(router.location().pathname).toBe('/login');
        });
    });

    // Asserts the UNWRAP only. Deliberately not phrased as 'the app navigates off-origin':
    // memory history stores whatever string it is handed, so an arm claiming that would pass
    // for the wrong reason. A real browser refuses a cross-origin pushState outright, and the
    // document-navigation exit that makes this target actually work is covered against a real
    // History in history.spec.ts.
    it('CONTROL: an author-vetted off-origin target is accepted, with the brand UNWRAPPED', async () =>
    {
        await withRouter(routesRedirectingTo(unsafeUrl('https://ok.example/')), '/', async (router) =>
        {
            await flush();
            // The brand is an OBJECT typed as a string; unwrapped it is the plain URL, and
            // NOT the 'undefined' that reading .pathname off the brand used to produce.
            expect(router.location().pathname).toBe('https://ok.example/');
        });
    });
});
