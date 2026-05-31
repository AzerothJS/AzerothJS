// ============================================================================
// AZEROTHJS — AzerothComponent (Class-Based Components)
// ============================================================================
//
// Simple class components. No setup(), no boilerplate.
// Just declare fields and implement render().
//
// EXACT SAME API NAMES AS FUNCTION COMPONENTS:
//
//   Function:                    Class:
//   createSignal(v)        →    this.createSignal(v)
//   createMemo(fn)         →    this.createMemo(fn)
//   createEffect(fn)       →    this.createEffect(fn)
//   onMount(() => ...)     →    onMount() { ... }
//   onDestroy(() => ...)   →    onDestroy() { ... }
//
// STANDALONE UTILITIES — just import and use:
//
//   batch(() => { ... })          — groups updates
//   untrack(() => signal())       — read without subscribing
//   on([deps], (vals) => { ... }) — explicit dependency tracking
//
// USAGE:
//
//   class Counter extends AzerothComponent<{ initial: number }>
//   {
//       count = this.createSignal(this.props.initial);
//       doubled = this.createMemo(() => this.count() * 2);
//
//       onMount()
//       {
//           this.createEffect(() =>
//           {
//               console.log('Count:', this.count());
//           });
//       }
//
//       render()
//       {
//           return h('div', {},
//             h('span', {}, () => `${ this.count() }`),
//             h('button', {
//               onClick: () => this.count.set(prev => prev + 1)
//             }, '+')
//           );
//       }
//   }
//
//   // Access .element — triggers render synchronously
//   document.body.appendChild(new Counter({ initial: 0 }).element);
//
// ============================================================================

import type { Getter, DisposeFn } from '@azerothjs/reactivity';
import { createSignal, createEffect, untrack } from '@azerothjs/reactivity';
import { getClassDestroyHooks, setClassDestroyHooks } from './destroy-hooks.ts';

/**
 * A reactive state value for class components.
 *
 * Created by this.createSignal(). Callable to read,
 * has .set() to update. "this" always works.
 *
 * @typeParam T - The type of the state value
 */
export interface ReactiveState<T>
{
    /** Read the current value. Subscribes the active effect. */
    (): T;

    /**
     * Update the value.
     * @param newValue - New value, or function (prev) => next
     */
    set: (newValue: T | ((prev: T) => T)) => void;

    /**
     * Read without subscribing any effect.
     */
    value: T;
}

/**
 * Base class for class-based AzerothJS components.
 *
 * Just declare fields with this.createSignal/createMemo
 * and implement render(). No setup() needed.
 *
 * Access .element to trigger initialization (render + onMount).
 * This is lazy so subclass field initializers complete first.
 *
 * @typeParam P - Props type. Uses `object` constraint so
 *               interfaces work.
 */
export abstract class AzerothComponent<P extends object = Record<string, unknown>>
{
    /**
     * The props passed to this component.
     * Available immediately in field initializers.
     */
    public readonly props: P;

    /**
     * Effect dispose functions — cleaned up on destroy.
     * @internal
     */
    private _disposers: DisposeFn[] = [];

    /**
     * Prevents double-destroy.
     * @internal
     */
    private _isDestroyed = false;

    /**
     * Whether _init() has been called.
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
        // Do NOT call render() here.
        // Subclass field initializers haven't run yet.
        // render() is called lazily when .element is accessed.
    }

    /**
     * The rendered DOM element.
     *
     * First access triggers render() + onMount().
     * Subsequent accesses return the cached element.
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
     * Internal initialization — runs render() + onMount().
     * Called lazily on first .element access.
     * @internal
     */
    private _init(): void
    {
        this._initialized = true;

        // Subclass fields are now initialized
        this._element = this.render();

        // Register destroy hook for destroyComponent(). We append
        // rather than overwrite so a wrapper component (or anything
        // else that has already attached class-destroy hooks to this
        // element) doesn't get clobbered.
        const hooks = getClassDestroyHooks(this._element) ?? [];
        hooks.push((): void => this.destroy());
        setClassDestroyHooks(this._element, hooks);

        this.onMount();
    }

    // ── Override these ───────────────────────────────────────

    /**
     * Build the DOM. REQUIRED.
     * All fields from this.createSignal/createMemo are available.
     */
    public abstract render(): HTMLElement;

    /**
     * Called after render(). Start timers, effects, listeners.
     */
    public onMount(): void
    {}

    /**
     * Called on destroy. Clean up timers, listeners.
     * Effects from this.createEffect() auto-dispose.
     */
    public onDestroy(): void
    {}

    /**
     * Destroys this component. Safe to call multiple times.
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

    // ── Reactive primitives — same names as function API ─────

    /**
     * Creates reactive state. Same name as createSignal().
     * Returns ReactiveState: call to read, .set() to update.
     */
    protected createSignal<T>(initialValue: T): ReactiveState<T>
    {
        const [getter, setter] = createSignal(initialValue);
        const state = (() => getter()) as ReactiveState<T>;

        state.set = setter;

        // `.value` is an UNTRACKED peek — reading it never subscribes
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
     * Creates a memoized value. Same name as createMemo().
     *
     * Inlined (rather than calling createMemo()) so we can capture
     * the underlying effect's dispose and register it with this
     * component. Without this, destroying the component leaves
     * the memo's effect subscribed to its source signals forever.
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
            // updater and invoke it — corrupting function-valued
            // memos (the same bug `createMemo` in @azerothjs/reactivity
            // guards against).
            setter(() => next);
        });
        this._disposers.push(dispose);
        return getter;
    }

    /**
     * Creates an effect. Same name as createEffect().
     * Auto-disposes on destroy.
     */
    protected createEffect(fn: () => void | (() => void)): void
    {
        const dispose = createEffect(fn);
        this._disposers.push(dispose);
    }
}
