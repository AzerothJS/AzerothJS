// ============================================================================
// AZEROTHJS DEMO — Data Page
// ============================================================================
//
// Async data with createResource + Suspense, shared global state
// with createStore, and token-by-token streaming with createStream
// (the AI-chat primitive).
//
// ============================================================================

import {
    h,
    Show,
    Suspense,
    classList,
    createSignal,
    createResource,
    createStore,
    createStream,
    defineComponent
} from '@azerothjs/core';
import { DemoCard, PageHeader, Callout } from '../ui.ts';

// ── createResource + Suspense ───────────────────────────────────

interface User { id: number; name: string; role: string }

const ROSTER = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Edsger Dijkstra', 'Barbara Liskov'];

/** A stand-in for a real `fetch` — resolves after a delay, and
 *  honours the AbortSignal so superseded loads cancel cleanly. */
function fakeFetchUser(id: number, signal: AbortSignal): Promise<User>
{
    return new Promise<User>((resolve, reject) =>
    {
        const timer = setTimeout(
            () => resolve({ id, name: ROSTER[id % ROSTER.length], role: 'Pioneer' }),
            650
        );
        signal.addEventListener('abort', () =>
        {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
        });
    });
}

const ResourceDemo = defineComponent(() =>
{
    const [userId, setUserId] = createSignal(0);

    // Re-runs whenever userId changes; the previous request aborts.
    const user = createResource<User, number>(
        () => userId(),
        (id, signal) => fakeFetchUser(id, signal)
    );

    return DemoCard(
        {
            title: 'Async Data — Resource + Suspense',
            description: 'createResource wraps an async fetcher into reactive data/loading/error and cancels superseded requests; Suspense shows a fallback until it settles.',
            tags: ['createResource', 'Suspense']
        },
        h('div', { class: 'btn-row' },
            ROSTER.map((_name, id) => h('button', {
                class: classList(['btn', { 'btn-primary': () => userId() === id }]),
                onClick: () => setUserId(id)
            }, `#${ id }`))),
        h('div', { class: 'resource-panel' },
            Suspense({
                fallback: () => h('div', { class: 'spinner-row' },
                    h('span', { class: 'spinner' }), h('span', {}, 'Loading user…')),
                on: [user],
                children: () => h('div', { class: 'user-card' },
                    h('div', { class: 'avatar' }, () => (user.data()?.name ?? '?').charAt(0)),
                    h('div', {},
                        h('div', { class: 'user-name' }, () => user.data()?.name ?? '—'),
                        h('div', { class: 'user-role' }, () => `${ user.data()?.role ?? '' } · id ${ user.data()?.id ?? '' }`)))
            })),
        h('button', { class: 'btn btn-ghost', onClick: () => user.refetch() }, 'Refetch')
    );
});

// ── createStore (shared global state) ───────────────────────────
//
// Module-level singleton: every useCart() call returns the SAME
// instance, so the two sibling panels below stay in sync without
// any prop drilling.

const useCart = createStore(() =>
{
    const [items, setItems] = createSignal<string[]>([]);
    return {
        items,
        add: (name: string) => setItems(prev => [...prev, name]),
        clear: () => setItems([])
    };
});

const CartAdder = defineComponent(() =>
{
    const cart = useCart();
    const products = ['🍎 Apple', '🥖 Bread', '🧀 Cheese', '☕ Coffee'];
    return h('div', { class: 'store-panel' },
        h('h4', {}, 'Panel A — add items'),
        h('div', { class: 'btn-row' },
            products.map(p => h('button', { class: 'btn', onClick: () => cart.add(p) }, p))),
        h('button', { class: 'btn btn-ghost', onClick: () => cart.clear() }, 'Clear cart'));
});

