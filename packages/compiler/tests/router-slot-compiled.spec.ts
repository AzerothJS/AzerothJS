// @vitest-environment happy-dom
//
// Placement fixtures (compiled half): route-slot placement through REAL COMPILED
// OUTPUT. The hardest defect class lived exactly here - compiled layouts never call
// appendChild; their children travel bindSlot/bindHole/bindContent inside compiler getters -
// so hand-written h() fixtures cannot stand in for these. Each fixture compiles a .azeroth
// layout with generateModule and runs it against the real runtime in dom, string, and
// hydrate modes:
//   (a) BOTH spellings - <Outlet children={props.children}/> and the { props.children }
//       hole - place the slot: markers present, content placed, no '[object Object]', no
//       [ ] hole anchors around the outlet range in string output; the hydrate run asserts
//       SERVER-NODE IDENTITY and ZERO mismatch warnings (a stripped hydrate branch degrades
//       to the whole-container fallback, which fails BOTH);
//   (f) a signal-reading hole inside a HYDRATED control-flow component: a write re-runs
//       only the hole, never the enclosing swap effect (the tracking-leak pin);
//   (g) the conditional hole { cond() ? props.children : 'alt' } toggling BOTH ways:
//       marker pair appears and disappears with the placement, the leaf remounts per
//       reveal (the broken-proof control's driveHoleRange rows, both marker-ownership directions).
import { describe, it, expect, vi } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { createSignal, createEffect, h, render, renderToString, hydrate, For, Show, Switch, Match } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes } from 'azerothjs';
import type { Route, Router } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Compiles `.azeroth` source and returns its default export, executed against the runtime. */
function compile(source: string, injected: Record<string, unknown> = {}): (props?: Record<string, unknown>) => unknown
{
    const generated = generateModule(source, 'T.azeroth', {});
    const code = typeof generated === 'string' ? generated : generated.code;
    const body = code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const name = (/^function\s+(\w+)/m.exec(body) as RegExpExecArray)[1] as string;

    const extras = { For, Show, Switch, Match, ...injected };
    const keys = [...Object.keys(runtime), ...Object.keys(extras)];
    const values: Record<string, unknown> = { ...(runtime as unknown as Record<string, unknown>), ...extras };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the compiler's own output IS the point
    const factory = new Function(...keys, `${ body }\nreturn ${ name };`) as (...args: unknown[]) => (props?: Record<string, unknown>) => unknown;
    return factory(...keys.map((k) => values[k]));
}

const OUTLET_LAYOUT =
    'export default component L(props: { children?: unknown })\n{\n'
    + '    <div class="layout">\n'
    + '        <header>top</header>\n'
    + '        <Outlet children={props.children}/>\n'
    + '    </div>\n}\n';

const HOLE_LAYOUT =
    'export default component L(props: { children?: unknown })\n{\n'
    + '    <div class="layout">\n'
    + '        <header>top</header>\n'
    + '        { props.children }\n'
    + '    </div>\n}\n';

/** A live h-land counter leaf: the interactivity oracle for the hydrate runs. */
function CounterLeaf(): HTMLElement
{
    const [count, setCount] = createSignal(0);
    return h('section', { id: 'leaf' },
        h('span', { id: 'out' }, () => `count:${ count() }`),
        h('button', { id: 'go', onClick: () => setCount(count() + 1) }, 'inc'));
}

function routesFor(layout: (props?: Record<string, unknown>) => unknown): Route[]
{
    return [{
        path: '/p',
        component: layout as never,
        children: [{ path: '', component: CounterLeaf }]
    }];
}

function makeRouter(routes: Route[]): Router
{
    return createRouter({ routes, history: createMemoryHistory('/p') });
}

describe.each([
    ['<Outlet/> spelling', OUTLET_LAYOUT],
    ['{ props.children } hole spelling', HOLE_LAYOUT]
])('compiled layout - %s', (_label, source) =>
{
    it('dom mode: markers present, content placed, no stringification', () =>
    {
        const L = compile(source);
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routesFor(L)) })), container);

        const layout = container.querySelector('.layout')!;
        expect(layout).not.toBeNull();
        expect(layout.querySelector('#leaf')).not.toBeNull();
        expect(container.textContent).not.toContain('[object Object]');
        const comments = Array.from(layout.childNodes).filter((n) => n.nodeType === 8).map((n) => (n as Comment).data);
        expect(comments).toContain('outlet');
        expect(comments).toContain('/outlet');
        render(() => h('div', {}), container);
        container.remove();
    });

    it('string mode: one azc:outlet range, no hole anchors around it, leaf markup inside', () =>
    {
        const L = compile(source);
        const html = renderToString(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routesFor(L)) })));

        expect(html).toContain('<!--azc:outlet-->');
        expect(html).toContain('id="leaf"');
        expect(html).not.toContain('[object Object]');
        // The handle must serialize through the branded branch, NEVER wrapped as an
        // ordinary [ ] reactive hole (the string-mode wrap defect).
        const outletStart = html.indexOf('<!--azc:outlet-->');
        const before = html.slice(Math.max(0, outletStart - 12), outletStart);
        expect(before).not.toContain('<!--[-->');
        cleanupStrays();
    });

    it('hydrate mode: SERVER-NODE IDENTITY preserved, zero mismatch warnings, live page', async () =>
    {
        const L = compile(source);
        const serverHtml = renderToString(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routesFor(L)) })));
        const container = document.createElement('div');
        container.innerHTML = serverHtml;
        document.body.appendChild(container);
        const serverLayout = container.querySelector('.layout');
        const serverLeaf = container.querySelector('#leaf');
        expect(serverLayout).not.toBeNull();
        expect(serverLeaf).not.toBeNull();

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            hydrate(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routesFor(L)) })), container);
            await flush();

            // A stripped hydrate branch degrades to the whole-container fallback: the
            // page still LOOKS right, but the server nodes are replaced and the warning
            // fires - these two assertions fail BOTH ways.
            expect(container.querySelector('.layout')).toBe(serverLayout);
            expect(container.querySelector('#leaf')).toBe(serverLeaf);
            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(false);

            container.querySelector<HTMLButtonElement>('#go')!.click();
            expect(container.querySelector('#out')!.textContent).toBe('count:1');
        }
        finally
        {
            warn.mockRestore();
        }
        container.remove();
    });
});

