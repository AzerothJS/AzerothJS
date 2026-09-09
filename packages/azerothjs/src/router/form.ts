/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `<Form>`: the form half of a page action, enhanced when there is JS and correct when there
 * is not.
 *
 * Rendered, it is an ordinary `<form method="post">` carrying the CSRF token in a hidden
 * field. Nothing about that needs the client: a browser with scripting off posts it natively,
 * the page action runs, and the answer is a 303 back to the page or a 422 re-render.
 *
 * With JS the submit is intercepted and sent as a fetch instead, which asks the SAME action
 * for its JSON representation. A success revalidates the page's loaders in place - no reload,
 * no lost scroll position, no flash - and a refusal lands in `useActionResult()`, exactly where
 * the server render puts it. The component the page renders is therefore identical in both
 * modes, and the difference is a navigation the enhanced path does not make.
 *
 * The token comes from the handoff when the server rendered this page, because a render has no
 * `document.cookie` to read and, on a visitor's first load, no cookie exists yet - the host
 * mints one for that response and the form must carry that same value. After a client
 * navigation there IS a cookie, and it is read directly.
 */

import type { MountNode } from '../component/index.ts';
import { createSignal, untrack } from '../reactivity/index.ts';
import { h } from '../renderer/h.ts';
import type { Router } from './router.ts';
import { resolveRouter } from './provider.ts';
import { acceptRedirectTarget } from './redirect-target.ts';

/** The hidden field a page action reads its CSRF token from; mirrors the server's `CSRF_FIELD`. */
const CSRF_FIELD = '_csrf';

/** Props for {@link Form}. */
export interface FormProps
{
    /** The router whose page this posts to; omit inside a `<RouterProvider>`. */
    router?: Router;

    /**
     * Where to post. Defaults to the current pathname, which is the page's own action - the
     * ordinary case, since the action is declared on the route being rendered.
     */
    action?: string;

    /** The form's fields and controls. */
    children?: MountNode;

    /**
     * Runs after an enhanced submit settles, with the action's outcome: `{ ok: true }` when the
     * write landed (with `redirect` when the action sent the visitor elsewhere), `{ ok: false,
     * result }` when the action refused the values, and a bare `{ ok: false }` when the server
     * refused the submit before it reached the action - a guard, the CSRF check, a fault. Never
     * called on the native path, where the answer is a navigation rather than a value.
     */
    onSettled?: (outcome: { ok: boolean; result?: unknown; redirect?: string }) => void;

    /** Anything else lands on the `<form>` element: `class`, `id`, `aria-*`. */
    [key: string]: unknown;
}

/** @internal Reads the CSRF cookie a browser holds; empty on the server, where there is none. */
function cookieToken(): string
{
    const cookies = (globalThis as { document?: { cookie?: string } }).document?.cookie;
    if (cookies === undefined)
    {
        return '';
    }
    for (const pair of cookies.split(';'))
    {
        const at = pair.indexOf('=');
        const name = pair.slice(0, at).trim();
        if (name === 'azcsrf' || name === '__Host-azcsrf')
        {
            return pair.slice(at + 1);
        }
    }
    return '';
}

/**
 * A form that posts to its page's action, natively without JS and by fetch with it.
 *
 * @param props - See {@link FormProps}.
 * @returns The `<form>` element.
 * @example
 * <Form>
 *     <input name="text" />
 *     <button type="submit">Add</button>
 * </Form>
 */
export function Form(props: FormProps): MountNode
{
    const router = resolveRouter(props.router, 'Form');
    const { router: _router, action, children, onSettled, ...rest } = props;
    const [submitting, setSubmitting] = createSignal(false);

    const target = (): string => action ?? untrack(() => router.location().pathname);
    // The server's token while it is the one that rendered this page, the browser's cookie
    // after a client navigation. The seeded value is the only one that exists on a first load.
    const token = (): string => router.csrfToken() || cookieToken();

    /**
     * The submit did not reach the action's own answer - a guard, the CSRF check, a fault, or a
     * reply this page will not act on. The last validation verdict stays on screen, because it is
     * still the truth about the values the visitor is looking at, and the reason is reported once.
     */
    function refuse(reason: string): void
    {
        if (typeof console !== 'undefined')
        {
            console.error(`[azerothjs/Form] the submit was refused: ${ reason }.`);
        }
        onSettled?.({ ok: false });
    }

    async function submit(event: Event): Promise<void>
    {
        event.preventDefault();
        const element = event.currentTarget as HTMLFormElement;
        setSubmitting(true);
        try
        {
            const response = await fetch(target(), {
                method: 'POST',
                // Asking for JSON is what selects the enhanced representation: the same action
                // answers a value here and a redirect-or-rendered-page to a native submit.
                headers: { accept: 'application/json' },
                body: new URLSearchParams(new FormData(element) as unknown as Record<string, string>),
                credentials: 'same-origin'
            });
            // Exactly three answers are the action's own; everything else is a refusal by the
            // server that never reached validation.
            const outcome = await response.json().catch(() => null) as { ok?: unknown; result?: unknown; redirect?: unknown } | null;
            if (outcome !== null && outcome.ok === true)
            {
                if ('redirect' in outcome)
                {
                    // The action sent the visitor elsewhere. `router.navigate` performs an
                    // off-origin target rather than refusing one, so this is a redirect boundary
                    // like any other and it is judged here, by the same rule the guard and loader
                    // boundaries use. A malformed or off-origin value is a refusal, not a
                    // navigation: the server that sent it is not one this page should follow.
                    const judged = typeof outcome.redirect === 'string'
                        ? acceptRedirectTarget(outcome.redirect)
                        : { accepted: false as const, target: String(outcome.redirect) };
                    if (!judged.accepted)
                    {
                        refuse(`the redirect target "${ judged.target }" leaves this origin`);
                        return;
                    }
                    onSettled?.({ ok: true, redirect: outcome.redirect as string });
                    router.navigate(judged.to);
                    return;
                }
                // The write landed, so what the page reads is stale. Revalidating in place is
                // the whole gain over the native path: same scroll, same focus, no reload.
                router.setActionResult(undefined);
                await router.revalidate();
                onSettled?.({ ok: true });
                return;
            }
            if (outcome !== null && outcome.ok === false && 'result' in outcome)
            {
                // The same slot the server render fills, so `useActionResult()` reads one thing.
                router.setActionResult(outcome.result);
                onSettled?.({ ok: false, result: outcome.result });
                return;
            }
            refuse(`the server answered ${ response.status }`);
        }
        catch (error)
        {
            // A transport failure is not a refusal: report it as one and the page would show
            // field errors it never received. Left for the caller, with nothing invented.
            onSettled?.({ ok: false });
            if (typeof console !== 'undefined')
            {
                console.error('[azerothjs/Form] the submit could not be sent.', error);
            }
        }
        finally
        {
            setSubmitting(false);
        }
    }

    return h('form', {
        ...rest,
        method: 'post',
        action: target,
        'data-azeroth-submitting': () => (submitting() ? '' : undefined),
        onSubmit: (event: Event) => void submit(event)
    },
    h('input', { type: 'hidden', name: CSRF_FIELD, value: token }),
    children);
}
