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
 * navigation there IS a cookie, and it is read directly. A page a shared cache may store carries
 * neither, so the enhanced submit asks `/__azeroth/csrf` for the cookie first.
 */

import type { MountNode } from '../component/index.ts';
import { createSignal, untrack } from '../reactivity/index.ts';
import { h } from '../renderer/h.ts';
import type { Router } from './router.ts';
import { resolveRouter } from './provider.ts';
import { acceptRedirectTarget } from './redirect-target.ts';
import { isAbsoluteAppPath } from '../semantics.ts';

/** The hidden field a page action reads its CSRF token from; mirrors the server's `CSRF_FIELD`. */
const CSRF_FIELD = '_csrf';

/** Where `csrfCookie` hands out a token for a page a shared cache served without one. */
const CSRF_TOKEN_PATH = '/__azeroth/csrf';

/** The header in which that answer names the cookie `csrfCookie` compares and its token. */
const CSRF_PAIR_HEADER = 'x-azeroth-csrf-cookie';

/** Props for {@link Form}. */
export interface FormProps
{
    /** The router whose page this posts to; omit inside a `<RouterProvider>`. */
    router?: Router;

    /**
     * Where to post. Defaults to the page's own url, which is the page's own action - the
     * ordinary case, since the action is declared on the route being rendered. An absolute app
     * path gets the router's base like a `<Link>` does; a relative spelling or an external url
     * is used verbatim, so the browser resolves it against the document.
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

/** @internal The cookie `csrfCookie` compares and its token, as its answer named them. */
export interface CsrfPair
{
    cookie: string;
    token: string;
    /** Named to another caller's ask this one joined, which may have reached another server. */
    joined?: boolean;
}

/**
 * @internal Every value the browser shows under `name`, in `document.cookie` order, decoded as the
 * server's cookie parser decodes it.
 */
function jarValues(name: string): string[]
{
    const cookies = (globalThis as { document?: { cookie?: string } }).document?.cookie ?? '';
    return cookies.split(';').flatMap((pair) =>
    {
        const at = pair.indexOf('=');
        if (at <= 0 || pair.slice(0, at).trim() !== name)
        {
            return [];
        }
        try
        {
            return [decodeURIComponent(pair.slice(at + 1))];
        }
        catch
        {
            return [pair.slice(at + 1)];
        }
    });
}

/**
 * @internal The token a write posts, `sure` when it may skip the ask (with the default names only
 * a lone `__Host-azcsrf` equal to any `seed`), and `gone` once the cookie `told` named has left.
 */
export function heldCsrfToken(told: CsrfPair | undefined, seed = '', cookie?: string): { token: string; sure: boolean; gone: boolean }
{
    if (told !== undefined && (cookie === undefined || cookie === told.cookie))
    {
        // The answer's token until the browser shows the cookie; another value there is a rotation.
        const values = jarValues(told.cookie);
        const sure = values.includes(told.token);
        return { token: sure || values.length === 0 ? told.token : values[0] ?? '', sure, gone: values.length === 0 };
    }
    if (cookie !== undefined)
    {
        const token = jarValues(cookie)[0] ?? '';
        return { token, sure: token !== '', gone: false };
    }
    const own = jarValues('__Host-azcsrf')[0] ?? '';
    const plain = jarValues('azcsrf')[0] ?? '';
    return { token: own || plain, sure: own !== '' && plain === '' && (seed === '' || seed === own), gone: false };
}

/** @internal The pair a token answer named, when it named one. */
function pairOf(answer: unknown): CsrfPair | undefined
{
    const named = (answer as { headers?: Headers } | undefined)?.headers?.get(CSRF_PAIR_HEADER) ?? '';
    const at = named.indexOf('=');
    return at > 0 && at < named.length - 1 ? { cookie: named.slice(0, at), token: named.slice(at + 1) } : undefined;
}

/** @internal The token request in flight, one per page, and the pair its answer named. */
let asking: Promise<CsrfPair | undefined> | undefined;

/** @internal How long a tab holds the lock over an ask that has not settled. */
const LOCK_HOLD = 5000;

/** @internal How long an ask waits for the lock before it runs without it. */
const LOCK_WAIT = 10000;

/**
 * @internal Runs `ask` under the origin-wide lock, held at most LOCK_HOLD ms so a hung ask hands
 * it on in order. A lock not granted within LOCK_WAIT ms, or refused, runs the ask without it.
 */
function lockedAsk(locks: LockManager, ask: () => Promise<unknown>): Promise<unknown>
{
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), LOCK_WAIT);
    let run: Promise<unknown> | undefined;
    return locks.request('azeroth-csrf-ask', { signal: stop.signal }, () =>
    {
        clearTimeout(timer);
        run = ask();
        let hold: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([run, new Promise((resolve) =>
        {
            hold = setTimeout(resolve, LOCK_HOLD);
        })]).finally(() => clearTimeout(hold));
    }).then(() => run, () =>
    {
        clearTimeout(timer);
        return run ?? ask();
    });
}

