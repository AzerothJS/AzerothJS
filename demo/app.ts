// ============================================================================
// QUANTUM FRAMEWORK — Demo Application
// ============================================================================
//
// This demo showcases every feature of the Quantum reactivity system:
//   - createSignal — Reactive state
//   - createEffect — Side effects
//   - createMemo — Computed values
//   - batch — Grouped updates
//   - h — Direct DOM creation
//   - render — Mount to DOM
//
// Open this with: npx vite demo
// ============================================================================

import { createSignal, createEffect, createMemo, batch, h, render } from '../src';

function Counter(): HTMLElement
{
    const [count, setCount] = createSignal(0);
    const doubled = createMemo(() => count() * 2);
    const isEven = createMemo(() => count() % 2 === 0);

    return h('div', { class: 'card' },
        h('h2', {}, '⚡ Reactive Counter'),
        h('div', { class: 'counter' },
            h('button', { onClick: () => setCount(prev => prev - 1) }, '−'),
            h('span', { class: 'counter-value' }, () => `${count()}`),
            h('button', { onClick: () => setCount(prev => prev + 1) }, '+'),
        ),
        h('div', { class: 'info' },
            h('span', {}, () => `Doubled: ${doubled()}`),
            h('span', {}, () => `${isEven() ? 'Even' : 'Odd'}`),
        ),
        h('button', { class: 'reset-btn', onClick: () => setCount(0) }, 'Reset'),
    );
}

function Greeting(): HTMLElement
{
    const [name, setName] = createSignal('');
    const greeting = createMemo(() =>
    {
        const n = name().trim();
        return n.length > 0 ? `Hello, ${n}! 👋` : '';
    });

    return h('div', { class: 'card' },
        h('h2', {}, '🎤 Reactive Input'),
        h('div', { class: 'input-section' },
            h('input', {
                type: 'text',
                placeholder: 'Type your name...',
                onInput: (e: Event) => setName((e.target as HTMLInputElement).value),
            }),
            h('p', { class: 'greeting' }, () => greeting()),
        ),
    );
}

interface Todo
{
    id: number;
    text: string;
}

function TodoApp(): HTMLElement
{
    const [todos, setTodos] = createSignal<Todo[]>([]);
    const [inputText, setInputText] = createSignal('');
    const todoCount = createMemo(() => todos().length);

    let nextId = 0;

    function addTodo(): void
    {
        const text = inputText().trim();
        if (text.length === 0)
            return;

        batch(() =>
        {
            setTodos(prev => [...prev, { id: nextId++, text }]);
            setInputText('');
        });
    }

    function removeTodo(id: number): void
    {
        setTodos(prev => prev.filter(t => t.id !== id));
    }

    createEffect(() =>
    {
        console.log(`📝 Todo count: ${todoCount()}`);
    });

    return h('div', { class: 'card' },
        h('h2', {}, '📋 Reactive Todo List'),
        h('div', { class: 'todo-input' },
            h('input', {
                type: 'text',
                placeholder: 'Add a todo...',
                value: () => inputText(),
                onInput: (e: Event) =>
                {
                    setInputText((e.target as HTMLInputElement).value);
                },
                onKeydown: (e: KeyboardEvent) =>
                {
                    if (e.key === 'Enter')
                        addTodo();
                },
            }),
            h('button', { onClick: addTodo }, 'Add'),
        ),
        h('div', {}, () =>
        {
            const list = todos();
            if (list.length === 0)
            {
                return h('p', { class: 'todo-count' }, 'No todos yet. Add one above!');
            }

            const ul = h('div', { class: 'todo-list' });
            for (const todo of list)
            {
                ul.appendChild(
                    h('div', { class: 'todo-item' },
                        h('span', { class: 'todo-text' }, todo.text),
                        h('button', {
                            class: 'todo-delete',
                            onClick: () => removeTodo(todo.id),
                        }, '✕'),
                    ),
                );
            }
            return ul;
        }),
        h('p', { class: 'todo-count' }, () => `${todoCount()} item${todoCount() === 1 ? '' : 's'}`),
    );
}

function App(): HTMLElement
{
    return h('div', { class: 'app' },
        h('div', { class: 'header' },
            h('h1', {}, 'QuantumJS'),
            h('p', {}, 'Fine-grained reactivity. No virtual DOM. Direct DOM updates.'),
        ),
        Counter(),
        Greeting(),
        TodoApp(),
        h('div', { class: 'footer' },
            h('p', {}, 'Built with Quantum Framework — 0 dependencies'),
        ),
    );
}

render(App, document.getElementById('app')!);
