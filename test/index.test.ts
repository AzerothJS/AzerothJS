import { describe, it, expect } from 'vitest';
import {
    // ── Reactivity ──
    createSignal,
    createEffect,
    createMemo,
    batch,
    untrack,
    on,

    // ── Renderer ──
    h,
    render,
    Show,
    For,
    Switch,
    Match,
    Portal,
    destroyPortal,
    Dynamic,
    createRef,
    classList,
    styleMap,

    // ── Component ──
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy,
    AzerothComponent
} from '@azerothjs/core';

describe('AzerothJS — Public API', () =>
{
    // ══════════════════════════════════════════════════════════
    // REACTIVITY EXPORTS
    // ══════════════════════════════════════════════════════════

    describe('Reactivity', () =>
    {
        it('should export createSignal', () =>
        {
            expect(createSignal).toBeDefined();
            const [count, setCount] = createSignal(0);
            expect(count()).toBe(0);
            setCount(5);
            expect(count()).toBe(5);
        });

        it('should export createEffect', () =>
        {
            expect(createEffect).toBeDefined();
            const [count] = createSignal(0);
            let ran = false;
            const dispose = createEffect(() =>
            {
                count();
                ran = true;
            });
            expect(ran).toBe(true);
            dispose();
        });

        it('should export createMemo', () =>
        {
            expect(createMemo).toBeDefined();
            const [count] = createSignal(5);
            const doubled = createMemo(() => count() * 2);
            expect(doubled()).toBe(10);
        });

        it('should export batch', () =>
        {
            expect(batch).toBeDefined();
            const [a, setA] = createSignal(0);
            const [b, setB] = createSignal(0);
            let runCount = 0;

            createEffect(() =>
            {
                a();
                b();
                runCount++;
            });

            runCount = 0;
            batch(() =>
            {
                setA(1);
                setB(2);
            });
            expect(runCount).toBe(1);
        });

        it('should export untrack', () =>
        {
            expect(untrack).toBeDefined();
            const [tracked, setTracked] = createSignal(0);
            const [untracked, setUntracked] = createSignal('hello');
            let runCount = 0;

            createEffect(() =>
            {
                tracked();
                untrack(() => untracked());
                runCount++;
            });

            runCount = 0;
            setUntracked('world');
            expect(runCount).toBe(0);

            setTracked(1);
            expect(runCount).toBe(1);
        });

        it('should export on', () =>
        {
            expect(on).toBeDefined();
            const [count, setCount] = createSignal(0);
            const [name, setName] = createSignal('Alice');
            const results: number[] = [];

            const dispose = on([count], ([val]) =>
            {
                name();
                results.push(val as number);
            });

            setName('Bob');
            expect(results.length).toBe(1);

            setCount(5);
            expect(results.length).toBe(2);

            dispose();
        });
    });

    // ══════════════════════════════════════════════════════════
    // RENDERER EXPORTS
    // ══════════════════════════════════════════════════════════

    describe('Renderer', () =>
    {
        it('should export h', () =>
        {
            expect(h).toBeDefined();
            const el = h('div', { class: 'test' }, 'Hello');
            expect(el.tagName).toBe('DIV');
            expect(el.getAttribute('class')).toBe('test');
            expect(el.textContent).toBe('Hello');
        });

        it('should export render', () =>
        {
            expect(render).toBeDefined();
            const container = document.createElement('div');
            render(() => h('p', {}, 'Mounted'), container);
            expect(container.textContent).toBe('Mounted');
        });

        it('should export Show', () =>
        {
            expect(Show).toBeDefined();
            const [visible, setVisible] = createSignal(true);
            const el = Show({
                when: visible,
                fallback: () => h('p', {}, 'Hidden'),
                children: () => h('p', {}, 'Visible')
            });

            expect(el.textContent).toBe('Visible');
            setVisible(false);
            expect(el.textContent).toBe('Hidden');
        });

        it('should export For', () =>
        {
            expect(For).toBeDefined();
            const [items, setItems] = createSignal(['A', 'B', 'C']);
            const el = For({
                each: items,
                key: (item) => item,
                children: (item) => h('span', {}, item)
            });

            expect(el.children.length).toBe(3);
            expect(el.textContent).toBe('ABC');

            setItems(['A', 'C']);
            expect(el.children.length).toBe(2);
            expect(el.textContent).toBe('AC');
        });

        it('should export Switch and Match', () =>
        {
            expect(Switch).toBeDefined();
            expect(Match).toBeDefined();

            const [status, setStatus] = createSignal('loading');
            const el = Switch({ children: [
                Match({ when: () => status() === 'loading', children: () => h('p', {}, 'Loading...') }),
                Match({ when: () => status() === 'done', children: () => h('p', {}, 'Done!') })
            ] });

            expect(el.textContent).toBe('Loading...');
            setStatus('done');
            expect(el.textContent).toBe('Done!');
        });

        it('should export Portal and destroyPortal', () =>
        {
            expect(Portal).toBeDefined();
            expect(destroyPortal).toBeDefined();

            const target = document.createElement('div');
            const placeholder = Portal({ target, children: () => h('p', {}, 'Portaled') });

            expect(target.textContent).toBe('Portaled');
            expect(placeholder.style.display).toBe('none');

            destroyPortal(placeholder);
            expect(target.children.length).toBe(0);
        });

        it('should export Dynamic', () =>
        {
            expect(Dynamic).toBeDefined();

            const CompA = (): HTMLElement => h('div', {}, 'A');
            const CompB = (): HTMLElement => h('div', {}, 'B');
            const [view, setView] = createSignal(CompA);

            const el = Dynamic({ component: view });
            expect(el.textContent).toBe('A');

            setView(() => CompB);
            expect(el.textContent).toBe('B');
        });

        it('should export createRef', () =>
        {
            expect(createRef).toBeDefined();

            const ref = createRef<HTMLInputElement>();
            expect(ref.current).toBeNull();

            ref.current = h('input', { type: 'text' }) as HTMLInputElement;
            expect(ref.current.tagName).toBe('INPUT');
        });

        it('should export classList', () =>
        {
            expect(classList).toBeDefined();

            const [isActive, setIsActive] = createSignal(false);
            const cls = classList({
                'btn': true,
                'btn-active': isActive
            });

            expect(cls()).toBe('btn');
            setIsActive(true);
            expect(cls()).toBe('btn btn-active');
        });

        it('should export styleMap', () =>
        {
            expect(styleMap).toBeDefined();

            const [color, setColor] = createSignal('red');
            const style = styleMap({
                color: color,
                fontSize: '16px'
            });

            expect(style()).toBe('color: red; font-size: 16px');
            setColor('blue');
            expect(style()).toBe('color: blue; font-size: 16px');
        });

        it('should support array children in h()', () =>
        {
            const items = ['X', 'Y', 'Z'];
            const el = h('ul', {},
                items.map(item => h('li', {}, item))
            );

            expect(el.children.length).toBe(3);
            expect(el.children[0].textContent).toBe('X');
            expect(el.children[1].textContent).toBe('Y');
            expect(el.children[2].textContent).toBe('Z');
        });
    });

    // ══════════════════════════════════════════════════════════
    // COMPONENT EXPORTS
    // ══════════════════════════════════════════════════════════

    describe('Component', () =>
    {
        it('should export defineComponent', () =>
        {
            expect(defineComponent).toBeDefined();

            const MyComp = defineComponent(() =>
            {
                return h('div', {}, 'Component');
            });

            const el = MyComp({});
            expect(el.textContent).toBe('Component');
        });

        it('should export destroyComponent', () =>
        {
            expect(destroyComponent).toBeDefined();
        });

        it('should export onMount', () =>
        {
            expect(onMount).toBeDefined();

            let mounted = false;
            const Comp = defineComponent(() =>
            {
                onMount(() =>
                {
                    mounted = true;
                });
                return h('div', {}, 'Test');
            });

            Comp({});
            expect(mounted).toBe(true);
        });

        it('should export onDestroy', () =>
        {
            expect(onDestroy).toBeDefined();

            let destroyed = false;
            const Comp = defineComponent(() =>
            {
                onDestroy(() =>
                {
                    destroyed = true;
                });
                return h('div', {}, 'Test');
            });

            const el = Comp({});
            expect(destroyed).toBe(false);

            destroyComponent(el);
            expect(destroyed).toBe(true);
        });

        it('should support props in defineComponent', () =>
        {
            interface Props
            {
                name: string;
                age: number;
            }

            const Profile = defineComponent<Props>((props) =>
            {
                return h('div', {},
                    h('span', {}, `${ props.name }, ${ props.age }`)
                );
            });

            const el = Profile({ name: 'Alice', age: 30 });
            expect(el.textContent).toBe('Alice, 30');
        });

        it('should export AzerothComponent', () =>
        {
            expect(AzerothComponent).toBeDefined();

            class TestClass extends AzerothComponent
            {
                public render(): HTMLElement
                {
                    return h('div', {}, 'Class Component');
                }
            }

            const comp = new TestClass({});
            expect(comp.element.textContent).toBe('Class Component');
        });

        it('should support AzerothComponent with createSignal', () =>
        {
            class Counter extends AzerothComponent<{ initial: number }>
            {
                public count = this.createSignal(this.props.initial);

                public render(): HTMLElement
                {
                    return h('div', {},
                        h('span', { class: 'val' }, () => `${ this.count() }`)
                    );
                }
            }

            const comp = new Counter({ initial: 7 });
            expect(comp.element.querySelector('.val')!.textContent).toBe('7');

            comp.count.set(99);
            expect(comp.element.querySelector('.val')!.textContent).toBe('99');
        });

        it('should support AzerothComponent with standalone utilities', () =>
        {
            class BatchComp extends AzerothComponent
            {
                public a = this.createSignal(0);
                public b = this.createSignal(0);
                public sum = this.createMemo(() => this.a() + this.b());

                public render(): HTMLElement
                {
                    return h('div', {},
                        h('span', { class: 'sum' }, () => `${ this.sum() }`)
                    );
                }
            }

            const comp = new BatchComp({});
            expect(comp.element.querySelector('.sum')!.textContent).toBe('0');

            batch(() =>
            {
                comp.a.set(10);
                comp.b.set(20);
            });

            expect(comp.element.querySelector('.sum')!.textContent).toBe('30');
        });
    });

    // ══════════════════════════════════════════════════════════
    // INTEGRATION
    // ══════════════════════════════════════════════════════════

    describe('Integration', () =>
    {
        it('should build a full reactive app with function components', () =>
        {
            const [items, setItems] = createSignal([
                { id: 1, text: 'Buy milk' },
                { id: 2, text: 'Walk dog' }
            ]);

            const [filter, setFilter] = createSignal('');

            const filteredItems = createMemo(() =>
            {
                const f = filter().toLowerCase();
                return f.length === 0
                    ? items()
                    : items().filter(i => i.text.toLowerCase().includes(f));
            });

            const count = createMemo(() => filteredItems().length);

            const App = defineComponent(() =>
            {
                const inputRef = createRef<HTMLInputElement>();

                onMount(() =>
                {
                    expect(inputRef.current).not.toBeNull();
                });

                const input = h('input', {
                    type: 'text',
                    placeholder: 'Filter...',
                    onInput: (e: Event) =>
                    {
                        setFilter((e.target as HTMLInputElement).value);
                    }
                });
                inputRef.current = input as HTMLInputElement;

                return h('div', {
                    class: classList({ 'app': true, 'loaded': () => true })
                },
                input,
                h('p', {
                    style: styleMap({ color: 'green', fontWeight: 'bold' })
                }, () => `${ count() } items`),
                For({
                    each: filteredItems,
                    key: (item) => item.id,
                    children: (item) => h('div', {}, item.text)
                }),
                Show({
                    when: () => count() === 0,
                    children: () => h('p', {}, 'No items match your filter')
                })
                );
            });

            const container = document.createElement('div');
            render(() => App({}), container);

            expect(container.textContent).toContain('2 items');
            expect(container.textContent).toContain('Buy milk');
            expect(container.textContent).toContain('Walk dog');

            setItems(prev => [...prev, { id: 3, text: 'Cook dinner' }]);
            expect(container.textContent).toContain('3 items');
            expect(container.textContent).toContain('Cook dinner');
        });

        it('should build a full reactive app with class components', () =>
        {
            class TodoApp extends AzerothComponent
            {
                public todos = this.createSignal([
                    { id: 1, text: 'Learn AzerothJS' },
                    { id: 2, text: 'Build app' }
                ]);
                public count = this.createMemo(() => this.todos().length);

                public addTodo(text: string): void
                {
                    this.todos.set(prev =>
                        [...prev, { id: Date.now(), text }]
                    );
                }

                public render(): HTMLElement
                {
                    return h('div', {},
                        h('span', { class: 'count' },
                            () => `${ this.count() } todos`),
                        h('button', {
                            class: 'add',
                            onClick: () => this.addTodo('New task')
                        }, 'Add')
                    );
                }
            }

            const app = new TodoApp({});
            expect(app.element.querySelector('.count')!.textContent)
                .toBe('2 todos');

            (app.element.querySelector('.add') as HTMLButtonElement).click();
            expect(app.element.querySelector('.count')!.textContent)
                .toBe('3 todos');
        });

        it('should mix function and class components', () =>
        {
            class ClassCounter extends AzerothComponent<{ initial: number }>
            {
                public count = this.createSignal(this.props.initial);

                public render(): HTMLElement
                {
                    return h('div', { class: 'class-counter' },
                        h('span', { class: 'val' }, () => `${ this.count() }`),
                        h('button', {
                            class: 'inc',
                            onClick: () => this.count.set(prev => prev + 1)
                        }, '+')
                    );
                }
            }

            const FnWrapper = defineComponent(() =>
            {
                onMount(() =>
                {
                    // Function component wrapping a class component
                });

                const counter = new ClassCounter({ initial: 10 });

                return h('div', {},
                    h('h1', {}, 'Mixed Components'),
                    counter.element
                );
            });

            const container = document.createElement('div');
            render(() => FnWrapper({}), container);

            expect(container.querySelector('.val')!.textContent).toBe('10');

            (container.querySelector('.inc') as HTMLButtonElement).click();
            expect(container.querySelector('.val')!.textContent).toBe('11');
        });
    });
});
