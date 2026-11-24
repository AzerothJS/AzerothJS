// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createSignal, hydrate, render, renderToString } from 'azerothjs';
import { generateModule } from '../src/codegen.ts';
import { compileComponent } from './conformance/executor.ts';

const modes = ['client', 'universal', 'hydrate'] as const;
const hosts: HTMLElement[] = [];

afterEach(() =>
{
    for (const host of hosts.splice(0))
    {
        render(() => document.createElement('i'), host);
        host.remove();
    }
});

function mount(source: string, props: Record<string, unknown>, mode: typeof modes[number]): HTMLElement
{
    const Probe = compileComponent(source, 'Probe', { ssr: mode !== 'client' });
    const app = (): HTMLElement => Probe(props) as HTMLElement;
    const host = document.createElement('main');
    hosts.push(host);
    document.body.appendChild(host);
    if (mode === 'hydrate')
    {
        host.innerHTML = renderToString(app);
        const served = Array.from(host.querySelectorAll('*'));
        hydrate(app, host);
        expect(Array.from(host.querySelectorAll('*')).every((node, i) => node === served[i])).toBe(true);
        expect(host.querySelectorAll('*')).toHaveLength(served.length);
    }
    else
    {
        render(app, host);
    }
    return host;
}

describe.each(modes)('destructured defaults in %s', mode =>
{
    it.each([
        ['arrow', 'go = () => 7', 'go()', { go: () => 11 }, '7', '11'],
        ['conditional', 'value = false ? "x" : "y"', 'value', { value: 'sent' }, 'y', 'sent'],
        ['logical', 'value = false || "open"', 'value', { value: 'closed' }, 'open', 'closed'],
        ['assignment', 'value = called = "called"', 'value + "/" + called', { value: 'sent' }, 'called/called', 'sent/fresh'],
        ['renamed sibling', 'stateName: flag = true, label = flag ? "yes" : "no"', 'label', { label: 'given' }, 'yes', 'given'],
        ['arrow with a later binding', 'read = () => label, label = "yes"', 'read()', { read: () => 'no' }, 'yes', 'no'],
        ['nested binding default', 'box: { value = "leaf" } = {value:"box"}', 'value', { box: {} }, 'box', 'leaf'],
        ['shorthand in default', 'word = "desk", record = { word }', 'record.word', { record: { word: 'sent' } }, 'desk', 'sent'],
        ['shadowed parameter', 'flag = "outer", value = ((flag) => flag)("inner")', 'value', { value: 'sent' }, 'inner', 'sent']
    ] as const)('evaluates the %s case only on its fallback path', (_label, pattern, value, supplied, fallback, override) =>
    {
        const source = `let called = "fresh"; component Probe({ ${ pattern } }) { <output>{ ${ value } }</output> }`;
        expect(mount(source, {}, mode).textContent).toBe(fallback);
        expect(mount(source, supplied, mode).textContent).toBe(override);
    });

    it('reads live sibling fallbacks through a nested render callback and switches subscriptions on override', () =>
    {
        const source = `component Rows(p) { <article>{ p.children("shadow") }</article> }
            component Probe({ origin: station, caption = station, size = caption.length }) {
                <Rows>{ station => <section><input/><i title={ caption }>{ caption }</i><u>{ size }</u></section> }</Rows>
            }`;
        const [origin, setOrigin] = createSignal('North');
        const [override, setOverride] = createSignal<string | null | undefined>(undefined);
        const host = mount(source, { get origin()
        {
            return origin();
        }, get caption()
        {
            return override();
        } }, mode);
        const draft = host.querySelector('input')!;
        draft.value = 'retained';
        const snapshot = (): string[] => [host.querySelector('i')!.title, host.querySelector('i')!.textContent, host.querySelector('u')!.textContent];
        expect(snapshot()).toEqual(['North', 'North', '5']);
        setOrigin('East');
        expect(snapshot()).toEqual(['East', 'East', '4']);
        setOverride('');
        setOrigin('Center');
        expect(snapshot()).toEqual(['', '', '0']);
        setOverride(null);
        expect(snapshot()).toEqual(['Center', 'Center', '6']);
        expect(host.querySelector('input')).toBe(draft);
        expect(draft.value).toBe('retained');
    });
});

it('resolves the authored module binding named props in a parameter initializer', () =>
{
    const source = 'const props = { value: "module" }; component Probe({ label = props.value }) { <p>{ label }</p> }';
    expect(mount(source, { value: 'runtime' }, 'hydrate').textContent).toBe('module');
});

it.each(['label', '(() => label)()', 'typeof label'])('keeps an immediate forward read in its temporal dead zone (%s)', expression =>
{
    const source = `const label = "module"; component Probe({ value = ${ expression }, label = "later" }) { <p>{ value }</p> }`;
    const Probe = compileComponent(source, 'Probe');
    expect(renderToString(() => Probe({ value: 'given' }) as HTMLElement)).toContain('given');
    expect(() => renderToString(() => Probe({ label: 'supplied later' }) as HTMLElement)).toThrow(ReferenceError);
});

