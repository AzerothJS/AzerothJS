// ============================================================================
// QUANTUM FRAMEWORK — Full Feature Demo (13 Demos)
// ============================================================================
// Run: npx vite demo
// ============================================================================

import {
    createSignal,
    createEffect,
    createMemo,
    batch,
    untrack,
    on,
    onCleanup,
    createRoot,
    createDeferred,
    createSelector,
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
    onDestroy,
    QuantumComponent
} from '@quantum/core';

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
            untrack(() => mount());
        }
        else
        {
            untrack(() => unmount());
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
                fallback: () => h('p', {
                    class: 'empty-state',
                    style: 'padding: 1rem;'
                }, 'Start typing to see the greeting...')
            },
            () => h('div', { style: 'margin-top: 12px;' },
                h('p', {
                    style: 'font-size: 1.25rem; color: var(--teal); font-weight: 500;'
                }, () => greeting()),
                h('p', {
                    style: 'color: var(--text-muted); font-size: 0.78rem; margin-top: 4px;'
                }, () => `${ nameLength() } characters typed`)
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
        if (text.length === 0) return;

        batch(() =>
        {
            setTodos(prev => [...prev, { id: nextId++, text, done: false }]);
            setInputText('');
        });
    }

    function toggleTodo(id: number): void
    {
        setTodos(prev => prev.map(t =>
            t.id === id ? { ...t, done: !t.done } : t
        ));
    }

    function removeTodo(id: number): void
    {
        setTodos(prev => prev.filter(t => t.id !== id));
    }

    function clearDone(): void
    {
        setTodos(prev => prev.filter(t => !t.done));
    }

    function TodoItem(todoId: number): HTMLElement
    {
        const isDone = (): boolean =>
        {
            const todo = todos().find(t => t.id === todoId);
            return todo ? todo.done : false;
        };

        const text = (): string =>
        {
            const todo = todos().find(t => t.id === todoId);
            return todo ? todo.text : '';
        };

        return h('div', {
            class: 'todo-item',
            style: styleMap({ opacity: () => isDone() ? 0.5 : 1 })
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

    onMount(() => console.log('📋 TodoApp mounted!'));
    onDestroy(() => console.log('📋 TodoApp destroyed!'));

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
    const ProfileTab = (): HTMLElement => h('div', { style: 'padding: 4px 0;' },
        h('h3', {}, '👤 Profile'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem; margin-top: 4px;' },
            'Name: Quantum Developer'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Email: dev@quantum.js'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Role: Framework Architect')
    );

    const SettingsTab = (): HTMLElement => h('div', { style: 'padding: 4px 0;' },
        h('h3', {}, '⚙️ Settings'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem; margin-top: 4px;' },
            'Theme: Dark Glass'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Language: TypeScript'),
        h('p', { style: 'color: var(--text-secondary); font-size: 0.88rem;' },
            'Notifications: Enabled')
    );

    const StatsTab = (): HTMLElement => h('div', { style: 'padding: 4px 0;' },
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
        Dynamic({ component: () => tabs[activeTab()] })
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
        h('p', {
            style: 'color: var(--text-muted); margin-bottom: 1rem; font-size: 0.88rem;'
        }, 'The modal renders into document.body via Portal — outside this card\'s DOM tree.'),
        h('button', {
            class: 'btn-primary',
            onClick: () => setIsOpen(true)
        }, () => isOpen() ? 'Modal Open...' : 'Open Modal'),
        Show(
            { when: isOpen },
            () => Portal({}, () =>
                h('div', {
                    class: 'modal-overlay',
                    onClick: () => setIsOpen(false)
                },
                h('div', {
                    class: 'modal',
                    onClick: (e: Event) => e.stopPropagation()
                },
                h('h2', {}, '⚛️ Portal Modal'),
                h('p', {}, 'This element lives in document.body, not inside the card.'),
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
                    type: 'range', min: '0', max: '360',
                    value: () => `${ hue() }`,
                    onInput: (e: Event) => setHue(Number((e.target as HTMLInputElement).value))
                }),
                h('span', { class: 'color-value', style: styleMap({ color: color }) },
                    () => `${ hue() }°`)
            ),
            h('label', { class: 'color-label' },
                h('span', {}, 'Size'),
                h('input', {
                    type: 'range', min: '24', max: '120',
                    value: () => `${ size() }`,
                    onInput: (e: Event) => setSize(Number((e.target as HTMLInputElement).value))
                }),
                h('span', { class: 'color-value' }, () => `${ size() }px`)
            )
        ),
        h('div', { style: 'display: flex; gap: 8px; margin-top: 1rem;' },
            h('button', {
                class: classList({ 'btn-sm': true, 'btn-primary': rounded, 'btn-ghost': () => !rounded() }),
                onClick: () => setRounded(prev => !prev)
            }, () => rounded() ? '● Rounded' : '■ Square'),
            h('button', {
                class: classList({ 'btn-sm': true, 'btn-primary': shadow, 'btn-ghost': () => !shadow() }),
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
        const id = setInterval(() => setSeconds(prev => prev + 1), 1000);
        return () =>
        {
            console.log('⏱️ Timer interval cleared!'); clearInterval(id);
        };
    });

    onDestroy(() => console.log('⏱️ Timer destroyed!'));

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
            h('button', { class: 'btn-ghost btn-sm', onClick: () => setLaps([]) }, 'Clear')
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
            () => h('p', { class: 'empty-state', style: 'padding: 0.5rem;' }, 'Hit Lap to record times')
        ),
        h('p', { style: 'color: var(--text-muted); font-size: 0.72rem; text-align: center; margin-top: 12px;' },
            '💡 Toggle hide/show to see lifecycle hooks in console')
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 9: CLASS COMPONENT — Clean field initializers, no setup()
// ═════════════════════════════════════════════════════════════════════════════

class TemperatureConverter extends QuantumComponent
{
    public celsius = this.createSignal(20);
    public fahrenheit = this.createMemo(() => Math.round((this.celsius() * 9 / 5 + 32) * 10) / 10);
    public kelvin = this.createMemo(() => Math.round((this.celsius() + 273.15) * 10) / 10);
    public description = this.createMemo(() =>
    {
        const c = this.celsius();
        if (c <= 0) return '🥶 Freezing';
        if (c <= 10) return '❄️ Cold';
        if (c <= 20) return '🌤️ Cool';
        if (c <= 30) return '☀️ Warm';
        if (c <= 40) return '🔥 Hot';
        return '🌋 Extreme';
    });
    public history = this.createSignal<number[]>([20]);
    public historyCount = this.createMemo(() => this.history().length);

    public setTemp(value: number): void
    {
        batch(() =>
        {
            this.celsius.set(value);
            this.history.set(prev => [...prev, value]);
        });
    }

    public clearHistory(): void
    {
        this.history.set([this.celsius()]);
    }

    public onMount(): void
    {
        console.log('🌡️ TemperatureConverter mounted!');

        on([this.celsius], ([temp]) =>
        {
            console.log(`🌡️ on() triggered: ${ temp }°C`);
        }, { defer: true });

        this.createEffect(() =>
        {
            const c = this.celsius();
            const histLen = untrack(() => this.history().length);
            console.log(`🌡️ ${ c }°C / ${ this.fahrenheit() }°F / ${ this.kelvin() }K — ${ this.description() } (${ histLen } readings)`);
        });
    }

    public onDestroy(): void
    {
        console.log('🌡️ TemperatureConverter destroyed!');
    }

    public render(): HTMLElement
    {
        return h('div', { class: 'glass' },
            FeatureTags('QuantumComponent', 'this.createSignal', 'this.createMemo', 'this.createEffect', 'batch', 'untrack', 'on'),
            h('h2', {}, '🌡️ Class Component'),
            h('p', { style: 'color: var(--text-muted); font-size: 0.82rem; margin-bottom: 1rem;' },
                'Built with QuantumComponent — exact same API, no setup(), no boilerplate'),

            h('div', { style: 'text-align: center; margin: 1.25rem 0;' },
                h('p', {
                    style: styleMap({
                        fontSize: '2.2rem',
                        fontWeight: '700',
                        fontFamily: '\'JetBrains Mono\', monospace',
                        color: () =>
                        {
                            const c = this.celsius();
                            if (c <= 0) return 'var(--blue)';
                            if (c <= 20) return 'var(--teal)';
                            if (c <= 35) return 'var(--yellow)';
                            return 'var(--red)';
                        },
                        transition: 'color 0.3s'
                    })
                }, () => `${ this.celsius() }°C`),
                h('p', { style: 'font-size: 1.2rem; color: var(--text-secondary); margin-top: 4px;' },
                    () => this.description())
            ),

            h('div', { class: 'color-controls' },
                h('label', { class: 'color-label' },
                    h('span', {}, 'Temp'),
                    h('input', {
                        type: 'range', min: '-40', max: '60',
                        value: () => `${ this.celsius() }`,
                        onInput: (e: Event) => this.setTemp(Number((e.target as HTMLInputElement).value))
                    }),
                    h('span', { class: 'color-value' }, () => `${ this.celsius() }°`)
                )
            ),

            h('div', { class: 'info-bar', style: 'margin-top: 1rem;' },
                h('span', { class: 'info-chip' }, () => `${ this.fahrenheit() }°F`),
                h('span', { class: 'info-chip' }, () => `${ this.kelvin() }K`),
                h('span', { class: 'info-chip' }, () => `${ this.historyCount() } readings`)
            ),

            h('div', { style: 'display: flex; gap: 6px; justify-content: center; margin-top: 1rem; flex-wrap: wrap;' },
                ...[
                    { label: '🥶 −20°', value: -20 },
                    { label: '❄️ 0°', value: 0 },
                    { label: '🌤️ 20°', value: 20 },
                    { label: '☀️ 37°', value: 37 },
                    { label: '🔥 50°', value: 50 }
                ].map(preset =>
                    h('button', {
                        class: classList({
                            'btn-sm': true,
                            'btn-primary': () => this.celsius() === preset.value,
                            'btn-ghost': () => this.celsius() !== preset.value
                        }),
                        onClick: () => this.setTemp(preset.value)
                    }, preset.label)
                )
            ),

            h('div', { style: 'text-align: center; margin-top: 0.75rem;' },
                h('button', { class: 'btn-ghost btn-sm', onClick: () => this.clearHistory() }, '🗑 Clear History')
            ),

            h('div', { style: 'margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-glass);' },
                h('p', { style: 'color: var(--text-muted); font-size: 0.72rem; text-align: center;' },
                    '💡 Same API: this.createSignal, this.createMemo, this.createEffect — standalone: batch, untrack, on')
            )
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 10: ON CLEANUP — Imperative Cleanup Inside Effects
// ═════════════════════════════════════════════════════════════════════════════

const CleanupDemo = defineComponent(() =>
{
    // Tracks the URL the user types (simulating a WebSocket connection)
    const [url, setUrl] = createSignal('wss://stream.example.com');
    // Log of connection events so the user can see open/close lifecycle
    const [log, setLog] = createSignal<{ id: number; msg: string }[]>([]);
    let logId = 0;

    function addLog(msg: string): void
    {
        setLog(prev => [...prev.slice(-19), { id: logId++, msg }]);
    }

    // Every time `url` changes the effect re-runs.
    // onCleanup registers a teardown that fires BEFORE the next run
    // (or when the effect is disposed), proving automatic resource cleanup.
    createEffect(() =>
    {
        const currentUrl = url();
        addLog(`🔌 Connected to ${ currentUrl }`);

        // Register cleanup — runs before next execution or on dispose
        onCleanup(() =>
        {
            addLog(`❌ Disconnected from ${ currentUrl }`);
        });
    });

    onMount(() => console.log('🧹 CleanupDemo mounted!'));

    return h('div', { class: 'glass' },
        FeatureTags('onCleanup', 'createEffect', 'createSignal'),
        h('h2', {}, '🧹 onCleanup'),
        h('p', {
            style: 'color: var(--text-muted); margin-bottom: 1rem; font-size: 0.88rem;'
        }, 'Change the URL to see the old connection clean up before the new one opens.'),
        h('div', { style: 'display: flex; gap: 8px; margin-bottom: 1rem;' },
            h('input', {
                type: 'text',
                value: () => url(),
                style: 'flex: 1;',
                onInput: (e: Event) => setUrl((e.target as HTMLInputElement).value)
            }),
            h('button', {
                class: 'btn-ghost btn-sm',
                onClick: () => setUrl(`wss://stream${ Math.floor(Math.random() * 99) }.example.com`)
            }, '🔀 Random')
        ),
        h('div', {
            class: 'log-box',
            style: 'font-family: "JetBrains Mono", monospace; font-size: 0.78rem; '
                + 'background: rgba(0,0,0,0.25); border-radius: 8px; padding: 12px; '
                + 'min-height: 120px; max-height: 200px; overflow-y: auto;'
        },
        For(
            { each: log, key: (item) => item.id },
            (entry) => h('div', {
                style: styleMap({
                    color: () => entry.msg.startsWith('❌') ? 'var(--red)' : 'var(--green)',
                    padding: '2px 0'
                })
            }, entry.msg)
        ),
        Show(
            { when: () => log().length === 0 },
            () => h('p', { style: 'color: var(--text-muted);' }, 'Waiting for connection events...')
        )
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 11: CREATE ROOT — Isolated Reactive Ownership
// ═════════════════════════════════════════════════════════════════════════════

const RootDemo = defineComponent(() =>
{
    // Each "scope" gets its own createRoot; dispose kills all its effects.
    const [scopes, setScopes] = createSignal<{ id: number; name: string; dispose: () => void }[]>([]);
    const [disposedIds, setDisposedIds] = createSignal<Set<number>>(new Set());
    const [globalTick, setGlobalTick] = createSignal(0);
    let nextId = 1;

    // Reactive check — reads disposedIds signal so effects re-run
    function isAlive(id: number): boolean
    {
        return !disposedIds().has(id);
    }

    function addScope(): void
    {
        const id = nextId++;
        const name = `Scope-${ id }`;

        // createRoot returns a dispose function that tears down all
        // effects created inside the root — demonstrating ownership.
        const dispose = createRoot((dispose) =>
        {
            // This effect is "owned" by this root
            createEffect(() =>
            {
                const tick = globalTick();
                console.log(`🌱 [${ name }] tick = ${ tick }`);
            });

            return dispose;
        });

        setScopes(prev => [...prev, { id, name, dispose }]);
    }

    function disposeScope(id: number): void
    {
        const scope = scopes().find(s => s.id === id);
        if (scope && isAlive(id))
        {
            scope.dispose();
            console.log(`💀 [${ scope.name }] disposed — effect stopped`);
            setDisposedIds(prev => new Set([...prev, id]));
        }
    }

    function clearAll(): void
    {
        scopes().forEach(s =>
        {
            if (isAlive(s.id)) s.dispose();
        });
        setScopes([]);
        setDisposedIds(new Set());
    }

    onMount(() => console.log('🌱 RootDemo mounted!'));

    return h('div', { class: 'glass' },
        FeatureTags('createRoot', 'createEffect', 'dispose'),
        h('h2', {}, '🌱 createRoot'),
        h('p', {
            style: 'color: var(--text-muted); margin-bottom: 1rem; font-size: 0.88rem;'
        }, 'Create scopes, then dispose them to stop their effects. Check the console.'),
        h('div', { style: 'display: flex; gap: 8px; margin-bottom: 1rem;' },
            h('button', { class: 'btn-primary btn-sm', onClick: addScope }, '+ New Scope'),
            h('button', {
                class: 'btn-primary btn-sm',
                onClick: () => setGlobalTick(prev => prev + 1)
            }, () => `Tick (${ globalTick() })`),
            Show(
                { when: () => scopes().length > 0 },
                () => h('button', { class: 'btn-danger btn-sm', onClick: clearAll }, 'Dispose All')
            )
        ),
        For(
            { each: scopes, key: (s) => s.id },
            (scope) => h('div', {
                style: styleMap({
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    margin: '4px 0',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.04)',
                    opacity: () => isAlive(scope.id) ? '1' : '0.4'
                })
            },
            h('span', {
                style: styleMap({
                    fontFamily: '\'JetBrains Mono\', monospace',
                    fontSize: '0.85rem',
                    color: () => isAlive(scope.id) ? 'var(--green)' : 'var(--text-muted)'
                })
            }, () => `${ scope.name } — ${ isAlive(scope.id) ? '● alive' : '○ disposed' }`),
            Show(
                { when: () => isAlive(scope.id) },
                () => h('button', {
                    class: 'btn-danger btn-sm',
                    onClick: () => disposeScope(scope.id)
                }, 'Dispose')
            )
            )
        ),
        Show(
            { when: () => scopes().length === 0 },
            () => h('p', { class: 'empty-state', style: 'padding: 0.5rem;' }, 'No scopes yet. Create one above.')
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 12: CREATE DEFERRED — Debounced Reactive Search
// ═════════════════════════════════════════════════════════════════════════════

const DeferredDemo = defineComponent(() =>
{
    const [query, setQuery] = createSignal('');
    const [updateCount, setUpdateCount] = createSignal(0);

    // createDeferred waits until the source signal is stable for 300ms
    // before updating — perfect for search-as-you-type without flooding.
    const deferredQuery = createDeferred(query, { timeout: 300 });

    // Track how many times the deferred value actually updates
    createEffect(() =>
    {
        deferredQuery();
        setUpdateCount(prev => prev + 1);
    });

    // Some dummy items to "search"
    const items = [
        'createSignal', 'createEffect', 'createMemo', 'createRoot',
        'createDeferred', 'createSelector', 'onCleanup', 'onMount',
        'onDestroy', 'batch', 'untrack', 'on', 'h', 'render',
        'Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic'
    ];

    const results = createMemo(() =>
    {
        const q = deferredQuery().trim().toLowerCase();
        if (q.length === 0) return items;
        return items.filter(item => item.toLowerCase().includes(q));
    });

    onMount(() => console.log('⏳ DeferredDemo mounted!'));

    return h('div', { class: 'glass' },
        FeatureTags('createDeferred', 'createMemo', 'For'),
        h('h2', {}, '⏳ createDeferred'),
        h('p', {
            style: 'color: var(--text-muted); margin-bottom: 1rem; font-size: 0.88rem;'
        }, 'Type fast — the results only update after 300ms of inactivity (debounced).'),
        h('input', {
            type: 'text',
            placeholder: 'Search Quantum APIs...',
            value: () => query(),
            onInput: (e: Event) => setQuery((e.target as HTMLInputElement).value)
        }),
        h('div', { class: 'info-bar', style: 'margin: 12px 0;' },
            h('span', { class: 'info-chip' }, () => `Raw: "${ query() }"`),
            h('span', { class: 'info-chip' }, () => `Deferred: "${ deferredQuery() }"`),
            h('span', { class: 'info-chip' }, () => `Updates: ${ updateCount() }`)
        ),
        h('div', { style: 'display: flex; flex-wrap: wrap; gap: 6px;' },
            For(
                { each: results, key: (item) => item },
                (item) => h('span', {
                    class: 'info-chip',
                    style: styleMap({
                        background: () => deferredQuery().length > 0
                            ? 'rgba(45, 212, 191, 0.15)'
                            : 'rgba(255,255,255,0.06)',
                        color: () => deferredQuery().length > 0
                            ? 'var(--teal)'
                            : 'var(--text-secondary)'
                    })
                }, item)
            )
        ),
        Show(
            { when: () => results().length === 0 },
            () => h('p', { class: 'empty-state', style: 'padding: 0.5rem;' },
                () => `No APIs matching "${ deferredQuery() }"`)
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO 13: CREATE SELECTOR — Efficient O(1) List Selection
// ═════════════════════════════════════════════════════════════════════════════

const SelectorDemo = defineComponent(() =>
{
    // A list of colors to pick from
    const colors =
    [
        { id: 1, name: 'Ruby', hue: 0 },
        { id: 2, name: 'Amber', hue: 40 },
        { id: 3, name: 'Emerald', hue: 145 },
        { id: 4, name: 'Sapphire', hue: 220 },
        { id: 5, name: 'Violet', hue: 280 },
        { id: 6, name: 'Rose', hue: 340 }
    ];

    const [selectedId, setSelectedId] = createSignal(1);

    // createSelector derives an O(1) lookup: isSelected(id) only re-runs
    // for the PREVIOUS and NEXT selected id — not the whole list.
    const isSelected = createSelector(selectedId);

    const selectedColor = createMemo(() => colors.find(c => c.id === selectedId()) ?? colors[0]);

    // Count re-renders to prove O(1) behavior
    const [renderCount, setRenderCount] = createSignal(0);

    onMount(() => console.log('🎯 SelectorDemo mounted!'));

    return h('div', { class: 'glass' },
        FeatureTags('createSelector', 'createMemo', 'For', 'O(1) updates'),
        h('h2', {}, '🎯 createSelector'),
        h('p', {
            style: 'color: var(--text-muted); margin-bottom: 1rem; font-size: 0.88rem;'
        }, 'Click a color — only the old and new selection re-render (O(1)), not the whole list.'),
        h('div', {
            style: 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 1rem;'
        },
        ...colors.map(color =>
        {
            // Each item checks isSelected(id) — thanks to createSelector,
            // this only fires for the 2 affected items on each change.
            const el = h('button', {
                style: styleMap({
                    padding: '14px 8px',
                    borderRadius: '10px',
                    border: () => isSelected(color.id)
                        ? `2px solid hsl(${ color.hue }, 70%, 60%)`
                        : '2px solid transparent',
                    background: () => isSelected(color.id)
                        ? `hsla(${ color.hue }, 70%, 60%, 0.15)`
                        : 'rgba(255,255,255,0.04)',
                    color: () => isSelected(color.id)
                        ? `hsl(${ color.hue }, 70%, 65%)`
                        : 'var(--text-secondary)',
                    fontWeight: () => isSelected(color.id) ? '600' : '400',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    textAlign: 'center',
                    fontSize: '0.9rem'
                }),
                onClick: () =>
                {
                    setSelectedId(color.id);
                    setRenderCount(prev => prev + 1);
                }
            },
            h('div', {
                style: 'width: 18px; height: 18px; border-radius: 50%; '
                        + `background: hsl(${ color.hue }, 70%, 60%); `
                        + 'margin: 0 auto 6px;'
            }),
            color.name
            );

            return el;
        })
        ),
        h('div', {
            style: styleMap({
                textAlign: 'center',
                padding: '1rem',
                borderRadius: '10px',
                background: () => `hsla(${ selectedColor().hue }, 70%, 60%, 0.1)`,
                border: () => `1px solid hsla(${ selectedColor().hue }, 70%, 60%, 0.25)`
            })
        },
        h('p', {
            style: styleMap({
                fontSize: '1.3rem',
                fontWeight: '600',
                color: () => `hsl(${ selectedColor().hue }, 70%, 65%)`
            })
        }, () => `${ selectedColor().name }`),
        h('p', {
            style: 'color: var(--text-muted); font-size: 0.78rem; margin-top: 4px;'
        }, () => `hsl(${ selectedColor().hue }, 70%, 60%) · ${ renderCount() } selections made`)
        )
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// APP ROOT
// ═════════════════════════════════════════════════════════════════════════════

const App = defineComponent(() =>
{
    onMount(() =>
    {
        console.log('🚀 Quantum App mounted!');
        console.log('📋 Open console to see lifecycle logs.');
    });

    return h('div', {},
        h('div', { class: 'header' },
            h('h1', {}, 'Quantum'),
            h('p', { class: 'tagline' }, 'Fine-grained reactivity · No virtual DOM · Direct DOM updates'),
            h('p', { class: 'hint' }, '↕ Toggle sections to see lifecycle hooks · Open console for logs'),
            h('div', { class: 'header-stats' },
                h('div', { class: 'header-stat' },
                    h('div', { class: 'header-stat-value' }, '0'),
                    h('div', { class: 'header-stat-label' }, 'Dependencies')),
                h('div', { class: 'header-stat' },
                    h('div', { class: 'header-stat-value' }, '<4kb'),
                    h('div', { class: 'header-stat-label' }, 'Bundle Size')),
                h('div', { class: 'header-stat' },
                    h('div', { class: 'header-stat-value' }, '200+'),
                    h('div', { class: 'header-stat-label' }, 'Tests')),
                h('div', { class: 'header-stat' },
                    h('div', { class: 'header-stat-value' }, '∞'),
                    h('div', { class: 'header-stat-label' }, 'Potential'))
            )
        ),

        Toggleable('⚡ Counter — Signals, Memos, Reactive Styles', () => CounterDemo({ initial: 0 })),
        Toggleable('🎤 Greeting — Ref, Conditional Rendering', () => GreetingDemo({})),
        Toggleable('📋 Todo — Keyed Lists, Filters, Batch Updates', () => TodoDemo({})),
        Toggleable('📡 Status — Switch/Match Multi-Condition', () => StatusDemo({})),
        Toggleable('📑 Tabs — Dynamic Component Swapping', () => DynamicTabsDemo({})),
        Toggleable('🚪 Portal — Render Outside DOM Tree', () => PortalDemo({})),
        Toggleable('🎨 Styles — Reactive Style & Class Binding', () => StyleDemo({})),
        Toggleable('⏱️ Timer — Lifecycle Hooks, Untrack', () => TimerDemo({})),
        Toggleable('🌡️ Class Component — QuantumComponent + batch/untrack/on', () => new TemperatureConverter({}).element),
        Toggleable('🧹 onCleanup — Automatic Resource Teardown', () => CleanupDemo({})),
        Toggleable('🌱 createRoot — Isolated Ownership Scopes', () => RootDemo({})),
        Toggleable('⏳ createDeferred — Debounced Reactive Search', () => DeferredDemo({})),
        Toggleable('🎯 createSelector — O(1) List Selection', () => SelectorDemo({})),

        h('div', { class: 'footer' },
            h('p', { class: 'footer-brand' }, '⚛️ Built with Quantum Framework'),
            h('p', { class: 'footer-apis' }, 'createSignal · createEffect · createMemo · batch · untrack · on · onCleanup'),
            h('p', { class: 'footer-apis' }, 'createRoot · createDeferred · createSelector'),
            h('p', { class: 'footer-apis' }, 'h · render · Show · For · Switch · Match · Portal · Dynamic · createRef'),
            h('p', { class: 'footer-apis' }, 'classList · styleMap · defineComponent · QuantumComponent · onMount · onDestroy')
        )
    );
});

render(() => App({}), document.getElementById('app')!);
