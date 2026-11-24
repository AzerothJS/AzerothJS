// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createSignal, hydrate, render, renderToString } from 'azerothjs';
import { compileComponent } from './executor.ts';

const stockRows = '<tr><td class="count">{p.count()}</td><td><input/></td></tr><tr><td><button onClick={p.receive}>Receive</button></td></tr>';
const table = (rows: string): string => `component App(p) { <table>${ rows }</table> }`;

describe('tables with authored rows', () =>
{
    const controls = [
        ['bare rows', stockRows],
        ['explicit body', `<tbody>${ stockRows }</tbody>`]
    ] as const;

    describe.each(controls)('%s', (_label, rows) =>
    {
        it.each(['default', 'client only', 'hydrate'])('updates the same cell and keeps the draft on %s', lane =>
        {
            const component = compileComponent(table(rows), 'App', { ssr: lane !== 'client only' });
            const [count, setCount] = createSignal(17);
            const app = (): HTMLElement => component({ count, receive: () => setCount(count() + 1) }) as HTMLElement;
            const host = document.body.appendChild(document.createElement('div'));
            try
            {
                if (lane === 'hydrate')
                {
                    const html = renderToString(app);
                    expect(html).toContain('<table><tbody><tr>');
                    host.innerHTML = html;
                    const served = [...host.querySelectorAll('*')];
                    host.querySelector('input')!.value = 'stock note';
                    hydrate(app, host);
                    expect([...host.querySelectorAll('*')].every((node, i) => node === served[i])).toBe(true);
                    expect(host.querySelectorAll('*')).toHaveLength(served.length);
                }
                else
                {
                    render(app, host);
                    host.querySelector('input')!.value = 'stock note';
                }
                const cell = host.querySelector('table > tbody > tr > td.count');
                expect(cell?.textContent).toBe('17');
                const draft = host.querySelector('input');
                host.querySelector('button')!.click();
                expect(cell?.textContent).toBe('18');
                expect(host.querySelector('.count')).toBe(cell);
                expect(host.querySelector('input')).toBe(draft);
                expect(draft?.value).toBe('stock note');
            }
            finally
            {
                render(() => [], host);
                host.remove();
            }
        });
    });

    it('preserves spaces, explicit sections and nested row groups', () =>
    {
        const nested = '<table><tr><td>inner</td></tr></table>';
        const row = `<tr><td>${ nested }</td></tr>`;
        const explicit = '<tbody id="kept"><tr><td>middle</td></tr></tbody>';
        const tail = '<tr><td>last</td></tr>';
        const component = compileComponent(table(` <>${ row }</> <tr><td>second</td></tr> ${ explicit }${ tail }`), 'App');
        const normalizedRow = '<tr><td><table><tbody><tr><td>inner</td></tr></tbody></table></td></tr>';
        const expected = `<table> <tbody>${ normalizedRow } <tr><td>second</td></tr> </tbody>${ explicit }<tbody>${ tail }</tbody></table>`;
        expect(renderToString(() => component() as HTMLElement)).toBe(expected);
        expect((component() as Element).outerHTML).toBe(expected);
    });

    it('binds the second row after adjacent spaces from a fragment and a character reference', () =>
    {
        const rows = '<tr><td>first</td></tr><> </>&#32;<tr><td>{p.count()}</td></tr>';
        const component = compileComponent(table(rows), 'App');
        const [count, setCount] = createSignal(17);
        const host = document.createElement('div');
        render(() => component({ count }) as HTMLElement, host);
        const body = host.querySelector('tbody');
        expect(body?.firstChild?.nextSibling?.textContent).toBe('  ');
        const cell = body?.lastElementChild?.firstElementChild;
        expect(cell?.textContent).toBe('17');
        setCount(18);
        expect(cell?.textContent).toBe('18');
        render(() => [], host);
    });

    it('keeps a folded expression between a bare row and a changing table section', () =>
    {
        const component = compileComponent(table('<tr><td>first</td></tr>{1 + 2}{p.footer() ? <tfoot><tr><td>sum</td></tr></tfoot> : null}'), 'App');
        const [footer, setFooter] = createSignal(false);
        const host = document.createElement('div');
        render(() => component({ footer }) as HTMLElement, host);
        expect(host.textContent).toBe('first3');
        setFooter(true);
        expect(host.querySelector('table > tfoot')?.textContent).toBe('sum');
        expect(host.textContent).toBe('first3sum');
        render(() => [], host);
    });

    it('groups HTML rows in expression markup at a foreign integration point', () =>
    {
        const component = compileComponent(`component App {
            const view = () => <svg><foreignObject><tAble><tR><td>one</td></tR></tAble></foreignObject></svg>;
            <main>{view()}</main> }`, 'App');
        const body = (component() as Element).querySelector('tbody');
        expect(body?.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
        expect(body?.parentElement?.localName).toBe('table');
        expect(body?.firstElementChild?.localName).toBe('tr');
    });

    it.each([true, false])('keeps a changing projected section table-owned inside a For callback (ssr=%s)', ssr =>
    {
        const [footer, setFooter] = createSignal(false);
        const component = compileComponent(`component App(p) {
            <main><For each={[7]} key={n => n} let={n}><table><tr><td>{n}</td></tr>{p.footer()
                ? <tfoot><tr><td>total</td></tr></tfoot> : <tr><td>extra</td></tr>}</table></For></main> }`,
        'App', { ssr });
        const host = document.createElement('div');
        render(() => component({ footer }) as HTMLElement, host);
        const first = host.querySelector('td');
        expect(first?.textContent).toBe('7');
        expect(host.querySelector('table')?.textContent).toBe('7extra');
        setFooter(true);
        expect(host.querySelector('table > tfoot > tr > td')?.textContent).toBe('total');
        setFooter(false);
        expect(host.querySelector('tfoot')).toBeNull();
        expect(host.querySelector('table')?.textContent).toBe('7extra');
        expect(host.querySelector('td')).toBe(first);
        render(() => [], host);
    });
});
