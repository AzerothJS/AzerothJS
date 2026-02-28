// ============================================================================
// QUANTUM FRAMEWORK — Full Feature Demo
// ============================================================================
//
// This demo showcases EVERY feature built into Quantum:
//
//   REACTIVITY:   createSignal, createEffect, createMemo, batch, untrack, on
//   RENDERER:     h, render, Show, For, Switch, Match, Portal, Dynamic,
//                 createRef, classList, styleMap
//   COMPONENTS:   defineComponent, onMount, onDestroy, destroyComponent
//
// Run: npx vite demo
// ============================================================================

import {
    createSignal,
    createEffect,
    createMemo,
    batch,
    untrack,
    on,
    h,
    render,
    Show,
    For,
    Switch,
    Match,
    Portal,
    Dynamic,
    createRef,
    classList,
    styleMap,
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy
} from '../src';

function FeatureTags(...tags: string[]): HTMLElement
{
    return h('div', { class: 'feature-tags' }, tags.map(tag => h('span', { class: 'feature-tag' }, tag)));
}

function Toggleable(label: string, create: () => HTMLElement): HTMLElement
{
    const [isVisible, setIsVisible] = createSignal(true);
    const slot = h('div', {});
    let currentEl: HTMLElement | null = null;

    function mount(): void
    {
        currentEl = create();
        slot.appendChild(currentEl);
    }

    function unmount(): void
    {
        if (currentEl)
        {
            destroyComponent(currentEl);
            slot.removeChild(currentEl);
            currentEl = null;
        }
    }

    createEffect(() =>
    {
        if (isVisible())
        {
            mount();
        }
        else
        {
            unmount();
        }
    });

    return h('div', {},
        h('button', {
            class: 'toggle-btn',
            onClick: () => setIsVisible(prev => !prev)
        },
        h('span', {}, label),
        h('span', {
            class: classList({
                'toggle-icon': true,
                'toggle-icon-open': isVisible
            })
        }, '▼')
        ),
        slot
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 1: REACTIVE COUNTER
// ═════════════════════════════════════════════════════════════════════════════

interface CounterProps
{
    initial: number;
}

const CounterDemo = defineComponent<CounterProps>((props) =>
{
    const [count, setCount] = createSignal(props.initial);
    const doubled = createMemo(() => count() * 2);
    const isEven = createMemo(() => count() % 2 === 0);
    const isPositive = createMemo(() => count() >= 0);

    onMount(() => console.log('⚡ Counter mounted!'));
    onDestroy(() => console.log('⚡ Counter destroyed!'));

    return h('div', { class: 'glass' },
        FeatureTags('createSignal', 'createMemo', 'classList', 'styleMap'),
        h('h2', {}, '⚡ Reactive Counter'),
        h('div', { class: 'counter' },
            h('button', {
                class: 'btn-icon',
                onClick: () => setCount(prev => prev - 1)
            }, '−'),
            h('span', {
                class: 'counter-value',
                style: styleMap({
                    color: () => isPositive() ? 'var(--accent)' : 'var(--red)',
                    transform: () => `scale(${ 1 + Math.min(Math.abs(count()), 10) * 0.02 })`
                })
            }, () => `${ count() }`),
            h('button', {
                class: 'btn-icon',
                onClick: () => setCount(prev => prev + 1)
            }, '+')
        ),
        h('div', { class: 'info-bar' },
            h('span', { class: 'info-chip' }, () => `×2 = ${ doubled() }`),
            h('span', { class: 'info-chip' }, () => isEven() ? '✦ Even' : '◇ Odd')
        ),
        h('div', { style: 'text-align: center; margin-top: 1rem;' },
            h('button', {
                class: 'btn-ghost btn-sm',
                onClick: () => setCount(props.initial)
            }, 'Reset')
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 2: GREETING WITH REF
// ═════════════════════════════════════════════════════════════════════════════

const GreetingDemo = defineComponent(() =>
{
    const [name, setName] = createSignal('');
    const greeting = createMemo(() =>
    {
        const n = name().trim();
        return n.length > 0 ? `Hello, ${ n }! 👋` : '';
    });
    const hasName = createMemo(() => name().trim().length > 0);
    const nameLength = createMemo(() => name().length);

    const inputRef = createRef<HTMLInputElement>();

    onMount(() =>
    {
        console.log('🎤 Greeting mounted!');
        inputRef.current?.focus();
    });

    const input = h('input', {
        type: 'text',
        placeholder: 'Type your name... (auto-focused with createRef)',
        onInput: (e: Event) =>
        {
            setName((e.target as HTMLInputElement).value);
        }
    });
    inputRef.current = input as HTMLInputElement;

    return h('div', { class: 'glass' },
        FeatureTags('createRef', 'createMemo', 'Show', 'onMount'),
        h('h2', {}, '🎤 Greeting with Ref'),
        input,
        Show(
            {
                when: hasName,
                fallback: () => h('p', { class: 'empty-state', style: 'padding: 1rem;' },
                    'Start typing to see the greeting...')
            },
            () => h('div', { style: 'margin-top: 12px;' },
                h('p', { style: 'font-size: 1.25rem; color: var(--teal); font-weight: 500;' },
                    () => greeting()),
                h('p', { style: 'color: var(--text-muted); font-size: 0.78rem; margin-top: 4px;' },
                    () => `${ nameLength() } characters typed`)
            )
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 3: TODO LIST
// ═════════════════════════════════════════════════════════════════════════════

interface Todo
{
    id: number;
    text: string;
    done: boolean;
}

const TodoDemo = defineComponent(() =>
{
    const [todos, setTodos] = createSignal<Todo[]>([]);
    const [inputText, setInputText] = createSignal('');
    const [filter, setFilter] = createSignal<'all' | 'active' | 'done'>('all');

    const filteredTodos = createMemo(() =>
    {
        const f = filter();
        const list = todos();

        if (f === 'active')
            return list.filter(t => !t.done);
        if (f === 'done')
            return list.filter(t => t.done);

        return list;
    });

    const totalCount = createMemo(() => todos().length);
    const doneCount = createMemo(() => todos().filter(t => t.done).length);
    const activeCount = createMemo(() => totalCount() - doneCount());

    let nextId = 0;

    on([filter], ([currentFilter]) =>
    {
        console.log(`📋 Filter changed to: ${ currentFilter }`);
    }, { defer: true });

    function addTodo(): void
    {
        const text = inputText().trim();
        if (text.length === 0)
            return;

        batch(() =>
        {
            setTodos(prev => [...prev, { id: nextId++, text, done: false }]);
            setInputText('');
        });
    }

    function toggleTodo(id: number): void
    {
        setTodos(prev => prev.map(t => t.id === id ? { ...t, done: !t.done } : t));
    }

    function removeTodo(id: number): void
    {
        setTodos(prev => prev.filter(t => t.id !== id));
    }

    function clearDone(): void
    {
        setTodos(prev => prev.filter(t => !t.done));
    }

    onMount(() => console.log('📋 TodoApp mounted!'));
    onDestroy(() => console.log('📋 TodoApp destroyed!'));

    function TodoItem(todoId: number): HTMLElement
    {
        const isDone = () =>
        {
            const todo = todos().find(t => t.id === todoId);
            return todo ? todo.done : false;
        };

        const text = () =>
        {
            const todo = todos().find(t => t.id === todoId);
            return todo ? todo.text : '';
        };

        return h('div', {
            class: 'todo-item',
            style: styleMap({
                opacity: () => isDone() ? 0.5 : 1
            })
        },
        h('span', {
            class: 'todo-text',
            style: styleMap({
                textDecoration: () => isDone() ? 'line-through' : 'none'
            }),
            onClick: () => toggleTodo(todoId)
        }, () => isDone() ? `✓ ${ text() }` : text()),
        h('button', {
            class: 'todo-delete',
            onClick: () => removeTodo(todoId)
        }, '✕')
        );
    }

    return h('div', { class: 'glass' },
        FeatureTags('For', 'Show', 'batch', 'createMemo', 'on', 'classList'),
        h('h2', {}, '📋 Todo List'),

        h('div', { class: 'todo-input' },
            h('input', {
                type: 'text',
                placeholder: 'What needs to be done?',
                value: () => inputText(),
                onInput: (e: Event) =>
                {
                    setInputText((e.target as HTMLInputElement).value);
                },
                onKeydown: (e: KeyboardEvent) =>
                {
                    if (e.key === 'Enter') addTodo();
                }
            }),
            h('button', { class: 'btn-primary', onClick: addTodo }, 'Add')
        ),

        h('div', { class: 'tabs' },
            ...(['all', 'active', 'done'] as const).map(f =>
                h('button', {
                    class: classList({
                        'tab': true,
                        'tab-active': () => filter() === f
                    }),
                    onClick: () => setFilter(f)
                }, f.charAt(0).toUpperCase() + f.slice(1))
            )
        ),

        For(
            { each: filteredTodos, key: (todo) => todo.id },
            (todo) => TodoItem(todo.id)
        ),

        Show(
            { when: () => filteredTodos().length === 0 },
            () => h('div', { class: 'empty-state' },
                () => filter() === 'all'
                    ? '✨ No todos yet. Add one above!'
                    : `No ${ filter() } todos.`
            )
        ),

        h('div', { class: 'todo-footer' },
            h('span', { class: 'todo-count' },
                () => `${ activeCount() } active · ${ doneCount() } done`
            ),
            Show(
                { when: () => doneCount() > 0 },
                () => h('button', {
                    class: 'btn-danger btn-sm',
                    onClick: clearDone
                }, 'Clear done')
            )
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 4: STATUS SWITCH
// ═════════════════════════════════════════════════════════════════════════════

const StatusDemo = defineComponent(() =>
{
    const [status, setStatus] = createSignal<'idle' | 'loading' | 'success' | 'error'>('idle');

    function simulateFetch(): void
    {
        setStatus('loading');
        setTimeout(() =>
        {
            setStatus(Math.random() > 0.3 ? 'success' : 'error');
        }, 1500);
    }

    onMount(() => console.log('📡 StatusDemo mounted!'));

    return h('div', { class: 'glass' },
        FeatureTags('Switch', 'Match', 'classList'),
        h('h2', {}, '📡 Async Status'),

        h('div', { style: 'margin: 1.25rem 0;' },
            Switch(
                Match({ when: () => status() === 'idle' },
                    () => h('div', {},
                        h('span', { class: 'badge badge-idle' }, '◻ IDLE'),
                        h('p', { style: 'margin-top: 10px; color: var(--text-muted); font-size: 0.88rem;' },
                            'Ready to fetch data.')
                    )),
                Match({ when: () => status() === 'loading' },
                    () => h('div', {},
                        h('span', { class: 'badge badge-loading' }, '◌ LOADING'),
                        h('p', { style: 'margin-top: 10px; color: var(--blue); font-size: 0.88rem;' },
                            'Fetching data...')
                    )),
                Match({ when: () => status() === 'success' },
                    () => h('div', {},
                        h('span', { class: 'badge badge-success' }, '✓ SUCCESS'),
                        h('p', { style: 'margin-top: 10px; color: var(--green); font-size: 0.88rem;' },
                            'Data loaded successfully!')
                    )),
                Match({ when: () => status() === 'error' },
                    () => h('div', {},
                        h('span', { class: 'badge badge-error' }, '✕ ERROR'),
                        h('p', { style: 'margin-top: 10px; color: var(--red); font-size: 0.88rem;' },
                            'Something went wrong.')
                    ))
            )
        ),

        h('div', { style: 'display: flex; gap: 8px;' },
            h('button', {
                class: 'btn-primary',
                onClick: simulateFetch,
                disabled: () => status() === 'loading'
            }, () => status() === 'loading' ? 'Fetching...' : 'Fetch Data'),
            h('button', {
                class: 'btn-ghost btn-sm',
                onClick: () => setStatus('idle')
            }, 'Reset')
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 5: DYNAMIC TABS
// ═════════════════════════════════════════════════════════════════════════════

const DynamicTabsDemo = defineComponent(() =>
{
    const ProfileTab = () => h('div', { style: 'padding: 4px 0;' },
        h('h3', {}, '👤 Profile'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem; margin-top: 4px;' },
            'Name: Quantum Developer'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Email: dev@quantum.js'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Role: Framework Architect')
    );

    const SettingsTab = () => h('div', { style: 'padding: 4px 0;' },
        h('h3', {}, '⚙️ Settings'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem; margin-top: 4px;' },
            'Theme: Dark Glass'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Language: TypeScript'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Notifications: Enabled')
    );

    const StatsTab = () => h('div', { style: 'padding: 4px 0;' },
        h('h3', {}, '📊 Statistics'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem; margin-top: 4px;' },
            'Components: 42'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Signals: 128'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Effects: 64')
    );

    type TabName = 'profile' | 'settings' | 'stats';

    const tabs: Record<TabName, () => HTMLElement> =
    {
        profile: ProfileTab,
        settings: SettingsTab,
        stats: StatsTab
    };

    const [activeTab, setActiveTab] = createSignal<TabName>('profile');

    onMount(() => console.log('📑 DynamicTabs mounted!'));

    return h('div', { class: 'glass' },
        FeatureTags('Dynamic', 'classList'),
        h('h2', {}, '📑 Dynamic Tabs'),

        h('div', { class: 'tabs' },
            ...Object.keys(tabs).map(tab =>
                h('button', {
                    class: classList({
                        'tab': true,
                        'tab-active': () => activeTab() === tab
                    }),
                    onClick: () => setActiveTab(tab as TabName)
                }, tab.charAt(0).toUpperCase() + tab.slice(1))
            )
        ),

        Dynamic({
            component: () => tabs[activeTab()]
        })
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 6: PORTAL MODAL
// ═════════════════════════════════════════════════════════════════════════════

const PortalDemo = defineComponent(() =>
{
    const [isOpen, setIsOpen] = createSignal(false);

    onMount(() => console.log('🚪 PortalDemo mounted!'));

    onDestroy(() => console.log('🚪 PortalDemo destroyed!'));

    return h('div', { class: 'glass' },
        FeatureTags('Portal', 'Show', 'onDestroy'),
        h('h2', {}, '🚪 Portal Modal'),
        h('p', { style: 'color: var(--text-muted); margin-bottom: 1rem; font-size: 0.88rem;' },
            'The modal renders into document.body via Portal — outside this card\'s DOM tree. Inspect the DOM to verify!'),
        h('button', { class: 'btn-primary', onClick: () => setIsOpen(true) },
            () => isOpen() ? 'Modal Open...' : 'Open Modal'),

        Show(
            { when: isOpen },
            () => Portal({}, () =>
                h('div', { class: 'modal-overlay', onClick: () => setIsOpen(false) },
                    h('div', { class: 'modal', onClick: (e: Event) => e.stopPropagation() },
                        h('h2', {}, '⚛️ Portal Modal'),
                        h('p', {}, 'This element lives in document.body, not inside the card. It escapes overflow:hidden, z-index issues, and CSS transform contexts.'),
                        h('div', { class: 'modal-buttons' },
                            h('button', { class: 'btn-ghost', onClick: () => setIsOpen(false) }, 'Cancel'),
                            h('button', { class: 'btn-primary', onClick: () => setIsOpen(false) }, 'Got it!')
                        )
                    )
                )
            )
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 7: STYLE PLAYGROUND
// ═════════════════════════════════════════════════════════════════════════════

const StyleDemo = defineComponent(() =>
{
    const [hue, setHue] = createSignal(260);
    const [size, setSize] = createSignal(60);
    const [rounded, setRounded] = createSignal(true);
    const [shadow, setShadow] = createSignal(true);

    const color = createMemo(() => `hsl(${ hue() }, 70%, 60%)`);

    onMount(() => console.log('🎨 StyleDemo mounted!'));

    return h('div', { class: 'glass' },
        FeatureTags('styleMap', 'classList', 'createMemo'),
        h('h2', {}, '🎨 Style Playground'),

        h('div', { style: 'display: flex; align-items: center; gap: 1.5rem; margin: 1rem 0 1.5rem;' },
            h('div', {
                class: 'color-preview',
                style: styleMap({
                    backgroundColor: color,
                    width: () => `${ size() }px`,
                    height: () => `${ size() }px`,
                    borderRadius: () => rounded() ? '12px' : '2px',
                    boxShadow: () => shadow() ? `0 4px 24px ${ color() }66` : 'none'
                })
            }),
            h('div', { style: 'flex: 1;' },
                h('p', {
                    style: styleMap({
                        color: color,
                        fontWeight: '600',
                        fontSize: '1.05rem',
                        fontFamily: '\'JetBrains Mono\', monospace'
                    })
                }, () => `hsl(${ hue() }, 70%, 60%)`),
                h('p', { style: 'color: var(--text-muted); font-size: 0.78rem; margin-top: 2px;' },
                    () => `${ size() }px · ${ rounded() ? 'Rounded' : 'Square' } · ${ shadow() ? 'Shadow' : 'Flat' }`)
            )
        ),

        h('div', { class: 'color-controls' },
            h('label', { class: 'color-label' },
                h('span', {}, 'Hue'),
                h('input', {
                    type: 'range',
                    min: '0',
                    max: '360',
                    value: () => `${ hue() }`,
                    onInput: (e: Event) => setHue(Number((e.target as HTMLInputElement).value))
                }),
                h('span', {
                    class: 'color-value',
                    style: styleMap({ color: color })
                }, () => `${ hue() }°`)
            ),
            h('label', { class: 'color-label' },
                h('span', {}, 'Size'),
                h('input', {
                    type: 'range',
                    min: '24',
                    max: '120',
                    value: () => `${ size() }`,
                    onInput: (e: Event) => setSize(Number((e.target as HTMLInputElement).value))
                }),
                h('span', { class: 'color-value' }, () => `${ size() }px`)
            )
        ),

        h('div', { style: 'display: flex; gap: 8px; margin-top: 1rem;' },
            h('button', {
                class: classList({
                    'btn-sm': true,
                    'btn-primary': rounded,
                    'btn-ghost': () => !rounded()
                }),
                onClick: () => setRounded(prev => !prev)
            }, () => rounded() ? '● Rounded' : '■ Square'),
            h('button', {
                class: classList({
                    'btn-sm': true,
                    'btn-primary': shadow,
                    'btn-ghost': () => !shadow()
                }),
                onClick: () => setShadow(prev => !prev)
            }, () => shadow() ? '✦ Shadow' : '○ Flat')
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 8: TIMER WITH LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════

const TimerDemo = defineComponent(() =>
{
    const [seconds, setSeconds] = createSignal(0);
    const [laps, setLaps] = createSignal<{ id: number; time: number }[]>([]);
    let lapId = 0;

    const formatted = createMemo(() =>
    {
        const s = seconds();
        const min = Math.floor(s / 60);
        const sec = s % 60;
        return `${ min.toString().padStart(2, '0') }:${ sec.toString().padStart(2, '0') }`;
    });

    onMount(() =>
    {
        console.log('⏱️ Timer mounted!');

        const id = setInterval(() =>
        {
            setSeconds(prev => prev + 1);
        }, 1000);

        return () =>
        {
            console.log('⏱️ Timer interval cleared!');
            clearInterval(id);
        };
    });

    onDestroy(() =>
    {
        console.log('⏱️ Timer destroyed!');
    });

    createEffect(() =>
    {
        const s = seconds();
        if (s > 0 && s % 10 === 0)
        {
            const lapCount = untrack(() => laps().length);
            console.log(`⏱️ ${ s }s elapsed (${ lapCount } laps)`);
        }
    });

    return h('div', { class: 'glass' },
        FeatureTags('onMount', 'onDestroy', 'untrack', 'createEffect', 'For'),
        h('h2', {}, '⏱️ Lifecycle Timer'),
        h('p', { class: 'timer-display' }, () => formatted()),
        h('div', { style: 'display: flex; gap: 8px; justify-content: center; margin-bottom: 1rem;' },
            h('button', {
                class: 'btn-primary btn-sm',
                onClick: () => setLaps(prev => [...prev, { id: lapId++, time: seconds() }])
            }, '🏁 Lap'),
            h('button', {
                class: 'btn-ghost btn-sm',
                onClick: () => setLaps([])
            }, 'Clear')
        ),
        Show(
            { when: () => laps().length > 0 },
            () => For(
                { each: laps, key: (lap) => lap.id },
                (lap, index) => h('div', { class: 'lap-item' },
                    h('span', {}, `Lap ${ index + 1 }`),
                    h('span', { class: 'lap-time' },
                        `${ Math.floor(lap.time / 60).toString().padStart(2, '0') }:${ (lap.time % 60).toString().padStart(2, '0') }`)
                )
            )
        ),
        Show(
            { when: () => laps().length === 0 },
            () => h('p', { class: 'empty-state', style: 'padding: 0.5rem;' },
                'Hit Lap to record times')
        ),
        h('p', { style: 'color: var(--text-muted); font-size: 0.72rem; text-align: center; margin-top: 12px;' },
            '💡 Toggle hide/show to see lifecycle hooks in console')
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// APP ROOT
// ══════════════════════════════════════════════════��══════════════════════════

const App = defineComponent(() =>
{
    onMount(() =>
    {
        console.log('🚀 Quantum App mounted!');
        console.log('📋 Open console to see lifecycle logs.');
    });

    return h('div', {},
        // Header
        h('div', { class: 'header' },
            h('h1', {}, 'QuantumJS'),
            h('p', { class: 'tagline' },
                'Fine-grained reactivity · No virtual DOM · Direct DOM updates'),
            h('p', { class: 'hint' },
                '↕ Toggle sections to see lifecycle hooks · Open console for logs'),
            h('div', { class: 'header-stats' },
                h('div', { class: 'header-stat' },
                    h('div', { class: 'header-stat-value' }, '0'),
                    h('div', { class: 'header-stat-label' }, 'Dependencies')
                ),
                h('div', { class: 'header-stat' },
                    h('div', { class: 'header-stat-value' }, '<4kb'),
                    h('div', { class: 'header-stat-label' }, 'Bundle Size')
                ),
                h('div', { class: 'header-stat' },
                    h('div', { class: 'header-stat-value' }, '100+'),
                    h('div', { class: 'header-stat-label' }, 'Tests')
                ),
                h('div', { class: 'header-stat' },
                    h('div', { class: 'header-stat-value' }, '∞'),
                    h('div', { class: 'header-stat-label' }, 'Potential')
                )
            )
        ),

        // Demos
        Toggleable('⚡ Counter — Signals, Memos, Reactive Styles',
            () => CounterDemo({ initial: 0 })),

        Toggleable('🎤 Greeting — Ref, Conditional Rendering',
            () => GreetingDemo({})),

        Toggleable('📋 Todo — Keyed Lists, Filters, Batch Updates',
            () => TodoDemo({})),

        Toggleable('📡 Status — Switch/Match Multi-Condition',
            () => StatusDemo({})),

        Toggleable('📑 Tabs — Dynamic Component Swapping',
            () => DynamicTabsDemo({})),

        Toggleable('🚪 Portal — Render Outside DOM Tree',
            () => PortalDemo({})),

        Toggleable('🎨 Styles — Reactive Style & Class Binding',
            () => StyleDemo({})),

        Toggleable('⏱️ Timer — Lifecycle Hooks, Untrack',
            () => TimerDemo({})),

        // Footer
        h('div', { class: 'footer' },
            h('p', { class: 'footer-brand' }, '⚛️ Built with Quantum Framework'),
            h('p', { class: 'footer-apis' },
                'createSignal · createEffect · createMemo · batch · untrack · on'),
            h('p', { class: 'footer-apis' },
                'h · render · Show · For · Switch · Match · Portal · Dynamic · createRef'),
            h('p', { class: 'footer-apis' },
                'classList · styleMap · defineComponent · onMount · onDestroy')
        )
    );
});

render(() => App({}), document.getElementById('app')!);
