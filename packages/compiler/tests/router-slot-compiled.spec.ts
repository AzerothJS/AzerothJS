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
import { createSignal, h, render, renderToString, hydrate, For, Show, Switch, Match } from 'azerothjs';
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