it('keeps a chain of shared fallback expressions bounded while generating code', () =>
{
    const chain = ['v0 = 1', ...Array.from({ length: 18 }, (_, i) => `v${ i + 1 } = v${ i } + v${ i }`)].join(', ');
    const source = `component Probe({ ${ chain } }) { <p>{ v18 }</p> }`;
    const code = generateModule(source).code;
    expect(code.length).toBeLessThan(16_000);
    expect(mount(source, { v17: 4 }, 'hydrate').textContent).toBe('8');
});

it('runs a shared fallback on each selected read and skips the full chain on override', () =>
{
    const source = 'component Probe({ tick, seed = tick(), left = seed, right = seed, total = left + right }) { <p>{ total }</p> }';
    const Probe = compileComponent(source, 'Probe');
    let calls = 0;
    const tick = (): number => ++calls;
    expect(renderToString(() => Probe({ tick, total: 0 }) as HTMLElement)).toContain('>0<');
    expect(calls).toBe(0);
    expect(renderToString(() => Probe({ tick }) as HTMLElement)).toContain('>3<');
    expect(calls).toBe(2);
});

it('calls and tags a sibling without binding the props receiver, and constructs a sibling class', () =>
{
    const source = `component Probe({ f, K, one = f(), two = f?.(), three = f\`test\`, item = new K(5) }) {
        <p>{[one,two,three,item.value].join("/")}</p> }`;
    const Probe = compileComponent(source, 'Probe');
    function who(this: unknown): string
    {
        return this === undefined ? 'bare' : 'method';
    }
    class Ticket
    {
        public value: number;

        constructor(value: number)
        {
            this.value = value;
        }
    }
    expect(renderToString(() => Probe({ f: who, K: Ticket }) as HTMLElement)).toContain('bare/bare/bare/5');
});

it('recovers after a cycle through a deferred closure and a failed initializer on the same instance', () =>
{
    const source = `component Probe({ earlier = () => later, later = earlier(), expose }) {
        expose(() => later);
        <p>ready</p>
    }`;
    const Probe = compileComponent(source, 'Probe');
    let callback: () => unknown = () => undefined;
    let supplied: (() => string) | undefined;
    const expose = (read: () => unknown): void =>
    {
        callback = read;
    };
    renderToString(() => Probe({ expose, get earlier()
    {
        return supplied;
    } }) as HTMLElement);
    expect(callback).toThrow(ReferenceError);
    const fail = new Error('try again');
    supplied = () =>
    {
        throw fail;
    };
    expect(callback).toThrow(fail);
    supplied = () => 'ready';
    expect(callback()).toBe('ready');
});

it('keeps an authored function call whose spelling matches an internal compiler marker', () =>
{
    const source = `const __azRow = fn => fn("local");
        component Probe({ name = "outer", value = __azRow(name => name) + "/" + name }) {
            <p>{ value }</p> }`;
    expect(mount(source, {}, 'hydrate').textContent).toBe('local/outer');
    const pair = `const __azSignal = () => ["first", "second"];
        component Probe({ name = "prop", value = (() => { const [first, name] = __azSignal(); return name; })() }) {
            <p>{ value }</p> }`;
    expect(mount(pair, {}, 'hydrate').textContent).toBe('second');
});

it('applies declaration order through a previously returned closure, including supplied later props', () =>
{
    const eager = 'component Probe({ first = () => last, middle = first(), last = 3 }) { <p>{ middle }</p> }';
    const Probe = compileComponent(eager, 'Probe');
    for (const props of [{}, { last: 4 }])
    {
        expect(() => renderToString(() => Probe(props) as HTMLElement)).toThrow(ReferenceError);
    }
    expect(renderToString(() => Probe({ first: () => 5 }) as HTMLElement)).toContain('>5<');
    const delayed = 'component Probe({ first = () => last, middle = () => first(), last = 3 }) { <p>{ middle() }</p> }';
    expect(mount(delayed, {}, 'hydrate').textContent).toBe('3');
});

it('preserves import.meta and new.target when an alias has the same spelling', () =>
{
    const source = 'component Probe({ meta, target, url = import.meta.url, site = new.target?.name }) { <p>{ url }{ site }</p> }';
    const { code } = generateModule(source);
    expect(code).toContain('import.meta.url');
    expect(code).toContain('new.target?.name');
    const ordinary = 'component Probe({ target, site = new.target?.name ?? "called" }) { <p>{ site }</p> }';
    expect(mount(ordinary, {}, 'hydrate').textContent).toBe('called');
});

it('resolves a method decorator before its method parameters bind', () =>
{
    const source = 'component Probe({ decorate, ticket = class { @decorate run(decorate) { return decorate; } } }) { <p>{ ticket.name }</p> }';
    const { code } = generateModule(source);
    expect(code).toMatch(/@\(__azRead\d*\(\)\) run\(decorate\) \{ return decorate; \}/);
});