/** happy-dom keeps detached test containers in document.body between cases. */
function cleanupStrays(): void
{
    // string-mode cases mount nothing; nothing to clean, kept for symmetry.
}

describe('the tracking-leak pin', () =>
{
    it('a write to a hole signal inside a HYDRATED control-flow component re-runs only the hole', async () =>
    {
        const source =
            'import { probe } from \'./state.ts\';\n'
            + 'export default component P()\n{\n'
            + '    <div class="host">\n'
            + '        <Show when={ true }>\n'
            + '            <p class="cf">{ probe() }</p>\n'
            + '        </Show>\n'
            + '    </div>\n}\n';
        const [probe, setProbe] = createSignal('one');
        const P = compile(source, { probe });

        const serverHtml = renderToString(() => P() as HTMLElement);
        const container = document.createElement('div');
        container.innerHTML = serverHtml;
        document.body.appendChild(container);
        expect(container.querySelector('.cf')!.textContent).toBe('one');

        hydrate(() => P() as HTMLElement, container);
        await flush();
        const adopted = container.querySelector('.cf');

        setProbe('two');
        await flush();
        // Only the hole re-ran: the text updated IN PLACE. If the enclosing swap
        // effect had tracked the signal (the leak 6.4's untracked resolution + tracked
        // re-read carve-out prevents), the <p> would be a fresh node.
        expect(container.querySelector('.cf')).toBe(adopted);
        expect(container.querySelector('.cf')!.textContent).toBe('two');
        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('the conditional hole, both ways', () =>
{
    it('{ cond() ? props.children : text } toggles placement off and back on; the leaf remounts per reveal', async () =>
    {
        const source =
            'import { cond } from \'./state.ts\';\n'
            + 'export default component L(props: { children?: unknown })\n{\n'
            + '    <div class="layout">{ cond() ? props.children : \'alt\' }</div>\n}\n';
        const [cond, setCond] = createSignal(true);
        const L = compile(source, { cond });

        let leafBuilds = 0;
        const CountingLeaf = (): HTMLElement =>
        {
            leafBuilds += 1;
            return h('span', { id: 'leaf' }, 'leaf');
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: L as never,
            children: [{ path: '', component: CountingLeaf }]
        }];
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })), container);

        const layout = container.querySelector('.layout')!;
        const outletComments = (): string[] =>
            Array.from(layout.childNodes).filter((n) => n.nodeType === 8).map((n) => (n as Comment).data)
                .filter((d) => d === 'outlet' || d === '/outlet');
        expect(container.querySelector('#leaf')).not.toBeNull();
        expect(outletComments()).toEqual(['outlet', '/outlet']);
        expect(leafBuilds).toBe(1);

        // handle -> non-handle: the placement disposes, the marker pair LEAVES with it.
        setCond(false);
        await flush();
        expect(container.querySelector('#leaf')).toBeNull();
        expect(outletComments()).toEqual([]);
        expect(layout.textContent).toBe('alt');

        // non-handle -> handle: re-placed, fresh markers, the leaf REMOUNTS.
        setCond(true);
        await flush();
        expect(container.querySelector('#leaf')).not.toBeNull();
        expect(outletComments()).toEqual(['outlet', '/outlet']);
        expect(leafBuilds).toBe(2);
        expect(layout.textContent).not.toContain('alt');

        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('a HYDRATED conditional slot-hole keeps its document position', () =>
{
    it('toggling away and back lands the value BEFORE the following sibling, not at the tail', async () =>
    {
        const source =
            'import { cond } from \'./state.ts\';\n'
            + 'export default component L(props: { children?: unknown })\n{\n'
            + '    <div class="layout">{ cond() ? props.children : \'alt\' }<footer class="after">after</footer></div>\n}\n';
        const [cond, setCond] = createSignal(true);
        const L = compile(source, { cond });
        const routes: Route[] =
        [{
            path: '/p',
            component: L as never,
            children: [{ path: '', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
        }];

        const serverHtml = renderToString(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })));
        const container = document.createElement('div');
        container.innerHTML = serverHtml;
        document.body.appendChild(container);

        hydrate(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })), container);
        await flush();
        const layout = container.querySelector('.layout')!;
        expect(layout.querySelector('#leaf')).not.toBeNull();

        // handle -> non-handle: the alt text must render where the slot was - BEFORE
        // the footer - not appended at the layout's tail (the anchorless regression).
        setCond(false);
        await flush();
        expect(layout.querySelector('#leaf')).toBeNull();
        const footer = layout.querySelector('.after')!;
        expect(layout.textContent).toContain('alt');
        const textBeforeFooter = layout.textContent.indexOf('alt') < layout.textContent.indexOf('after');
        expect(textBeforeFooter).toBe(true);

        // non-handle -> handle: the leaf remounts, again BEFORE the footer.
        setCond(true);
        await flush();
        const leaf = layout.querySelector('#leaf')!;
        expect(leaf.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('a HYDRATED conditional slot-hole between two siblings', () =>
{
    it('each toggle swaps only the hole and keeps both siblings', async () =>
    {
        const source =
            'import { cond } from \'./state.ts\';\n'
            + 'export default component L(props: { children?: unknown })\n{\n'
            + '    <div class="layout"><header>before</header>{ cond() ? props.children : <em>alt</em> }<footer>after</footer></div>\n}\n';
        const [cond, setCond] = createSignal(true);
        const L = compile(source, { cond });
        const routes: Route[] =
        [{
            path: '/p',
            component: L as never,
            children: [{ path: '', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
        }];

        const serverHtml = renderToString(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })));
        const container = document.createElement('div');
        container.innerHTML = serverHtml;
        document.body.appendChild(container);

        hydrate(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })), container);
        await flush();
        const layout = container.querySelector('.layout')!;
        const seq = [layout.textContent];
        for (const next of [false, true, false])
        {
            setCond(next);
            await flush();
            seq.push(layout.textContent);
        }
        expect(seq).toEqual(['beforeleafafter', 'beforealtafter', 'beforeleafafter', 'beforealtafter']);

        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('a hydrated slot-hole at the head of a component inside another hole', () =>
{
    it('lets the outer hole hide and show it after the slot toggled away', async () =>
    {
        const source =
            'import { ready, on } from \'./state.ts\';\n'
            + 'export default component L(props: { children?: unknown })\n{\n'
            + '    <div class="layout">{ ready() && <Frame on={ on() } kids={ props.children }/> }</div>\n}\n'
            + 'component Frame(props: { on: boolean; kids?: unknown })\n{\n'
            + '    <>{ props.on ? props.kids : "alt" }<u>t</u></>\n}\n';
        const [ready, setReady] = createSignal(true);
        const [on, setOn] = createSignal(true);
        const L = compile(source, { ready, on });
        const routes: Route[] =
        [{
            path: '/p',
            component: L as never,
            children: [{ path: '', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
        }];
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })));
        document.body.appendChild(container);
        hydrate(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })), container);
        await flush();

        const seq = [container.textContent];
        for (const step of [() => setOn(false), () => setReady(false), () => setReady(true), () => setOn(true), () => setReady(false), () => setReady(true)])
        {
            step();
            await flush();
            seq.push(container.textContent);
        }
        expect(seq.join(' > ')).toBe('leaft > altt >  > altt > leaft >  > leaft');

        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('a hydrated slot-hole at the end of a range, before a sibling', () =>
{
    const FRAME =
        'component Frame(props: { on: boolean; kids?: unknown })\n{\n'
        + '    <><b>h</b>{ props.on ? props.kids : <em>alt</em> }</>\n}\n';
    const ranges: Array<[string, string, string]> = [
        ['a component inside another hole', '{ ready() && <Frame on={ on() } kids={ props.children }/> }', FRAME],
        ['a Show branch', '<Show when={ ready() }><b>h</b>{ on() ? props.children : <em>alt</em> }</Show>', '']
    ];

    for (const [where, range, extra] of ranges)
    {
        it(`at the end of ${ where } keeps the value inside the range and the sibling after it`, async () =>
        {
            const source =
                'import { ready, on } from \'./state.ts\';\n'
                + 'export default component L(props: { children?: unknown })\n{\n'
                + `    <div class="layout">${ range }<footer>after</footer></div>\n}\n`
                + extra;
            const [ready, setReady] = createSignal(true);
            const [on, setOn] = createSignal(true);
            const L = compile(source, { ready, on });
            const routes: Route[] =
            [{
                path: '/p',
                component: L as never,
                children: [{ path: '', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
            }];
            const container = document.createElement('div');
            container.innerHTML = renderToString(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })));
            document.body.appendChild(container);
            const serverLeaf = container.querySelector('#leaf');
            hydrate(() => h('div', { id: 'app' }, Routes({ router: makeRouter(routes) })), container);
            await flush();
            expect(container.querySelector('#leaf')).toBe(serverLeaf);

            const layout = container.querySelector('.layout')!;
            const seq = [layout.textContent];
            for (const step of [() => setOn(false), () => setOn(true), () => setOn(false), () => setReady(false), () => setReady(true), () => setOn(true)])
            {
                try
                {
                    step();
                    await flush();
                    seq.push(layout.textContent);
                }
                catch (error)
                {
                    seq.push(`threw ${ (error as Error).name }`);
                }
            }
            expect(seq.join(' > ')).toBe('hleafafter > haltafter > hleafafter > haltafter > after > haltafter > hleafafter');

            render(() => h('div', {}), container);
            container.remove();
        });
    }
});

describe('a hydrated slot-hole after a table row', () =>
{
    // Without a tbody in the markup, the parser puts the rows and the slot's markers in one the
    // client never builds, and a toggle places the page in the table, where a later section page
    // belongs. An explicit tbody keeps every row.
    const FLIPS = [false, true, false, true, false, true];
    const holes: Array<[string, string, boolean[], string]> = [
        ['a conditional hole', '<tr><td>h</td></tr>{ cond() ? props.children : <tr><td>alt</td></tr> }', FLIPS,
            'h@tbody,row:0@tbody > h@tbody,alt@tbody > h@tbody,row:0@table > h@tbody,alt@table > h@tbody,row:0@table > h@tbody,alt@table > h@tbody,row:0@table'],
        ['a plain hole', '<tr><td>h</td></tr>{ props.children }', [], 'h@tbody,row:0@tbody'],
        ['a conditional hole in an explicit tbody', '<tbody><tr><td>h</td></tr>{ cond() ? props.children : <tr><td>alt</td></tr> }</tbody>', FLIPS,
            'h@tbody,row:0@tbody > h@tbody,alt@tbody > h@tbody,row:0@tbody > h@tbody,alt@tbody > h@tbody,row:0@tbody > h@tbody,alt@tbody > h@tbody,row:0@tbody']
    ];

    for (const [label, hole, toggles, rows] of holes)
    {
        it(`${ label } after a row adopts the server rows, keeps their order and leaves the page live`, async () =>
        {
            const source =
                'import { cond } from \'./state.ts\';\n'
                + 'export default component L(props: { children?: unknown })\n{\n'
                + `    <table class="layout">${ hole }</table>\n}\n`;
            const [cond, setCond] = createSignal(true);
            const L = compile(source, { cond });
            const Row = (): HTMLElement =>
            {
                const [count, setCount] = createSignal(0);
                return h('tr', {}, h('td', {}, h('button', { id: 'row', onClick: () => setCount(count() + 1) }, () => `row:${ count() }`)));
            };
            const routes: Route[] = [{ path: '/p', component: L as never, children: [{ path: '', component: Row }] }];
            const app = (): HTMLElement =>
            {
                const [clicks, setClicks] = createSignal(0);
                return h('div', { id: 'app' },
                    Routes({ router: makeRouter(routes) }),
                    h('button', { id: 'after', onClick: () => setClicks(clicks() + 1) }, () => `after:${ clicks() }`));
            };
            const container = document.createElement('div');
            container.innerHTML = renderToString(app);
            document.body.appendChild(container);
            const serverRows = [...container.querySelectorAll('tr')];

            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            let threw = 'none';
            try
            {
                hydrate(app, container);
            }
            catch (error)
            {
                threw = (error as Error).name;
            }
            await flush();
            const fellBack = warn.mock.calls.some((c) => /falling back to full client render/.test(String(c[0] ?? '')));
            warn.mockRestore();
            const adopted = serverRows.every((row) => row.isConnected);

            const read = (): string => [...container.querySelectorAll('tr')].map((row) => `${ row.textContent }@${ row.parentElement?.tagName.toLowerCase() ?? '' }`).join(',');
            const seq = [read()];
            for (const next of toggles)
            {
                try
                {
                    setCond(next);
                    await flush();
                    seq.push(read());
                }
                catch (error)
                {
                    seq.push(`threw ${ (error as Error).name }`);
                }
            }
            container.querySelector<HTMLButtonElement>('#row')?.click();
            container.querySelector<HTMLButtonElement>('#after')?.click();

            expect({
                threw,
                fellBack,
                adopted,
                seq: seq.join(' > '),
                row: container.querySelector('#row')?.textContent,
                after: container.querySelector('#after')?.textContent
            }).toEqual({ threw: 'none', fellBack: false, adopted: true, seq: rows, row: 'row:1', after: 'after:1' });

            render(() => h('div', {}), container);
            container.remove();
        });
    }
});

const tagOf = (el: Element | null): string => el?.tagName.toLowerCase() ?? '';

/** Each row's text and parent. */
function rowParents(root: Element): string
{
    return [...root.querySelectorAll('tr')].map((row) => `${ row.textContent }@${ tagOf(row.parentElement) }`).join(',');
}

/** The table's sections and their parents, first tfoot, tbody count and the rows it shows. */
function tableShape(root: Element): string
{
    const table = root.querySelector('table');
    const kids = table === null ? [] : [...table.children];
    const sections = table === null ? [] : [...table.querySelectorAll('thead, tbody, tfoot, caption')].map((el) => `${ tagOf(el) }@${ tagOf(el.parentElement) }`);
    const rows = kids.flatMap((el) => (tagOf(el) === 'tr' ? [el] : [...el.children].filter((row) => tagOf(row) === 'tr')));
    const foot = kids.find((el) => tagOf(el) === 'tfoot')?.textContent ?? '-';
    return `${ sections.join(' ') } foot=${ foot } bodies=${ kids.filter((el) => tagOf(el) === 'tbody').length } rows=${ rows.length }`;
}

describe('a route outlet after a row in a table with no tbody, whose page renders a table section', () =>
{
    // The page's section closes the parser's tbody, so the outlet's markers land in two sections.
    // The last element is each row's parent in the hydrated table where it differs from the parse.
    const plain = '{ props.children }';
    const conditional = '{ cond() ? props.children : <tfoot><tr><td>alt</td></tr></tfoot> }';
    const MIXED_TRS = 'h@tbody,a:0@table,pf@tfoot > h@tbody,a:1@table,pf@tfoot';
    // A rows page stays in the parser's tbody until a toggle places a page again, in the table.
    const ALT_SEQ = 'h,a:0 > h,a:1 > h,alt > h,a:0 > h,b:0 > h,alt > h,b:0 > h,a:0';
    const NO_ALT_SEQ = 'h,a:0 > h,a:1 > h > h,a:0 > h,b:0 > h > h,b:0 > h,a:0';
    const rowPage = (alt: string, again = alt): string =>
        `h@tbody,a:0@tbody > h@tbody,a:1@tbody > h@tbody${ alt } > h@tbody,a:0@table > h@tbody,b:0@tfoot > h@tbody${ again } > h@tbody,b:0@tfoot > h@tbody,a:0@table`;
    const layouts: Array<[string, string, string, string, string?]> = [
        ['a plain outlet whose page renders a tbody', plain, 'tbody',
            'h,a:0 > h,a:1 > h,a:1 > h,a:1 > h,b:0 > h,b:0 > h,b:0 > h,a:0'],
        ['a plain outlet before a layout tfoot', `${ plain }<tfoot><tr><td>f</td></tr></tfoot>`, 'tbody',
            'h,a:0,f > h,a:1,f > h,a:1,f > h,a:1,f > h,b:0,f > h,b:0,f > h,b:0,f > h,a:0,f'],
        ['a conditional outlet whose page renders a tfoot', conditional, 'tfoot',
            'h,a:0 > h,a:1 > h,alt > h,a:0 > h,b:0 > h,alt > h,b:0 > h,a:0'],
        ['a plain outlet whose page is a For of tbodies', plain, 'forBodies',
            'h,a:0,g2 > h,a:1,g2 > h,a:1,g2 > h,a:1,g2 > h,b:0,g2 > h,b:0,g2 > h,b:0,g2 > h,a:0,g2'],
        ['a conditional outlet whose page is a For of tbodies', conditional, 'forBodies',
            'h,a:0,g2 > h,a:1,g2 > h,alt > h,a:0,g2 > h,b:0,g2 > h,alt > h,b:0,g2 > h,a:0,g2'],
        ['a plain outlet whose page is a Show of a tfoot', plain, 'showFoot',
            'h,a:0 > h,a:1 > h,a:1 > h,a:1 > h,b:0 > h,b:0 > h,b:0 > h,a:0'],
        ['a conditional outlet whose page is a Show of a tfoot', conditional, 'showFoot',
            'h,a:0 > h,a:1 > h,alt > h,a:0 > h,b:0 > h,alt > h,b:0 > h,a:0'],
        ['a plain outlet whose page mixes a row with a tfoot', plain, 'mixed',
            'h,a:0,pf > h,a:1,pf > h,a:1,pf > h,a:1,pf > h,b:0,pf > h,b:0,pf > h,b:0,pf > h,a:0,pf',
            `${ MIXED_TRS } > h@tbody,a:1@table,pf@tfoot > h@tbody,a:1@table,pf@tfoot > h@tbody,b:0@table,pf@tfoot > h@tbody,b:0@table,pf@tfoot > h@tbody,b:0@table,pf@tfoot > h@tbody,a:0@table,pf@tfoot`],
        ['a conditional outlet whose page mixes a row with a tfoot', conditional, 'mixed',
            'h,a:0,pf > h,a:1,pf > h,alt > h,a:0,pf > h,b:0,pf > h,alt > h,b:0,pf > h,a:0,pf',
            `${ MIXED_TRS } > h@tbody,alt@tfoot > h@tbody,a:0@table,pf@tfoot > h@tbody,b:0@table,pf@tfoot > h@tbody,alt@tfoot > h@tbody,b:0@table,pf@tfoot > h@tbody,a:0@table,pf@tfoot`],
        ['a plain outlet whose page puts a conditional row before a tfoot', plain, 'condRow',
            'h,on,a:0,pf > h,on,a:1,pf > h,off,a:1,pf > h,on,a:1,pf > h,on,b:0,pf > h,off,b:0,pf > h,on,b:0,pf > h,on,a:0,pf',
            'h@tbody,on@table,a:0@table,pf@tfoot > h@tbody,on@table,a:1@table,pf@tfoot > h@tbody,off@table,a:1@table,pf@tfoot > h@tbody,on@table,a:1@table,pf@tfoot > h@tbody,on@table,b:0@table,pf@tfoot > h@tbody,off@table,b:0@table,pf@tfoot > h@tbody,on@table,b:0@table,pf@tfoot > h@tbody,on@table,a:0@table,pf@tfoot'],
        ['a conditional outlet whose page is a row, with a tfoot alternative', conditional, 'tr>tfoot', ALT_SEQ, rowPage(',alt@tfoot')],
        ['a conditional outlet whose page is a row, with a caption alternative', '{ cond() ? props.children : <caption>alt</caption> }', 'tr>tfoot',
            NO_ALT_SEQ, rowPage('')],
        ['a conditional outlet whose page is a row, with a thead alternative', '{ cond() ? props.children : <thead><tr><td>alt</td></tr></thead> }', 'tr>tfoot',
            ALT_SEQ, rowPage(',alt@thead')],
        ['a conditional outlet whose page is a row, with a tbody alternative', '{ cond() ? props.children : <tbody><tr><td>alt</td></tr></tbody> }', 'tr>tfoot',
            ALT_SEQ, rowPage(',alt@tbody')],
        ['a conditional outlet whose page is a row, with a row alternative', '{ cond() ? props.children : <tr><td>alt</td></tr> }', 'tr>tfoot',
            ALT_SEQ, rowPage(',alt@tbody', ',alt@table')],
        ['a conditional outlet whose page is a row, with nothing as its alternative', '{ cond() && props.children }', 'tr>tfoot', NO_ALT_SEQ, rowPage('')]
    ];

    /**
     * Mounts the layout in one lane, clicks the page, toggles the condition, navigates, toggles it
     * again and navigates back. The shape reads a hydrated table as it stands and a rendered one as
     * the parser reads it back. `section` names the page, or the first page and the page navigated
     * to, as in 'tr>tfoot'.
     */
    async function sectionRun(hole: string, section: string, lane: 'render' | 'hydrate'): Promise<{ threw: string; adopted: boolean; fallbacks: string[]; seq: string; shape: string; trs: string; teardown: string }>
    {
        const source =
            'import { cond } from \'./state.ts\';\n'
            + 'export default component L(props: { children?: unknown })\n{\n'
            + `    <table class="layout"><tr><td>h</td></tr>${ hole }</table>\n}\n`;
        const [cond, setCond] = createSignal(true);
        const L = compile(source, { cond });
        const page = (name: string) => (): unknown =>
        {
            const [count, setCount] = createSignal(0);
            const row = h('tr', {}, h('td', {}, h('button', { id: 'row', onClick: () => setCount(count() + 1) }, () => `${ name }:${ count() }`)));
            const kind = section.split('>')[name === 'a' ? 0 : 1] ?? section;
            if (kind === 'tr')
            {
                return row;
            }
            if (kind === 'forBodies')
            {
                return For({ each: () => [1, 2], key: (x: number) => x, children: (x: () => number) => h('tbody', {}, x() === 1 ? row : h('tr', {}, h('td', {}, 'g2'))) } as never);
            }
            if (kind === 'showFoot')
            {
                return Show({ when: true, children: () => h('tfoot', {}, row) });
            }
            if (kind === 'condRow')
            {
                const flip = (): HTMLElement => h('tr', {}, h('td', {}, cond() ? 'on' : 'off'));
                return Show({ when: true, children: () => [flip, row, h('tfoot', {}, h('tr', {}, h('td', {}, 'pf')))] });
            }
            if (kind === 'mixed')
            {
                return Show({ when: true, children: () => [row, h('tfoot', {}, h('tr', {}, h('td', {}, 'pf')))] });
            }
            return h(kind, {}, row);
        };
        const routes: Route[] = [{ path: '/p', component: L as never, children: [{ path: 'a', component: page('a') as never }, { path: 'b', component: page('b') as never }] }];
        // A fallback render builds its own router, so the steps drive the latest one.
        let router: Router | null = null;
        const app = (): HTMLElement =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/p/a') });
            return h('div', { id: 'app' }, Routes({ router }));
        };
        const container = document.createElement('div');
        document.body.appendChild(container);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let threw = 'none';
        let adopted = true;
        try
        {
            if (lane === 'hydrate')
            {
                container.innerHTML = renderToString(app);
                const server = [...container.querySelectorAll('tr')];
                hydrate(app, container);
                adopted = server.every((row) => row.isConnected);
            }
            else
            {
                render(app, container);
            }
        }
        catch (error)
        {
            threw = (error as Error).name;
        }
        await flush();
        const fallbacks = warn.mock.calls.map((c) => String(c[0] ?? '')).filter((m) => /falling back to full client render/.test(m));
        warn.mockRestore();

        const read = (): string => [...container.querySelectorAll('td')].map((td) => td.textContent).join(',');
        const view = (): Element =>
        {
            if (lane === 'hydrate')
            {
                return container;
            }
            const parsed = document.createElement('div');
            parsed.innerHTML = container.innerHTML;
            return parsed;
        };
        const seq = [read()];
        const shape = [tableShape(view())];
        const trs = [rowParents(view())];
        const steps = [
            () => container.querySelector<HTMLButtonElement>('#row')?.click(),
            () => setCond(false),
            () => setCond(true),
            () => router?.navigate('/p/b'),
            () => setCond(false),
            () => setCond(true),
            () => router?.navigate('/p/a')
        ];
        for (const step of steps)
        {
            try
            {
                step();
                await flush();
                seq.push(read());
            }
            catch (error)
            {
                seq.push(`threw ${ (error as Error).name }`);
            }
            shape.push(tableShape(view()));
            trs.push(rowParents(view()));
        }
        let teardown = 'ok';
        try
        {
            render(() => h('div', {}), container);
        }
        catch (error)
        {
            teardown = `threw ${ (error as Error).name }`;
        }
        container.remove();
        return { threw, adopted, fallbacks, seq: seq.join(' > '), shape: shape.join(' > '), trs: trs.join(' > '), teardown };
    }

    for (const [label, hole, section, seq, trs] of layouts)
    {
        it(`${ label } adopts the server rows, then navigates and tears down cleanly`, async () =>
        {
            const rendered = await sectionRun(hole, section, 'render');
            expect(rendered).toEqual({ threw: 'none', adopted: true, fallbacks: [], seq, shape: rendered.shape, trs: rendered.trs, teardown: 'ok' });
            expect(await sectionRun(hole, section, 'hydrate')).toEqual({ ...rendered, trs: trs ?? rendered.trs });
        });
    }
});

describe('a conditional outlet at the end of another range after a table row', () =>
{
    // The range around the outlet ends in the parser's tbody too, so it moves into the table with
    // the outlet, rows included, and a section lands where a fresh parse of the html puts it.
    const FOOT = '<tfoot><tr><td>alt</td></tr></tfoot>';
    const COND = `{ cond() ? props.children : ${ FOOT } }`;
    const IN_HOLE = '{ ready() && <Frame on={ cond() } kids={ props.children }/> }';
    const frame = (lead: string): string =>
        `component Frame(props: { on: boolean; kids?: unknown })\n{\n    <>${ lead }{ props.on ? props.kids : ${ FOOT } }</>\n}\n`;

    /**
     * Hydrates the layout, with a child layout under it when `child` is set, then runs `steps`.
     * Each step reads the hydrated table and a fresh parse of the server html in the same state.
     */
    async function nestedRun(range: string, extra: string, child: boolean, steps: string[]): Promise<{ fallbacks: string[]; adopted: boolean; shape: string; want: string; trs: string }>
    {
        const [cond, setCond] = createSignal(true);
        const [outer, setOuter] = createSignal(0);
        const [ready] = createSignal(true);
        const L = compile('import { cond, ready, outer } from \'./state.ts\';\n'
            + 'export default component L(props: { children?: unknown })\n{\n'
            + `    <table class="layout"><tr><td>h</td></tr>${ range }</table>\n}\n${ extra }`, { cond, ready, outer });
        const pages: Route[] = [
            { path: 'a', component: (): HTMLElement => h('tr', {}, h('td', {}, 'a')) },
            { path: 'b', component: (): HTMLElement => h('tfoot', {}, h('tr', {}, h('td', {}, 'b'))) }
        ];
        const M = child
            ? compile(`import { cond } from './state.ts';\nexport default component M(props: { children?: unknown })\n{\n    <>${ COND }</>\n}\n`, { cond })
            : null;
        const routes: Route[] = [{ path: '/p', component: L as never, children: M === null ? pages : [{ path: 'm', component: M as never, children: pages }] }];
        const base = M === null ? '/p' : '/p/m';
        let path = `${ base }/a`;
        const view = (router: Router): HTMLElement => h('div', { id: 'app' }, Routes({ router }));
        let router: Router | null = null;
        const app = (): HTMLElement =>
        {
            router = createRouter({ routes, history: createMemoryHistory(path) });
            return view(router);
        };
        const parsed = (): string =>
        {
            const fresh = document.createElement('div');
            fresh.innerHTML = renderToString(() => view(createRouter({ routes, history: createMemoryHistory(path) })));
            return tableShape(fresh);
        };
        const go = (to: string): void =>
        {
            path = `${ base }/${ to }`;
            router?.navigate(path);
        };
        const actions: Record<string, () => void> = {
            off: () => setCond(false),
            on: () => setCond(true),
            rowO: () => setOuter(1),
            rowP: () => setOuter(2),
            navB: () => go('b'),
            navA: () => go('a')
        };

        const container = document.createElement('div');
        container.innerHTML = renderToString(app);
        document.body.appendChild(container);
        const server = [...container.querySelectorAll('tr')];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        hydrate(app, container);
        await flush();
        const fallbacks = warn.mock.calls.map((c) => String(c[0] ?? '')).filter((m) => /falling back to full client render/.test(m));
        warn.mockRestore();
        const adopted = server.every((row) => row.isConnected);

        const shape = [tableShape(container)];
        const want = [parsed()];
        const trs = [rowParents(container)];
        for (const step of steps)
        {
            try
            {
                actions[step]?.();
                await flush();
                shape.push(tableShape(container));
            }
            catch (error)
            {
                shape.push(`threw ${ (error as Error).name }`);
            }
            want.push(parsed());
            trs.push(rowParents(container));
        }
        render(() => h('div', {}), container);
        container.remove();
        return { fallbacks, adopted, shape: shape.join(' > '), want: want.join(' > '), trs: trs.join(' > ') };
    }

    const PAGES = 'h@tbody,a@tbody > h@tbody,alt@tfoot > h@tbody,a@table > h@tbody,b@tfoot > h@tbody,alt@tfoot > h@tbody,b@tfoot > h@tbody,a@table';
    const ranges: Array<[string, string, string, boolean, string]> = [
        ['a Show branch', `<Show when={ ready() }>${ COND }</Show>`, '', false, PAGES],
        ['a Show branch with a caption alternative', '<Show when={ ready() }>{ cond() ? props.children : <caption>alt</caption> }</Show>', '', false,
            'h@tbody,a@tbody > h@tbody > h@tbody,a@table > h@tbody,b@tfoot > h@tbody > h@tbody,b@tfoot > h@tbody,a@table'],
        ['a Match', `<Switch><Match when={ ready() }>${ COND }</Match></Switch>`, '', false, PAGES],
        ['a component inside a hole', IN_HOLE, frame(''), false, PAGES],
        ['a component inside a hole, after its own row', IN_HOLE, frame('<tr><td>f</td></tr>'), false,
            'h@tbody,f@tbody,a@tbody > h@tbody,f@table,alt@tfoot > h@tbody,f@table,a@table > h@tbody,f@table,b@tfoot > h@tbody,f@table,alt@tfoot > h@tbody,f@table,b@tfoot > h@tbody,f@table,a@table'],
        ['a child layout in the parent outlet', '{ props.children }', '', true, PAGES]
    ];

    for (const [where, range, extra, child, trs] of ranges)
    {
        it(`at the end of ${ where } puts its section alternative and a section page in the table`, async () =>
        {
            const run = await nestedRun(range, extra, child, ['off', 'on', 'navB', 'off', 'on', 'navA']);
            expect(run).toEqual({ fallbacks: [], adopted: true, shape: run.want, want: run.want, trs });
        });
    }

    it('at the end of a child layout in a conditional parent outlet lets the parent swap its own values after the move', async () =>
    {
        // The parent outlet's bounds move with its range, so its next values replace each other.
        const range = '{ outer() === 0 ? props.children : outer() === 1 ? <tr><td>o</td></tr> : <tr><td>p</td></tr> }';
        const run = await nestedRun(range, '', true, ['off', 'on', 'rowO', 'rowP', 'rowO']);
        expect(run).toEqual({ fallbacks: [], adopted: true, shape: run.want, want: run.want, trs: 'h@tbody,a@tbody > h@tbody,alt@tfoot > h@tbody,a@table > h@tbody,o@table > h@tbody,p@table > h@tbody,o@table' });
    });

    // An empty hole, For or Show after the range moves into the table with it.
    const EMPTY_HOLE = '{ outer() > 0 && <tr><td>x</td></tr> }';
    const EMPTY_FOR = '<For each={ outer() > 0 ? [7] : [] } key={ (x) => x } let={ x }><tr><td>{ x }</td></tr></For>';
    const followed: Array<[string, string]> = [
        ['a Show branch, before an empty hole', `<Show when={ ready() }>${ COND }</Show>${ EMPTY_HOLE }`],
        ['a Show branch, before an empty For', `<Show when={ ready() }>${ COND }</Show>${ EMPTY_FOR }`],
        ['a Match, before an empty hole', `<Switch><Match when={ ready() }>${ COND }</Match></Switch>${ EMPTY_HOLE }`]
    ];
    const section = (foot: string): string => `tbody@table tfoot@table foot=${ foot } bodies=1 rows=2`;

    for (const [where, range] of followed)
    {
        it(`at the end of ${ where } puts its section alternative and a section page in the table`, async () =>
        {
            const run = await nestedRun(range, '', false, ['off', 'on', 'navB', 'off', 'on', 'navA']);
            expect(run).toEqual({ fallbacks: [], adopted: true, shape: run.want, want: run.want, trs: PAGES });
            const [, off, , navB] = run.shape.split(' > ');
            expect({ off, navB }).toEqual({ off: section('alt'), navB: section('b') });
        });
    }

    it('at the end of a Show branch, before a hole that shows a row, keeps its section alternative in the parser tbody', async () =>
    {
        // A range that shows rows after it keeps the section in the tbody the browser inserted.
        const run = await nestedRun(`<Show when={ ready() }>${ COND }</Show>{ outer() === 0 && <tr><td>x</td></tr> }`, '', false, ['off', 'on', 'navB']);
        const rows = 'tbody@table foot=- bodies=1 rows=3';
        const nested = 'tbody@table tfoot@tbody foot=- bodies=1 rows=2';
        const parsed = (foot: string): string => `tbody@table tfoot@table tbody@table foot=${ foot } bodies=2 rows=3`;
        expect(run).toEqual({
            fallbacks: [],
            adopted: true,
            shape: [rows, nested, rows, nested].join(' > '),
            want: [rows, parsed('alt'), rows, parsed('b')].join(' > '),
            trs: 'h@tbody,a@tbody,x@tbody > h@tbody,alt@tfoot,x@tbody > h@tbody,a@tbody,x@tbody > h@tbody,b@tfoot,x@tbody'
        });
    });
});

describe('a route outlet whose server markers cannot be joined', () =>
{
    // The last claimed node the join gets sits outside both sections, has no parent or is missing.
    const SPLIT = 'the server markers sit in different table sections';
    const NONE = 'the slot claimed no server node in the page';
    const strays: Array<[string, () => ChildNode | null, string]> = [
        ['sits outside both table sections', () => document.createElement('div').appendChild(document.createComment('/azc')), SPLIT],
        ['has no parent', () => document.createComment('/azc'), NONE],
        ['is missing', () => null, NONE]
    ];

    for (const [where, stray, reason] of strays)
    {
        it(`falls back without leaving the adopted page running when the last claimed node ${ where }`, async () =>
        {
            const source =
                'export default component L(props: { children?: unknown })\n{\n'
                + '    <table class="layout"><tr><td>h</td></tr>{ props.children }</table>\n}\n';
            const L = compile(source);
            const [tick, setTick] = createSignal(0);
            let runs = 0;
            const Page = (): HTMLElement =>
            {
                createEffect(() =>
                {
                    tick();
                    runs++;
                });
                return h('tr', {}, h('td', {}, 'p'));
            };
            const routes: Route[] = [
                { path: '/p', component: L as never, children: [{ path: '', component: Page }] },
                { path: '/q', component: (): HTMLElement => h('p', {}, 'q') }
            ];
            let router: Router | null = null;
            const app = (): HTMLElement =>
            {
                router = createRouter({ routes, history: createMemoryHistory('/p') });
                return h('div', { id: 'app' }, Routes({ router }));
            };
            const container = document.createElement('div');
            container.innerHTML = renderToString(app);
            document.body.appendChild(container);

            const last = vi.spyOn(runtime.HydrationCursor.prototype, 'lastClaimed').mockReturnValue(stray());
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            hydrate(app, container);
            last.mockRestore();
            await flush();
            const fallbacks = warn.mock.calls.map((c) => String(c[0] ?? '')).filter((m) => /falling back to full client render/.test(m));
            warn.mockRestore();

            const perChange: number[] = [];
            for (const step of [() => setTick(1), () => setTick(2), () => router?.navigate('/q'), () => setTick(3)])
            {
                const before = runs;
                step();
                await flush();
                perChange.push(runs - before);
            }
            expect({ fallbacks, perChange, text: container.textContent }).toEqual({
                fallbacks: [`[azeroth hydrate] slot hole: ${ reason } - falling back to full client render.`],
                perChange: [1, 1, 0, 0],
                text: 'q'
            });

            render(() => h('div', {}), container);
            container.remove();
        });
    }
});
