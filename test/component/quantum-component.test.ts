import { describe, it, expect, vi } from 'vitest';
import { AzerothComponent, destroyComponent, h, batch, untrack, on, createEffect } from '@azerothjs/core';

describe('AzerothComponent', () =>
{
    it('should render a basic component', () =>
    {
        class Hello extends AzerothComponent
        {
            public render(): HTMLElement
            {
                return h('div', {}, 'Hello World');
            }
        }

        const comp = new Hello({});
        expect(comp.element.textContent).toBe('Hello World');
    });

    it('should receive props', () =>
    {
        class Greeting extends AzerothComponent<{ name: string }>
        {
            public render(): HTMLElement
            {
                return h('p', {}, `Hello, ${ this.props.name }!`);
            }
        }

        const comp = new Greeting({ name: 'AzerothJS' });
        expect(comp.element.textContent).toBe('Hello, AzerothJS!');
    });

    it('should use props in field initializers', () =>
    {
        class PropsComp extends AzerothComponent<{ start: number; label: string }>
        {
            public count = this.createSignal(this.props.start);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'label' }, this.props.label),
                    h('span', { class: 'count' }, () => `${ this.count() }`)
                );
            }
        }

        const comp = new PropsComp({ start: 42, label: 'Score' });
        expect(comp.element.querySelector('.label')!.textContent).toBe('Score');
        expect(comp.element.querySelector('.count')!.textContent).toBe('42');
    });

    it('should call onMount() after render()', () =>
    {
        const order: string[] = [];

        class TestComp extends AzerothComponent
        {
            public render(): HTMLElement
            {
                order.push('render');
                return h('div', {});
            }

            public onMount(): void
            {
                order.push('mount');
            }
        }

        const comp = new TestComp({});
        void comp.element;
        expect(order).toEqual(['render', 'mount']);
    });

    it('should call onDestroy() when destroyed', () =>
    {
        const destroyFn = vi.fn();

        class TestComp extends AzerothComponent
        {
            public render(): HTMLElement
            {
                return h('div', {});
            }

            public onDestroy(): void
            {
                destroyFn();
            }
        }

        const comp = new TestComp({});
        void comp.element;
        expect(destroyFn).not.toHaveBeenCalled();

        comp.destroy();
        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('should not call onDestroy() twice', () =>
    {
        const destroyFn = vi.fn();

        class TestComp extends AzerothComponent
        {
            public render(): HTMLElement
            {
                return h('div', {});
            }

            public onDestroy(): void
            {
                destroyFn();
            }
        }

        const comp = new TestComp({});
        void comp.element;
        comp.destroy();
        comp.destroy();
        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('should follow full lifecycle order', () =>
    {
        const order: string[] = [];

        class LifecycleComp extends AzerothComponent<{ label: string }>
        {
            public count = this.createSignal(0);

            public onMount(): void
            {
                order.push(`${ this.props.label }:mount`);
            }

            public onDestroy(): void
            {
                order.push(`${ this.props.label }:destroy`);
            }

            public render(): HTMLElement
            {
                order.push(`${ this.props.label }:render`);
                return h('div', {}, this.props.label);
            }
        }

        const comp = new LifecycleComp({ label: 'test' });
        void comp.element;
        expect(order).toEqual(['test:render', 'test:mount']);

        comp.destroy();
        expect(order).toEqual(['test:render', 'test:mount', 'test:destroy']);
    });

    it('should work with destroyComponent()', () =>
    {
        const destroyFn = vi.fn();

        class TestComp extends AzerothComponent
        {
            public render(): HTMLElement
            {
                return h('div', {});
            }

            public onDestroy(): void
            {
                destroyFn();
            }
        }

        const comp = new TestComp({});
        destroyComponent(comp.element);
        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    // ══════════════════════════════════════════════════════════
    // this.createSignal()
    // ══════════════════════════════════════════════════════════

    it('should support createSignal — read and set', () =>
    {
        class Counter extends AzerothComponent<{ initial: number }>
        {
            public count = this.createSignal(this.props.initial);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'value' }, () => `${ this.count() }`)
                );
            }
        }

        const comp = new Counter({ initial: 5 });
        expect(comp.element.querySelector('.value')!.textContent).toBe('5');

        comp.count.set(10);
        expect(comp.element.querySelector('.value')!.textContent).toBe('10');
    });

    it('should support createSignal — updater function', () =>
    {
        class Counter extends AzerothComponent
        {
            public count = this.createSignal(0);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'value' }, () => `${ this.count() }`)
                );
            }
        }

        const comp = new Counter({});
        expect(comp.element.querySelector('.value')!.textContent).toBe('0');

        comp.count.set(prev => prev + 5);
        expect(comp.element.querySelector('.value')!.textContent).toBe('5');

        comp.count.set(prev => prev * 2);
        expect(comp.element.querySelector('.value')!.textContent).toBe('10');
    });

    it('should support createSignal.value — untracked read', () =>
    {
        class ValComp extends AzerothComponent
        {
            public count = this.createSignal(42);

            public render(): HTMLElement
            {
                return h('div', {});
            }
        }

        const comp = new ValComp({});
        void comp.element;
        expect(comp.count.value).toBe(42);

        comp.count.set(99);
        expect(comp.count.value).toBe(99);
    });

    it('should NOT subscribe an effect when reading .value', () =>
    {
        class ValComp extends AzerothComponent
        {
            public count = this.createSignal(0);

            public render(): HTMLElement
            {
                return h('div', {});
            }
        }

        const comp = new ValComp({});
        void comp.element;

        let runs = 0;
        createEffect(() =>
        {
            // Reading `.value` must NOT create a dependency.
            void comp.count.value;
            runs++;
        });

        expect(runs).toBe(1);

        comp.count.set(1);
        expect(runs).toBe(1); // effect did NOT re-run — `.value` is untracked
    });

    it('createMemo should store a function value verbatim, not invoke it', () =>
    {
        const fnA = (): string => 'A';
        const fnB = (): string => 'B';

        class C extends AzerothComponent
        {
            public flag = this.createSignal(true);
            public handler = this.createMemo<() => string>(() => (this.flag() ? fnA : fnB));

            public render(): HTMLElement
            {
                return h('div', {});
            }
        }

        const comp = new C({});
        void comp.element;

        expect(comp.handler()).toBe(fnA);
        expect(comp.handler()()).toBe('A');

        comp.flag.set(false);
        expect(comp.handler()).toBe(fnB);
    });

    it('should support multiple state values', () =>
    {
        class Form extends AzerothComponent
        {
            public name = this.createSignal('Alice');
            public age = this.createSignal(30);
            public summary = this.createMemo(() => `${ this.name() }, ${ this.age() }`);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'summary' }, () => this.summary())
                );
            }
        }

        const comp = new Form({});
        expect(comp.element.querySelector('.summary')!.textContent).toBe('Alice, 30');

        comp.name.set('Bob');
        expect(comp.element.querySelector('.summary')!.textContent).toBe('Bob, 30');

        comp.age.set(25);
        expect(comp.element.querySelector('.summary')!.textContent).toBe('Bob, 25');
    });

    it('should support event handlers — no this issues', () =>
    {
        class Clicker extends AzerothComponent
        {
            public count = this.createSignal(0);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'val' }, () => `${ this.count() }`),
                    h('button', {
                        class: 'inc',
                        onClick: () => this.count.set(prev => prev + 1)
                    }, '+'),
                    h('button', {
                        class: 'reset',
                        onClick: () => this.count.set(0)
                    }, 'Reset')
                );
            }
        }

        const comp = new Clicker({});
        expect(comp.element.querySelector('.val')!.textContent).toBe('0');

        (comp.element.querySelector('.inc') as HTMLButtonElement).click();
        expect(comp.element.querySelector('.val')!.textContent).toBe('1');

        (comp.element.querySelector('.inc') as HTMLButtonElement).click();
        (comp.element.querySelector('.inc') as HTMLButtonElement).click();
        expect(comp.element.querySelector('.val')!.textContent).toBe('3');

        (comp.element.querySelector('.reset') as HTMLButtonElement).click();
        expect(comp.element.querySelector('.val')!.textContent).toBe('0');
    });

    // ══════════════════════════════════════════════════════════
    // this.createMemo()
    // ══════════════════════════════════════════════════════���═══

    it('should support createMemo()', () =>
    {
        class DoubleCounter extends AzerothComponent<{ initial: number }>
        {
            public count = this.createSignal(this.props.initial);
            public doubled = this.createMemo(() => this.count() * 2);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'doubled' }, () => `${ this.doubled() }`)
                );
            }
        }

        const comp = new DoubleCounter({ initial: 3 });
        expect(comp.element.querySelector('.doubled')!.textContent).toBe('6');

        comp.count.set(10);
        expect(comp.element.querySelector('.doubled')!.textContent).toBe('20');
    });

    it('should support chained memos', () =>
    {
        class Chain extends AzerothComponent
        {
            public count = this.createSignal(2);
            public doubled = this.createMemo(() => this.count() * 2);
            public quadrupled = this.createMemo(() => this.doubled() * 2);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'quad' }, () => `${ this.quadrupled() }`)
                );
            }
        }

        const comp = new Chain({});
        expect(comp.element.querySelector('.quad')!.textContent).toBe('8');

        comp.count.set(5);
        expect(comp.element.querySelector('.quad')!.textContent).toBe('20');
    });

    it('should support boolean memos', () =>
    {
        class BoolComp extends AzerothComponent
        {
            public count = this.createSignal(0);
            public isPositive = this.createMemo(() => this.count() > 0);
            public isEven = this.createMemo(() => this.count() % 2 === 0);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'pos' }, () => `${ this.isPositive() }`),
                    h('span', { class: 'even' }, () => `${ this.isEven() }`)
                );
            }
        }

        const comp = new BoolComp({});
        expect(comp.element.querySelector('.pos')!.textContent).toBe('false');
        expect(comp.element.querySelector('.even')!.textContent).toBe('true');

        comp.count.set(3);
        expect(comp.element.querySelector('.pos')!.textContent).toBe('true');
        expect(comp.element.querySelector('.even')!.textContent).toBe('false');
    });

    // ══════════════════════════════════════════════════════════
    // this.createEffect()
    // ══════════════════════════════════════════════════════════

    it('should support createEffect() and auto-dispose on destroy', () =>
    {
        const effectFn = vi.fn();

        class TestComp extends AzerothComponent
        {
            public count = this.createSignal(0);

            public onMount(): void
            {
                this.createEffect(() => effectFn(this.count()));
            }

            public render(): HTMLElement
            {
                return h('div', {});
            }
        }

        const comp = new TestComp({});
        void comp.element;
        expect(effectFn).toHaveBeenCalledWith(0);

        comp.count.set(5);
        expect(effectFn).toHaveBeenCalledWith(5);

        comp.destroy();
        comp.count.set(10);
        expect(effectFn).not.toHaveBeenCalledWith(10);
    });

    it('should support multiple effects', () =>
    {
        const effect1 = vi.fn();
        const effect2 = vi.fn();

        class MultiEffect extends AzerothComponent
        {
            public a = this.createSignal(0);
            public b = this.createSignal(0);

            public onMount(): void
            {
                this.createEffect(() => effect1(this.a()));
                this.createEffect(() => effect2(this.b()));
            }

            public render(): HTMLElement
            {
                return h('div', {});
            }
        }

        const comp = new MultiEffect({});
        void comp.element;
        expect(effect1).toHaveBeenCalledWith(0);
        expect(effect2).toHaveBeenCalledWith(0);

        comp.a.set(1);
        expect(effect1).toHaveBeenCalledWith(1);
        expect(effect2).toHaveBeenCalledTimes(1);

        comp.b.set(2);
        expect(effect2).toHaveBeenCalledWith(2);
        expect(effect1).toHaveBeenCalledTimes(2);

        comp.destroy();
        comp.a.set(99);
        comp.b.set(99);
        expect(effect1).toHaveBeenCalledTimes(2);
        expect(effect2).toHaveBeenCalledTimes(2);
    });

    // ══════════════════════════════════════════════════════════
    // STANDALONE UTILITIES — batch, untrack, on
    // ══════════════════════════════════════════════════════════

    it('should work with batch()', () =>
    {
        class MultiState extends AzerothComponent
        {
            public first = this.createSignal('Jane');
            public last = this.createSignal('Smith');
            public full = this.createMemo(() => `${ this.first() } ${ this.last() }`);

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'full' }, () => this.full())
                );
            }
        }

        const comp = new MultiState({});
        expect(comp.element.querySelector('.full')!.textContent).toBe('Jane Smith');

        batch(() =>
        {
            comp.first.set('John');
            comp.last.set('Doe');
        });

        expect(comp.element.querySelector('.full')!.textContent).toBe('John Doe');
    });

    it('should work with batch() inside class methods', () =>
    {
        class BatchComp extends AzerothComponent
        {
            public x = this.createSignal(0);
            public y = this.createSignal(0);
            public sum = this.createMemo(() => this.x() + this.y());

            public updateBoth(a: number, b: number): void
            {
                batch(() =>
                {
                    this.x.set(a);
                    this.y.set(b);
                });
            }

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'sum' }, () => `${ this.sum() }`)
                );
            }
        }

        const comp = new BatchComp({});
        expect(comp.element.querySelector('.sum')!.textContent).toBe('0');

        comp.updateBoth(10, 20);
        expect(comp.element.querySelector('.sum')!.textContent).toBe('30');
    });

    it('should work with untrack()', () =>
    {
        const effectFn = vi.fn();

        class UntrackComp extends AzerothComponent
        {
            public tracked = this.createSignal(0);
            public untracked = this.createSignal('hello');

            public onMount(): void
            {
                this.createEffect(() =>
                {
                    const t = this.tracked();
                    const u = untrack(() => this.untracked());
                    effectFn(t, u);
                });
            }

            public render(): HTMLElement
            {
                return h('div', {});
            }
        }

        const comp = new UntrackComp({});
        void comp.element;
        expect(effectFn).toHaveBeenCalledWith(0, 'hello');

        comp.untracked.set('world');
        expect(effectFn).toHaveBeenCalledTimes(1);

        comp.tracked.set(1);
        expect(effectFn).toHaveBeenCalledWith(1, 'world');
        expect(effectFn).toHaveBeenCalledTimes(2);
    });

    it('should work with on()', () =>
    {
        const results: unknown[] = [];

        class OnComp extends AzerothComponent
        {
            public count = this.createSignal(0);
            public name = this.createSignal('Alice');

            public onMount(): void
            {
                on([this.count], ([val]) =>
                {
                    this.name();
                    results.push(val);
                }, { defer: true });
            }

            public render(): HTMLElement
            {
                return h('div', {});
            }
        }

        const comp = new OnComp({});
        void comp.element;
        expect(results).toEqual([]);

        comp.name.set('Bob');
        expect(results).toEqual([]);

        comp.count.set(5);
        expect(results).toEqual([5]);

        comp.count.set(10);
        expect(results).toEqual([5, 10]);
    });

    it('should work with on() — provides previous values', () =>
    {
        const changes: Array<{ prev: unknown; curr: unknown }> = [];

        class PrevComp extends AzerothComponent
        {
            public count = this.createSignal(0);

            public onMount(): void
            {
                on([this.count], ([curr], [prev]) =>
                {
                    changes.push({ prev, curr });
                });
            }

            public render(): HTMLElement
            {
                return h('div', {});
            }
        }

        const comp = new PrevComp({});
        void comp.element;
        expect(changes).toEqual([{ prev: undefined, curr: 0 }]);

        comp.count.set(5);
        expect(changes).toEqual([
            { prev: undefined, curr: 0 },
            { prev: 0, curr: 5 }
        ]);
    });

    it('should combine batch + untrack + on in one component', () =>
    {
        const effectLog: string[] = [];
        const onLog: number[] = [];

        class CombinedComp extends AzerothComponent
        {
            public count = this.createSignal(0);
            public label = this.createSignal('item');
            public total = this.createMemo(() => this.count() * 10);

            public onMount(): void
            {
                on([this.count], ([val]) =>
                {
                    onLog.push(val as number);
                }, { defer: true });

                this.createEffect(() =>
                {
                    const c = this.count();
                    const l = untrack(() => this.label());
                    effectLog.push(`${ l }:${ c }`);
                });
            }

            public batchUpdate(): void
            {
                batch(() =>
                {
                    this.count.set(prev => prev + 1);
                    this.label.set('updated');
                });
            }

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'total' }, () => `${ this.total() }`)
                );
            }
        }

        const comp = new CombinedComp({});
        void comp.element;
        expect(effectLog).toEqual(['item:0']);
        expect(onLog).toEqual([]);

        comp.label.set('changed');
        expect(effectLog).toEqual(['item:0']);
        expect(onLog).toEqual([]);

        comp.batchUpdate();
        expect(effectLog).toEqual(['item:0', 'updated:1']);
        expect(onLog).toEqual([1]);
        expect(comp.element.querySelector('.total')!.textContent).toBe('10');
    });

    // ══════════════════════════════════════════════════════════
    // COMPLEX SCENARIOS
    // ══════════════════════════════════════════════════════════

    it('should support a full todo list class component', () =>
    {
        interface TodoItem
        {
            id: number;
            text: string;
            done: boolean;
        }

        class TodoList extends AzerothComponent
        {
            public todos = this.createSignal<TodoItem[]>([]);
            public filter = this.createSignal<'all' | 'done'>('all');
            public filtered = this.createMemo(() =>
            {
                const f = this.filter();
                const list = this.todos();
                return f === 'done' ? list.filter(t => t.done) : list;
            });
            public count = this.createMemo(() => this.filtered().length);

            private nextId = 0;

            public addTodo(text: string): void
            {
                this.todos.set(prev =>
                    [...prev, { id: this.nextId++, text, done: false }]
                );
            }

            public toggleTodo(id: number): void
            {
                this.todos.set(prev => prev.map(t =>
                    t.id === id ? { ...t, done: !t.done } : t
                ));
            }

            public render(): HTMLElement
            {
                return h('div', {},
                    h('span', { class: 'count' }, () => `${ this.count() }`)
                );
            }
        }

        const comp = new TodoList({});
        expect(comp.element.querySelector('.count')!.textContent).toBe('0');

        comp.addTodo('Buy milk');
        comp.addTodo('Walk dog');
        expect(comp.element.querySelector('.count')!.textContent).toBe('2');

        comp.toggleTodo(0);
        comp.filter.set('done');
        expect(comp.element.querySelector('.count')!.textContent).toBe('1');

        comp.filter.set('all');
        expect(comp.element.querySelector('.count')!.textContent).toBe('2');
    });

    it('should only init once even if element is accessed multiple times', () =>
    {
        let renderCount = 0;

        class TestComp extends AzerothComponent
        {
            public render(): HTMLElement
            {
                renderCount++;
                return h('div', {}, 'test');
            }
        }

        const comp = new TestComp({});
        void comp.element;
        void comp.element;
        void comp.element;
        expect(renderCount).toBe(1);
    });
});