/**
 * @internal Asks for the cookie a write to `target` needs unless `held`: one request per page, one
 * tab at a time under Web Locks. False for another origin; a joined pair comes back `joined`.
 */
export async function askCsrfCookie(target: string, held: boolean, ask: () => Promise<unknown>): Promise<CsrfPair | undefined | false>
{
    // Resolved the way fetch resolves it. With no location there is no origin to compare, and the
    // write goes wherever the caller's own transport sends it.
    const here = (globalThis as { location?: Location }).location;
    const base = (globalThis as { document?: { baseURI?: string } }).document?.baseURI;
    if (here !== undefined && new URL(target, base).origin !== here.origin)
    {
        return false;
    }
    if (held)
    {
        return undefined;
    }
    const joined = asking !== undefined;
    // Under Web Locks one ask at a time across this origin's tabs: a later one carries the cookie
    // the first set, so the server mints no rival token.
    const locks = (globalThis as { navigator?: { locks?: LockManager | null } }).navigator?.locks;
    asking ??= (locks ? lockedAsk(locks, ask) : ask()).then(pairOf, () => undefined).finally(() =>
    {
        asking = undefined;
    });
    const pair = await asking;
    return joined && pair !== undefined ? { ...pair, joined } : pair;
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

    const target = (): string =>
    {
        if (action === undefined)
        {
            return router.href(untrack(() => router.location().pathname));
        }
        return isAbsoluteAppPath(action) ? router.href(action) : action;
    };
    // The server's token while it is the one that rendered this page, the browser's cookie
    // after a client navigation. The seeded value is the only one that exists on a first load.
    const token = (): string => router.csrfToken() || heldCsrfToken(undefined).token;
    // Once per form: a server that answered and set nothing has no token to hand out.
    let answered = false;
    let told: CsrfPair | undefined;

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
            const url = target();
            const body = new URLSearchParams(new FormData(element) as unknown as Record<string, string>);
            // A page a shared cache may store minted no cookie, so the first submit asks for one,
            // even over a rendered token whose cookie never arrived, and posts the token it names.
            const now = heldCsrfToken(told, router.csrfToken());
            // Asked once, unless the cookie that answer named has since gone (a logout).
            const answer = await askCsrfCookie(url, (answered && !now.gone) || now.sure, async () =>
            {
                const response = await fetch(router.href(CSRF_TOKEN_PATH), { credentials: 'same-origin', cache: 'no-store' });
                answered = true;
                return response;
            });
            if (answer !== false)
            {
                // A joined ask may have reached another server: its pair rides this write only.
                told = answer && answer.joined !== true ? answer : told;
                const held = heldCsrfToken(answer ?? told).token;
                if (held !== '')
                {
                    body.set(CSRF_FIELD, held);
                }
            }
            const response = await fetch(url, {
                method: 'POST',
                // Asking for JSON is what selects the enhanced representation: the same action
                // answers a value here and a redirect-or-rendered-page to a native submit.
                headers: { accept: 'application/json' },
                body,
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
