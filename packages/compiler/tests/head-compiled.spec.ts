// @vitest-environment happy-dom
//
// The head runtime through REAL COMPILED OUTPUT: a compiled leaf declaring a
// loader-derived title and live JSON-LD tracks across param navigations under an
// animated route transition.
import { it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { h, render, useHead, useLoader, createRouter, createMemoryHistory, Routes, Outlet, For, Show, Switch, Match } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import type { Route, Router, MountNode } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function compile(source: string, injected: Record<string, unknown> = {}): (props?: Record<string, unknown>) => unknown
{
    const generated = generateModule(source, 'T.azeroth', {});
    const code = typeof generated === 'string' ? generated : generated.code;
    const body = code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const name = (/^function\s+(\w+)/m.exec(body) as RegExpExecArray)[1] as string;
    const extras = { For, Show, Switch, Match, useHead, useLoader, ...injected };
    const keys = [...Object.keys(runtime), ...Object.keys(extras)];
    const values: Record<string, unknown> = { ...(runtime as unknown as Record<string, unknown>), ...extras };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(...keys, `${ body }\nreturn ${ name };`) as (...args: unknown[]) => (props?: Record<string, unknown>) => unknown;
    return factory(...keys.map((k) => values[k]));
}

it('COMPILED leaf: loader-derived jsonLd tracks across param navigations', async () =>
{
    resetHead();
    const source =
        'import { useHead, useLoader } from \'azerothjs\';\n'
        + 'export default component Leaf()\n{\n'
        + '    const profile = useLoader();\n'
        + '    useHead({\n'
        + '        title: () => profile.data()?.name ?? \'User\',\n'
        + '        jsonLd: () => ({ \'@type\': \'Person\', name: profile.data()?.name ?? \'None\' })\n'
        + '    });\n'
        + '    <span class="leaf">x</span>\n}\n';
    const Leaf = compile(source);

    const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        h('div', {}, Outlet({ children: props.children }));
    const routes: Route[] =
    [{
        path: '/users',
        component: Layout,
        children: [{
            path: ':id',
            component: Leaf as never,
            loader: async ({ params }) => ({ name: String(params.id).toUpperCase() })
        }]
    }];
    const container = document.createElement('div');
    document.body.appendChild(container);
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory('/users/aria') });
        return h('div', {}, Routes({ router, transition: 'page', transitionDuration: 100 }));
    }, container);
    await flush();

    const dump = (): string[] => [...document.head.querySelectorAll('script[data-azeroth-head="jsonld"]')].map((s) => s.textContent);
    expect(document.title).toBe('ARIA');
    expect(dump()).toEqual(['{"@type":"Person","name":"ARIA"}']);

    router.navigate('/users/cael');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.title).toBe('CAEL');
    expect(dump()).toEqual(['{"@type":"Person","name":"CAEL"}']);

    render(() => h('div', {}), container);
    container.remove();
});
