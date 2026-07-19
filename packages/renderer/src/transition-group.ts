/**
 * MODULE: renderer/transition-group
 *
 * <TransitionGroup> is the keyed-list counterpart of <Transition>: items ENTER with the
 * 6-class family when their key joins the list and LEAVE with it when their key departs -
 * the removal deferred until the leave animation completes. This is the primitive a toast
 * stack, a notification tray, or any animated list needs; hand-rolling it means tracking
 * per-item "leaving" flags and deferred removal around <For>, which every app gets subtly
 * wrong (the Guardian report that motivated this component did exactly that).
 *
 * SAME CLASS CONVENTION AS <Transition> (name: 'toast'): `toast-enter-from/-active/-to`
 * on join, `toast-leave-from/-active/-to` on departure; a `duration` backstop guarantees
 * the machine never wedges without CSS.
 *
 * V1 SCOPE, DELIBERATE: no FLIP move animation (`{name}-move`) - reordering repositions
 * instantly; enter/leave are the animated pair. A key that RE-JOINS while its old element
 * is still leaving gets a FRESH element (the old one finishes its exit alongside).
 * Ordering uses a sequential cursor pass, not <For>'s LIS - group lists are small and
 * animated; minimal-move math buys nothing visible here.
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, createSignal, onRootDispose, isStringMode, isHydrating, untrack, serializeChild, wrapContentsAnchored, hydrationNode } from '@azerothjs/reactivity';
import { destroyComponent, type CoTarget, type MountNode, createCoMarkers, adoptCoRange } from '@azerothjs/component';
import { hydrateChild, resolveReactive } from './h.ts';

/** Props for the `<TransitionGroup>` component. */
export interface TransitionGroupProps<T>
{
    /** The items to render: an array, or a getter (thunk/signal) for reactivity. */
    each: T[] | (() => T[]);

    /** Unique, stable key per item - identity across updates, exactly as in `<For>`. */
    key: (item: T, index: number) => string | number;

    /** Per-item render function; each item MUST render exactly one element. */
    children: (item: T, index: () => number) => HTMLElement;

    /**
     * Class-name prefix for the 6-class family. Without it, items swap
     * instantly - at which point `<For>` is the better tool.
     */
    name?: string;

    /** Fallback timeout (ms) for transitionend; default 1000. */
    duration?: number;
}

/** @internal Default transitionend backstop, matching <Transition>. */
const FALLBACK_TIMEOUT_MS = 1000;

/** @internal One live (non-leaving) item. */
interface GroupEntry
{
    el: HTMLElement;
    dispose: DisposeFn;
    setIndex: (index: number) => void;
}

/**
 * @internal A lazily-allocated reactive row index, the same shape <For> uses:
 * the signal (and its graph bookkeeping) only exists once a render function
 * actually reads `index()` - most rows never do.
 */
function createRowIndex(initial: number): { get: () => number; set: (next: number) => void }
{
    let current = initial;
    let getter: (() => number) | null = null;
    let setter: ((next: number) => void) | null = null;
    return {
        get: (): number =>
        {
            if (getter === null)
            {
                [getter, setter] = createSignal(current);
            }
            return getter();
        },
        set: (next: number): void =>
        {
            current = next;
            setter?.(next);
        }
    };
}

/**
 * TransitionGroup
 *
 * PURPOSE:
 * Renders a keyed list whose items animate in when added and animate out - removal
 * deferred - when removed, via the `<Transition>` class convention.
 *
 * WHEN TO USE:
 * Toast stacks, notification trays, animated search results - any list where items
 * join and depart while the rest stays put.
 *
 * WHEN NOT TO USE:
 * A list that never animates (`<For>` - keyed reuse with minimal moves) or a single
 * conditional element (`<Transition>`).
 *
 * @typeParam T - The item type.
 * @param props - {@link TransitionGroupProps}: `each`, `key`, `children`, `name`, `duration`.
 * @returns An HTMLElement-typed control-flow handle owning the rows.
 * @see {@link Transition}
 * @see {@link For}
 */
export function TransitionGroup<T>(props: TransitionGroupProps<T>): MountNode
{
    const renderItem = props.children;

    // SSR: items serialize once, statically - there is no browser to animate against.
    if (isStringMode())
    {
        const items = untrack(() => resolveReactive(props.each)) as T[];
        let inner = '';
        for (const [index, item] of items.entries())
        {
            inner += serializeChild(renderItem(item, () => index));
        }
        return wrapContentsAnchored('tgroup', inner) as unknown as MountNode;
    }

    // Hydration: adopt the server rows; later changes animate.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveGroup(props, target, true, contentCursor);
        }) as unknown as MountNode;
    }

    const { fragment, target } = createCoMarkers('tgroup');
    driveGroup(props, target, false);
    return fragment;
}

