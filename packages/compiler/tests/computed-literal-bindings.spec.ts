// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createSignal, hydrate, render, renderToString } from 'azerothjs';
import { generateVirtualCode } from '../src/project.ts';
import { compileComponent } from './conformance/executor.ts';

const cases = [
    ["['pill', read()].filter(Boolean).join(' ')", 'pill red', 'pill blue'],
    ["['red', 'blue'][+(read() === 'blue')]", 'red', 'blue'],
    ["[read()].includes('red') ? 'red' : 'blue'", 'red', 'blue'],
    ["{ red: 'R', blue: 'B' }[read()]", 'R', 'B'],
    ['(() => read())()', 'red', 'blue'],
    ['(function () { return read(); })()', 'red', 'blue']
] as const;

describe.each(['render', 'client', 'hydrate'] as const)('computed literal binding in %s', mode =>
{
    it.each(cases)('updates %s alongside its call-shaped control', (expr, initial, updated) =>
    {
        const source = `component Probe(props) {
            const read = props.read;
            <section><i title={ ${ expr } }>{ ${ expr } }</i><b>{ read() }</b></section>
        }`;
        const component = compileComponent(source, 'Probe', { ssr: mode !== 'client' });
        const [read, write] = createSignal('red');
        const app = (): HTMLElement => component({ read }) as HTMLElement;
        const host = document.createElement('div');
        if (mode === 'hydrate')
        {
            host.innerHTML = renderToString(app);
            const original = host.firstElementChild;
            hydrate(app, host);
            expect(host.firstElementChild).toBe(original);
        }
        else
        {
            render(app, host);
        }
        try
        {
            const label = host.querySelector('i');
            expect([label?.getAttribute('title'), label?.textContent]).toEqual([initial, initial]);
            write('blue');
            expect(host.querySelector('b')?.textContent).toBe('blue');
            expect([label?.getAttribute('title'), label?.textContent]).toEqual([updated, updated]);
        }
        finally
        {
            render(() => document.createElement('div'), host);
        }
    });
});

it.each(['render', 'client', 'hydrate'] as const)('updates a joined class in a block-bodied child in %s', mode =>
{
    const source = `component Wrap(props) { <div>{ props.children() }</div> }
        component Probe(props) {
            const read = props.read;
            <Wrap>{ () => { return <i class={ ['pill', read()].join(' ') }>{ read() }</i>; } }</Wrap>
        }`;
    const component = compileComponent(source, 'Probe', { ssr: mode !== 'client' });
    const [read, write] = createSignal('red');
    const app = (): HTMLElement => component({ read }) as HTMLElement;
    const host = document.createElement('div');
    if (mode === 'hydrate')
    {
        host.innerHTML = renderToString(app);
        hydrate(app, host);
    }
    else
    {
        render(app, host);
    }
    try
    {
        const label = host.querySelector('i');
        expect(label?.className).toBe('pill red');
        write('blue');
        expect([label?.className, label?.textContent]).toEqual(['pill blue', 'blue']);
    }
    finally
    {
        render(() => document.createElement('div'), host);
    }
});

describe('the editor projection uses the same value shapes', () =>
{
    it.each(cases)('wraps the computed child %s', expr =>
    {
        const code = generateVirtualCode(`component Probe { <p>{ ${ expr } }</p> }`).code;
        expect(code).toContain(`() => ( ${ expr } )`);
    });

    it.each(['[read()]', '[read()] as const', '[read()] satisfies readonly unknown[]', '{ label: read() }',
        '() => read()', 'function () { return read(); }', 'async value => value'])(
        'preserves the literal %s', expr =>
        {
            const code = generateVirtualCode(`component Probe { <p>{ ${ expr } }</p> }`).code;
            expect(code).toContain(`( ${ expr } )`);
            expect(code).not.toContain(`() => ( ${ expr } )`);
        });

    it('keeps an explicitly grouped collection reactive', () =>
    {
        const code = generateVirtualCode('component Probe { <p>{ ([read()]) }</p> }').code;
        expect(code).toContain('() => ( ([read()]) )');
    });
});

describe('component callback children', () =>
{
    it.each(['(function () { return read(); })()', '(async () => read())()'])('projects the computed child %s', expr =>
    {
        const code = generateVirtualCode(`component Probe { <Rows>{ ${ expr } }</Rows> }`).code;
        expect(code).toContain('__azRender(() => (');
        expect(code).not.toMatch(/children:\s*\((?:function|async)/);
    });

    it.each(['(x:string):string => x', '(function(x:string) { return x; })', '<T>(x:T) => x'])(
        'passes the typed callback %s its argument', expr =>
        {
            const source = `component Rows(props) { <p>{ props.children("oak") }</p> }
                component Probe { <Rows>{ ${ expr } }</Rows> }`;
            const projected = generateVirtualCode(source).code;
            expect(projected).toMatch(/children:\s*[^;]*x/);
            const Probe = compileComponent(source, 'Probe', {}, true);
            expect(renderToString(() => Probe() as HTMLElement)).toContain('oak');
        });
});
