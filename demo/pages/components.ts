// ============================================================================
// AZEROTHJS DEMO — Components Page
// ============================================================================
//
// Function components (defineComponent), class components
// (AzerothComponent), lifecycle hooks (onMount / onDestroy /
// onCleanup), direct DOM access via the `ref` prop, and error
// isolation with ErrorBoundary.
//
// ============================================================================

import {
    h,
    Show,
    classList,
    createRef,
    createSignal,
    createMemo,
    createEffect,
    onMount,
    onCleanup,
    defineComponent,
    AzerothComponent,
    ErrorBoundary
} from '@azerothjs/core';
import { DemoCard, PageHeader, Callout } from '../ui.ts';

// ── Ref prop (direct DOM access) ────────────────────────────────

const RefDemo = defineComponent(() =>
{
    const inputRef = createRef<HTMLInputElement>();
    const [name, setName] = createSignal('');

    // The element is handed back through the `ref` prop — no manual
    // assignment, no cast. By the time onMount runs it's populated.
    onMount(() => inputRef.current?.focus());

    return DemoCard(
        {
            title: 'Refs — Direct DOM Access',
            description: 'Pass a ref object (or callback) via the `ref` prop; h() assigns the element as it is created. Used here to auto-focus on mount.',
            tags: ['createRef', 'ref prop', 'onMount']
        },
        h('input', {
            class: 'text-input',
            type: 'text',
            ref: inputRef,
            placeholder: 'Auto-focused via ref…',
            onInput: (e: Event) => setName((e.target as HTMLInputElement).value)
        }),
        h('div', { class: 'btn-row' },
            h('button', { class: 'btn', onClick: () => inputRef.current?.focus() }, 'Focus'),
            h('button', { class: 'btn btn-ghost', onClick: () =>
            {
                setName('');
                if (inputRef.current)
                {
                    inputRef.current.value = '';
                }
            } }, 'Clear')
        ),
        Show({
            when: () => name().trim().length > 0,
            children: () => h('p', { class: 'greeting' }, () => `Hello, ${ name().trim() }! 👋`)
        })
    );
});

// ── Lifecycle (onMount / onCleanup) ─────────────────────────────

const StopwatchDemo = defineComponent(() =>
{
    const [seconds, setSeconds] = createSignal(0);
    const [running, setRunning] = createSignal(false);

    onMount(() => console.log('⏱️ Stopwatch mounted'));

    // The interval lives inside an effect keyed on `running`. When
    // running flips off (or the component unmounts), onCleanup tears
    // the timer down — no leaks.
    createEffect(() =>
    {
        if (!running())
        {
            return;
        }
        const id = setInterval(() => setSeconds(s => s + 1), 1000);
        onCleanup(() => clearInterval(id));
    });

    const display = createMemo(() =>
    {
        const s = seconds();
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return `${ mm }:${ ss }`;
    });

    return DemoCard(
        {
            title: 'Lifecycle & Cleanup',
            description: 'onMount runs after construction; an effect owns the interval and releases it via onCleanup when paused or unmounted.',
            tags: ['onMount', 'onCleanup', 'createEffect']
        },
        h('div', { class: 'stopwatch' }, display),
        h('div', { class: 'btn-row' },
            h('button', {
                class: 'btn btn-primary',
                onClick: () => setRunning(r => !r)
            }, () => running() ? 'Pause' : 'Start'),
            h('button', { class: 'btn btn-ghost', onClick: () =>
            {
                setRunning(false);
                setSeconds(0);
            } }, 'Reset'))
    );
});

// ── Class component (AzerothComponent) ──────────────────────────

class TemperatureConverter extends AzerothComponent
{
    private celsius = this.createSignal(20);
    private fahrenheit = this.createMemo(() => Math.round(this.celsius() * 9 / 5 + 32));

    private readonly presets = [
        { label: 'Freezing', value: 0 },
        { label: 'Room', value: 20 },
        { label: 'Body', value: 37 },
        { label: 'Boiling', value: 100 }
    ];

    public render(): HTMLElement
    {
        return DemoCard(
            {
                title: 'Class Component',
                description: 'AzerothComponent gives a class API over the same primitives: this.createSignal / this.createMemo, with effects auto-disposed on unmount.',
                tags: ['AzerothComponent', 'createMemo']
            },
            h('div', { class: 'temp-row' },
                h('div', { class: 'temp-cell' },
                    h('span', { class: 'temp-value' }, () => `${ this.celsius() }°C`),
                    h('span', { class: 'temp-label' }, 'Celsius')),
                h('span', { class: 'temp-eq' }, '='),
                h('div', { class: 'temp-cell' },
                    h('span', { class: 'temp-value' }, () => `${ this.fahrenheit() }°F`),
                    h('span', { class: 'temp-label' }, 'Fahrenheit'))),
            h('input', {
                class: 'slider',
                type: 'range', min: '-20', max: '120',
                value: () => String(this.celsius()),
                onInput: (e: Event) => this.celsius.set(Number((e.target as HTMLInputElement).value))
            }),
            h('div', { class: 'btn-row' },
                this.presets.map(p => h('button', {
                    class: classList(['btn', { 'btn-primary': () => this.celsius() === p.value }]),
                    onClick: () => this.celsius.set(p.value)
                }, p.label)))
        );
    }
}

// ── ErrorBoundary ───────────────────────────────────────────────

const Buggy = defineComponent<{ broken: () => boolean }>((props) =>
{
    // The boundary catches throws from effects in its subtree, not
    // just synchronous setup — so flipping `broken` later still
    // routes here.
    createEffect(() =>
    {
        if (props.broken())
        {
            throw new Error('Render exploded 💥');
        }
    });

    return h('div', { class: 'status status-success' }, '✅ Subtree is healthy');
});

const ErrorBoundaryDemo = defineComponent(() =>
{
    const [broken, setBroken] = createSignal(false);

    return DemoCard(
        {
            title: 'Error Boundary',
            description: 'ErrorBoundary catches errors thrown in its subtree — including from effects that fail on a later signal change — and swaps to a fallback you can recover from.',
            tags: ['ErrorBoundary']
        },
        h('div', { class: 'btn-row' },
            h('button', {
                class: 'btn',
                disabled: () => broken(),
                onClick: () => setBroken(true)
            }, 'Break the subtree')),
        ErrorBoundary({
            fallback: (error, reset) => h('div', { class: 'status status-error' },
                h('p', {}, `Caught: ${ String(error) }`),
                h('button', {
                    class: 'btn',
                    onClick: () =>
                    {
                        setBroken(false);
                        reset();
                    }
                }, 'Recover')),
            children: () => Buggy({ broken })
        })
    );
});

/** The Components route page. */
export const ComponentsPage = defineComponent(() =>
    h('div', { class: 'page' },
        PageHeader('Components', 'Function and class components over one reactive model — with real lifecycle and error isolation.'),
        Callout('info', 'Open the console: lifecycle hooks log as components mount. Navigate away and back to see them re-run cleanly.'),
        RefDemo({}),
        StopwatchDemo({}),
        new TemperatureConverter({}).element,
        ErrorBoundaryDemo({})
    ));