const CartViewer = defineComponent(() =>
{
    const cart = useCart();
    return h('div', { class: 'store-panel' },
        h('h4', {}, () => `Panel B — cart (${ cart.items().length })`),
        Show({
            when: () => cart.items().length > 0,
            fallback: () => h('p', { class: 'empty-state' }, 'Cart is empty — add from Panel A.'),
            children: () => h('ul', { class: 'cart-list' },
                // Reading the same store getter from a different component.
                () => cart.items().map(item => h('li', {}, item)))
        }));
});

const StoreDemo = defineComponent(() =>
    DemoCard(
        {
            title: 'Shared State — createStore',
            description: 'A lazy-singleton store: both panels call useCart() and observe the same signals. No context, no providers, no prop drilling.',
            tags: ['createStore']
        },
        h('div', { class: 'store-grid' },
            CartAdder({}),
            CartViewer({}))));

// ── createStream (AI streaming) ─────────────────────────────────

/** Fake chat endpoint: streams a canned reply word-by-word over a
 *  ReadableStream, exactly like a real SSE/chunked LLM response. */
function fakeChat(prompt: string, signal: AbortSignal): Promise<Response>
{
    const reply = `You said "${ prompt }". Here is a reply streamed one token at a time, just like a real language-model endpoint would deliver it.`;
    const tokens = reply.split(' ');
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        start(controller)
        {
            let i = 0;
            const id = setInterval(() =>
            {
                if (signal.aborted || i >= tokens.length)
                {
                    clearInterval(id);
                    try
                    {
                        controller.close();
                    }
                    catch
                    { /* already closed */ }
                    return;
                }
                controller.enqueue(encoder.encode(tokens[i] + ' '));
                i++;
            }, 70);
            signal.addEventListener('abort', () =>
            {
                clearInterval(id);
                try
                {
                    controller.close();
                }
                catch
                { /* already closed */ }
            });
        }
    });

    return Promise.resolve(new Response(stream));
}

const StreamDemo = defineComponent(() =>
{
    const [input, setInput] = createSignal('Tell me about fine-grained reactivity');
    const [prompt, setPrompt] = createSignal('');

    const chat = createStream<string>({
        // Empty prompt → no request (the "skip" convention).
        source: () => prompt() || false,
        fetcher: ({ source, signal }) => fakeChat(source, signal),
        parse: 'text'
    });

    return DemoCard(
        {
            title: 'AI Streaming — createStream',
            description: 'Token-by-token streaming over a ReadableStream. partial() grows live; cancel() aborts; done() flips when the stream ends.',
            tags: ['createStream', 'partial()', 'cancel()']
        },
        h('div', { class: 'input-row' },
            h('input', {
                class: 'text-input',
                type: 'text',
                value: input,
                onInput: (e: Event) => setInput((e.target as HTMLInputElement).value),
                onKeydown: (e: KeyboardEvent) =>
                {
                    if (e.key === 'Enter')
                    {
                        setPrompt(input());
                    }
                }
            }),
            h('button', {
                class: 'btn btn-primary',
                disabled: () => !chat.done(),
                onClick: () => setPrompt(input())
            }, () => chat.done() ? 'Send' : 'Streaming…')),
        h('div', { class: 'chat-bubble' },
            Show({
                when: () => chat.partial().length > 0,
                fallback: () => h('span', { class: 'chat-placeholder' }, 'The streamed reply appears here…'),
                children: () => h('span', {}, () => chat.partial())
            })),
        Show({
            when: () => !chat.done(),
            children: () => h('button', { class: 'btn btn-ghost', onClick: () => chat.cancel() }, 'Stop')
        })
    );
});

/** The Data route page. */
export const DataPage = defineComponent(() =>
    h('div', { class: 'page' },
        PageHeader('Data', 'Async loading, shared global state, and streaming — all reactive, all cancellable.'),
        Callout('tip', 'Click user buttons quickly: the previous fetch is aborted so stale data never wins. Add to the cart from Panel A and watch Panel B update — same store, no props.'),
        ResourceDemo({}),
        StoreDemo({}),
        StreamDemo({})
    ));
