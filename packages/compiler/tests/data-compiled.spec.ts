// @vitest-environment happy-dom
//
// The data cache through REAL COMPILED OUTPUT: two compiled components declaring
// `resource ... with { source }` over one `cached` family issue ONE fetch between them -
// the count is the assertion, because a render-only compiled probe would pass a broken
// branded-fetcher integration.
import { it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { h, render, cached, For, Show, Switch, Match } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

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
    const extras = { For, Show, Switch, Match, ...injected };
    const keys = [...Object.keys(runtime), ...Object.keys(extras)];
    const values: Record<string, unknown> = { ...(runtime as unknown as Record<string, unknown>), ...extras };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(...keys, `${ body }\nreturn ${ name };`) as (...args: unknown[]) => (props?: Record<string, unknown>) => unknown;
    return factory(...keys.map((k) => values[k]));
}

it('COMPILED: two resource-keyword consumers of one cached family share ONE fetch', async () =>
{
    resetDataCache();
    let fetches = 0;
    const getUser = cached('compiled-shared-user', async (id) =>
    {
        fetches += 1;
        return `user-${ String(id) }-fetch-${ fetches }`;
    });

    const source =
        'import { getUser } from \'./api.ts\';\n'
        + 'export default component Card(props)\n{\n'
        + '    resource user = getUser with { source: props.id };\n'
        + '    <span class="card">{ user.data() ?? \'...\' }</span>\n}\n';
    const Card = compile(source, { getUser });

    const container = document.createElement('div');
    document.body.appendChild(container);
    render(() => h('div', {},
        Card({ id: 7 }) as HTMLElement,
        Card({ id: 7 }) as HTMLElement), container);
    await flush();

    // The compiled keyword path went through the shared entry: one fetch, both rendered.
    expect(fetches).toBe(1);
    const cards = [...container.querySelectorAll('.card')].map((el) => el.textContent);
    expect(cards).toEqual(['user-7-fetch-1', 'user-7-fetch-1']);

    render(() => h('div', {}), container);
    container.remove();
    resetDataCache();
});