/** @internal The keyed reconcile + per-item animation machine. */
function driveGroup<T>(props: TransitionGroupProps<T>, target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    let firstRun = true;
    let keyMap = new Map<string | number, GroupEntry>();

    // Items playing their exit: still in the DOM, no longer in keyMap. The
    // ordering pass steps over them; teardown (incl. their root's dispose)
    // happens when their wait settles - or on root dispose, whichever first.
    const leaving = new Map<HTMLElement, GroupEntry>();

    // Per-leaving-element cancel (listener + timer detach) for root dispose.
    const leaveWaits = new Map<HTMLElement, () => void>();

    function family(direction: 'enter' | 'leave'): { from: string; active: string; to: string } | null
    {
        if (props.name === undefined)
        {
            return null;
        }
        return {
            from: `${ props.name }-${ direction }-from`,
            active: `${ props.name }-${ direction }-active`,
            to: `${ props.name }-${ direction }-to`
        };
    }

    function waitForEnd(el: HTMLElement, callback: () => void): void
    {
        const duration = props.duration ?? FALLBACK_TIMEOUT_MS;
        let done = false;
        function finish(): void
        {
            if (done)
            {
                return;
            }
            done = true;
            el.removeEventListener('transitionend', handler);
            clearTimeout(timer);
            leaveWaits.delete(el);
            callback();
        }
        function handler(event: Event): void
        {
            if (event.target === el)
            {
                finish();
            }
        }
        el.addEventListener('transitionend', handler);
        const timer = setTimeout(finish, duration);
        leaveWaits.set(el, () =>
        {
            done = true;
            el.removeEventListener('transitionend', handler);
            clearTimeout(timer);
            leaveWaits.delete(el);
        });
    }

    function playEnter(el: HTMLElement): void
    {
        const cls = family('enter');
        if (cls === null)
        {
            return;
        }
        el.classList.add(cls.from, cls.active);
        void el.offsetHeight;
        requestAnimationFrame(() =>
        {
            el.classList.remove(cls.from);
            el.classList.add(cls.to);
            waitForEnd(el, () =>
            {
                el.classList.remove(cls.active, cls.to);
            });
        });
    }

    function playLeave(entry: GroupEntry): void
    {
        const el = entry.el;
        const cls = family('leave');
        if (cls === null)
        {
            el.parentNode?.removeChild(el);
            entry.dispose();
            destroyComponent(el);
            return;
        }
        leaving.set(el, entry);
        el.classList.add(cls.from, cls.active);
        void el.offsetHeight;
        requestAnimationFrame(() =>
        {
            el.classList.remove(cls.from);
            el.classList.add(cls.to);
            waitForEnd(el, () =>
            {
                leaving.delete(el);
                el.parentNode?.removeChild(el);
                entry.dispose();
                destroyComponent(el);
            });
        });
    }

    function reconcile(items: T[]): void
    {
        // Hydration first run adopts rows in order, exactly as <For> does.
        if (firstRun && hydrateFirstRun)
        {
            firstRun = false;
            const cursor = hydrationCursor as HydrationCursorType;
            const adopted = new Map<string | number, GroupEntry>();
            for (const [i, item] of items.entries())
            {
                const key = props.key(item, i);
                const index = createRowIndex(i);
                let el!: HTMLElement;
                let dispose!: DisposeFn;
                createRoot((d) =>
                {
                    dispose = d;
                    const descriptor = props.children(item, index.get);
                    el = cursor.peekElement() as HTMLElement;
                    hydrateChild(descriptor, cursor);
                });
                adopted.set(key, { el, dispose, setIndex: index.set });
            }
            cursor.assertExhausted('<TransitionGroup> rows');
            keyMap = adopted;
            return;
        }
        const animateJoins = !firstRun;
        firstRun = false;

        const newMap = new Map<string | number, GroupEntry>();
        const newOrder: HTMLElement[] = new Array<HTMLElement>(items.length);
        const entered: HTMLElement[] = [];

        for (const [i, item] of items.entries())
        {
            const key = props.key(item, i);
            const existing = keyMap.get(key);
            if (existing !== undefined)
            {
                existing.setIndex(i);
                newOrder[i] = existing.el;
                newMap.set(key, existing);
                keyMap.delete(key);
                continue;
            }
            const index = createRowIndex(i);
            let el!: HTMLElement;
            let dispose!: DisposeFn;
            createRoot((d) =>
            {
                dispose = d;
                el = props.children(item, index.get);
            });
            newOrder[i] = el;
            newMap.set(key, { el, dispose, setIndex: index.set });
            entered.push(el);
        }

        // Departed keys play their exit where they stand.
        for (const entry of keyMap.values())
        {
            playLeave(entry);
        }
        keyMap = newMap;

        // Sequential ordering pass: march a cursor through the range, stepping
        // over leaving elements (they hold their place until their exit ends),
        // and insert each live element where the cursor stands.
        const parent = target.parent();
        const { start, end } = target;
        let cursor: ChildNode | null = start.nextSibling;
        for (const el of newOrder)
        {
            while (cursor !== null && cursor !== end && leaving.has(cursor as HTMLElement))
            {
                cursor = cursor.nextSibling;
            }
            if (cursor === el)
            {
                cursor = cursor.nextSibling;
                continue;
            }
            parent.insertBefore(el, cursor ?? end);
        }

        if (animateJoins)
        {
            for (const el of entered)
            {
                playEnter(el);
            }
        }
    }

    createEffect(() =>
    {
        const items = resolveReactive(props.each) as T[];
        untrack(() => reconcile(items));
    });

    onRootDispose(() =>
    {
        for (const cancel of [...leaveWaits.values()])
        {
            cancel();
        }
        for (const [el, entry] of [...leaving])
        {
            el.parentNode?.removeChild(el);
            entry.dispose();
            destroyComponent(el);
        }
        leaving.clear();
        for (const entry of keyMap.values())
        {
            entry.dispose();
            entry.el.parentNode?.removeChild(entry.el);
            destroyComponent(entry.el);
        }
        keyMap.clear();
    });
}
