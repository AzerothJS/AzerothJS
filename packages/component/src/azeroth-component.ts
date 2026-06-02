// AzerothComponent: a class-based alternative to defineComponent(). Declare
// fields and implement render(); no setup() function needed.
//
// The reactive primitives mirror the function API under `this`: createSignal,
// createMemo, and createEffect map to this.createSignal/createMemo/createEffect,
// and onMount/onDestroy become methods. Standalone utilities (batch, untrack,
// on) are imported and used directly.
//
// Example:
//
//   class Counter extends AzerothComponent<{ initial: number }>
//   {
//       count = this.createSignal(this.props.initial);
//       doubled = this.createMemo(() => this.count() * 2);
//
//       onMount()
//       {
//           this.createEffect(() => console.log('Count:', this.count()));
//       }
//
//       render()
//       {
//           return h('div', {},
//             h('span', {}, () => `${ this.count() }`),
//             h('button', { onClick: () => this.count.set(prev => prev + 1) }, '+')
//           );
//       }
//   }
//
//   // Accessing .element triggers render() synchronously.
//   document.body.appendChild(new Counter({ initial: 0 }).element);

import type { Getter, DisposeFn } from '@azerothjs/reactivity';
import { createSignal, createEffect, untrack, isStringMode } from '@azerothjs/reactivity';
import { getClassDestroyHooks, setClassDestroyHooks } from './destroy-hooks.ts';

/**
 * A reactive state value for class components. Created by this.createSignal():
 * callable to read, with .set() to update and .value for an untracked peek.
 *
 * @typeParam T - The type of the state value
 *
 * @example
 * ```ts
 * const count: ReactiveState<number> = this.createSignal(0);
 * count();                 // read (subscribes) -> 0
 * count.set(c => c + 1);   // update -> 1
 * count.value;             // untracked read -> 1
 * ```
 */
export interface ReactiveState<T>
{
    /** Read the current value. Subscribes the active effect. */
    (): T;

    /**
     * Update the value.
     * @param newValue - New value, or an updater (prev) => next
     */
    set: (newValue: T | ((prev: T) => T)) => void;

    /** Read the current value without subscribing any effect. */
    value: T;
}

/**
 * Base class for class-based AzerothJS components. Declare fields with
 * this.createSignal/createMemo and implement render().
 *
 * Initialization (render + onMount) is lazy, triggered on first access to
 * .element, so subclass field initializers complete first.
 *
 * Without AzerothComponent: hold the [getter, setter] pair in a field and
 * track every effect dispose yourself so destroy() can run them:
 *
 *     class Counter
 *     {
 *         count = createSignal(0);
 *         disposers = [];
 *         mount()
 *         {
 *             this.disposers.push(createEffect(() => log(this.count[0]())));
 *         }
 *         destroy()
 *         {
 *             this.disposers.forEach(d => d());  // miss one and the effect leaks
 *         }
 *     }
 *
 * With AzerothComponent: this.createSignal returns a callable state and
 * this.createEffect is tracked, so destroy() disposes everything for you:
 *
 *     class Counter extends AzerothComponent
 *     {
 *         count = this.createSignal(0);
 *         onMount()
 *         {
 *             this.createEffect(() => log(this.count()));  // auto-disposed on destroy()
 *         }
 *         render()
 *         {
 *             return h('p', {}, () => `${ this.count() }`);
 *         }
 *     }
 *
 * @typeParam P - Props type. Uses an `object` constraint so interfaces work.
 *
 * @example
 * ```ts
 * class Counter extends AzerothComponent<{ initial: number }>
 * {
 *     count = this.createSignal(this.props.initial);
 *
 *     render()
 *     {
 *         return h('button',
 *             { onClick: () => this.count.set(c => c + 1) },
 *             () => `${ this.count() }`
 *         );
 *     }
 * }
 *
 * const counter = new Counter({ initial: 0 });
 * document.body.appendChild(counter.element);  // renders '0'
 * ```
 */
export abstract class AzerothComponent<P extends object = Record<string, unknown>>
{
    /**
     * The props passed to this component. Available immediately in field
     * initializers.
     */
    public readonly props: P;

    /**
     * Effect dispose functions, called on destroy.
     * @internal
     */
    private _disposers: DisposeFn[] = [];

    /**
     * Prevents double-destroy.
     * @internal
     */
    private _isDestroyed = false;

    /**
     * Whether _init() has run.
     * @internal
     */
    private _initialized = false;

    /**
     * Cached element after init.
     * @internal
     */
    private _element: HTMLElement | null = null;

    constructor(props: P)
    {
        this.props = props;
        // Don't render here: subclass field initializers haven't run yet.
        // render() is deferred until the first .element access.
    }

    /**
     * The rendered DOM element. The first access triggers render() + onMount();
     * later accesses return the cached element.
     *
     * @example
     * ```ts
     * const counter = new Counter({ initial: 0 });
     * const el = counter.element;   // first access: render() + onMount() run
     * counter.element === el;       // true: same cached node on later reads
     * ```
     */
    public get element(): HTMLElement
    {
        if (!this._initialized)
        {
            this._init();
        }
        return this._element!;
    }

    /**
     * Runs render() + onMount(). Called lazily on first .element access.
     * @internal
     */
    private _init(): void
    {
        this._initialized = true;

        this._element = this.render();

        // Server-side rendering: `_element` is a serialized SSRNode.
        // Skip destroy-hook storage and onMount - server-side mounts
        // must not run side effects.
        if (isStringMode())
        {
            return;
        }

        // Register destroy hook for destroyComponent(). We append
        // rather than overwrite so a wrapper component (or anything
        // else that has already attached class-destroy hooks to this
        // element) doesn't get clobbered.
        const hooks = getClassDestroyHooks(this._element) ?? [];
        hooks.push((): void => this.destroy());
        setClassDestroyHooks(this._element, hooks);

        this.onMount();
    }

    // Override these.

    /**
     * Build the DOM. REQUIRED.
     * All fields from this.createSignal/createMemo are available.
     *
     * @example
     * ```ts
     * render()
     * {
     *     return h('p', {}, () => `Hello, ${ this.props.name }`);
     * }
     * ```
     */
    public abstract render(): HTMLElement;

    /**
     * Called after render(). Start timers, effects, listeners.
     *
     * @example
     * ```ts
     * onMount()
     * {
     *     // effects started here auto-dispose on destroy()
     *     this.createEffect(() => console.log('count:', this.count()));
     * }
     * ```
     */
    public onMount(): void
    {}

    /**
     * Called on destroy. Clean up timers, listeners.
     * Effects from this.createEffect() auto-dispose.
     *
     * @example
     * ```ts
     * onDestroy()
     * {
     *     clearInterval(this.timerId);
     * }
     * ```
     */
    public onDestroy(): void
    {}

    /**
     * Destroys this component. Safe to call multiple times.
     *
     * @example
     * ```ts
     * const counter = new Counter({ initial: 0 });
     * document.body.appendChild(counter.element);
     * counter.destroy();   // runs onDestroy() and disposes effects
     * counter.destroy();   // no-op: already destroyed
     * ```
     */
    public destroy(): void
    {
        if (this._isDestroyed)
        {
            return;
        }
        this._isDestroyed = true;

        this.onDestroy();

        for (const dispose of this._disposers)
        {
            dispose();
        }
        this._disposers = [];
    }

    // Reactive primitives - same names as the function API.

    /**
     * Creates reactive state. Returns a ReactiveState: call it to read,
     * .set() to update.
     *
     * @example
     * ```ts
     * count = this.createSignal(0);
     * // ...
     * this.count();                  // read -> 0
     * this.count.set(c => c + 1);    // update -> 1
     * this.count.value;              // untracked peek -> 1
     * ```
     */
    protected createSignal<T>(initialValue: T): ReactiveState<T>
    {
        const [getter, setter] = createSignal(initialValue);
        const state = (() => getter()) as ReactiveState<T>;

        state.set = setter;

        // `.value` is an UNTRACKED peek - reading it never subscribes
        // the active effect (that's what calling the state directly is
        // for). Without untrack(), `this.count.value` inside an effect
        // would silently create a dependency, contradicting the API.
        Object.defineProperty(state, 'value', {
            get: () => untrack(() => getter()),
            enumerable: true
        });

        return state;
    }

    /**
     * Creates a memoized value.
     *
     * Inlined rather than calling createMemo() so we can capture the
     * underlying effect's dispose and register it with this component.
     * Without that, destroying the component would leave the memo's effect
     * subscribed to its source signals forever.
     *
     * @example
     * ```ts
     * count = this.createSignal(2);
     * doubled = this.createMemo(() => this.count() * 2);
     * // ...
     * this.doubled();   // -> 4, recomputes when count changes
     * ```
     */
    protected createMemo<T>(fn: () => T): Getter<T>
    {
        const [getter, setter] = createSignal<T>(undefined as unknown as T);
        const dispose = createEffect(() =>
        {
            const next = fn();
            // Store via a function updater so the value is written
            // verbatim even when T is itself a function. A plain
            // `setter(next)` would treat a function `next` as an
            // updater and invoke it - corrupting function-valued
            // memos (the same bug `createMemo` in @azerothjs/reactivity
            // guards against).
            setter(() => next);
        });
        this._disposers.push(dispose);
        return getter;
    }

    /**
     * Creates an effect that auto-disposes when the component is destroyed.
     *
     * @example
     * ```ts
     * onMount()
     * {
     *     // re-runs whenever this.count() changes; disposed on destroy()
     *     this.createEffect(() => console.log('count is', this.count()));
     * }
     * ```
     */
    protected createEffect(fn: () => void | (() => void)): void
    {
        const dispose = createEffect(fn);
        this._disposers.push(dispose);
    }
}
