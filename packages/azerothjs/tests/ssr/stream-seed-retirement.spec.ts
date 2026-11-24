import { afterEach, expect, it, vi } from 'vitest';
import { createResource, h, hydrate, renderToStream, Suspense } from 'azerothjs';
import type { MountNode, Resource } from 'azerothjs';
import { clearStreamPage, streamPage } from './stream-test-page.ts';

const host = globalThis as typeof globalThis & { __AZS: (id: number) => void; __AZS_S: Record<string, unknown> };

afterEach(clearStreamPage);

function boundary(on: Resource<unknown>[], children: () => MountNode, fallback = () => h('i', {}, 'waiting')): MountNode
{
    return Suspense({ on, children, fallback });
}

function value(resource: Resource<string>): MountNode
{
    return boundary([resource], () => h('b', {}, () => resource.data()));
}

it('retires a delivered fallback descendant when its parent chunk arrives and preserves another root', async () =>
{
    const parent = Promise.withResolvers<string>();
    const sibling = vi.fn(() => Promise.resolve('sibling'));
    const widget = () => value(createResource(sibling));
    const reader = renderToStream(() =>
    {
        const outer = createResource(() => parent.promise);
        const inner = createResource(() => Promise.resolve('inner'));
        const inline = createResource(() => Promise.resolve('inline'));
        const temporary = () => boundary([inner], () => h('div', {}, value(inline)));
        return h('main', {}, boundary([outer], () => h('b', {}, 'outer'), () => h('section', {}, temporary())),
            h('aside', {}, widget()));
    }).getReader();
    const decoder = new TextDecoder();
    let wire = '';
    while (!wire.includes('__AZS(1)') || !wire.includes('__AZS(2)'))
    {
        const part = await reader.read();
        expect(part.done).toBe(false);
        wire += decoder.decode(part.value);
    }
    expect(wire).toContain('"3.0"');
    parent.resolve('outer');
    for (;;)
    {
        const part = await reader.read();
        if (part.done)
        {
            break;
        }
        wire += decoder.decode(part.value);
    }
    const root = await streamPage(wire);
    expect(root.textContent).toBe('outersibling');
    expect(Object.keys(host.__AZS_S).sort()).toEqual(['0.0', '0.l', '2.0', '2.l']);
    const aside = root.querySelector('aside')!;
    const node = aside.firstElementChild;
    hydrate(widget, aside);
    expect(aside.firstElementChild).toBe(node);
    expect(sibling).toHaveBeenCalledOnce();
});

it('retires only the numbered descendants of a range rebuilt during hydration', async () =>
{
    const root = await streamPage('<main><!--azc:suspense:0--><section><!--azc:suspense:1--><b>removed</b><!--/azc--></section><!--/azc--></main>'
        + '<aside><!--azc:suspense:10--><b>saved</b><!--/azc--></aside>');
    Object.assign(host.__AZS_S, { '0.0': null, '0.l': 1, '1.0': { d: 'removed' }, '1.l': 1, '10.0': { d: 'saved' }, '10.l': 1 });
    const request = Promise.withResolvers<string>();
    const main = root.querySelector('main')!;
    hydrate(() => value(createResource(() => request.promise)), main);
    expect(main.textContent).toBe('waiting');
    expect(Object.keys(host.__AZS_S).sort()).toEqual(['10.0', '10.l']);
    request.resolve('replacement');
    await vi.waitFor(() => expect(main.textContent).toBe('replacement'));
    const sibling = vi.fn(() => Promise.resolve('wrong'));
    const aside = root.querySelector('aside')!;
    hydrate(() =>
    {
        const resource = createResource(sibling);
        return boundary([resource], () => h('b', {}, resource.data()));
    }, aside);
    expect(aside.textContent).toBe('saved');
    expect(sibling).toHaveBeenCalledTimes(0);
});

it.each(['fallback', 'delivered'])('keeps the %s range when a chunk call has no template', async state =>
{
    const root = await streamPage(state === 'delivered'
        ? renderToStream(() => value(createResource(() => Promise.resolve('ready'))))
        : '<!--azc:suspense:0--><b>waiting</b><!--/azc-->');
    const node = root.querySelector('b')!;
    const before = { ...host.__AZS_S };
    const script = document.createElement('script');
    script.type = 'application/json';
    script.dataset.azsSeed = '0';
    script.textContent = '{"0.0":{"d":"torn"}}';
    root.append(script);
    host.__AZS(0);
    expect(script.isConnected).toBe(false);
    expect(root.querySelector('b')).toBe(node);
    expect(host.__AZS_S).toEqual(before);
});

it.each(['shorter list', 'later name mismatch', 'extreme length'])('rejects the whole seed group before publishing any value on %s', async scenario =>
{
    let client = false;
    const a = vi.fn(() => Promise.resolve(client ? 'client A' : 'server A'));
    const b = vi.fn(() => Promise.resolve(client ? 'client B' : 'server B'));
    const widget = () =>
    {
        const first = createResource(a, { name: 'same' });
        const second = createResource(b, { name: client && scenario === 'later name mismatch' ? 'changed' : 'same' });
        const list = client && scenario === 'shorter list' ? [second] : [first, second];
        return boundary(list, () => h('b', {}, () => list.map(item => item.data()).join('/')));
    };
    const root = await streamPage(renderToStream(() => h('main', {}, widget())));
    const main = root.querySelector('main')!;
    expect(main.textContent).toBe('server A/server B');
    const other = { d: 'other root' };
    host.__AZS_S['10.0'] = other;
    if (scenario === 'extreme length')
    {
        host.__AZS_S['0.l'] = Number.MAX_SAFE_INTEGER;
    }
    client = true;
    hydrate(widget, main);
    await vi.waitFor(() => expect(main.textContent).toBe(scenario === 'shorter list' ? 'client B' : 'client A/client B'));
    expect(host.__AZS_S).toEqual({ '10.0': other });
});

it.each(['missing outcome', 'missing group'])('recovers a delivered inline child with a %s without replacing a sibling draft', async scenario =>
{
    let client = false;
    const slow = Promise.withResolvers<string>();
    const replacement = Promise.withResolvers<number>();
    const pending = Promise.withResolvers<string>();
    const page = () =>
    {
        const inner = createResource(() => client ? replacement.promise : Promise.resolve(22));
        const outer = createResource(() => client ? Promise.resolve('client outer') : slow.promise);
        const late = createResource(() => pending.promise);
        return h('main', {}, h('input', {}), boundary([outer], () => h('article', {}, h('p', {}, outer.data),
            boundary([inner], () => h('b', {}, () => inner.data()!.toFixed(1))),
            boundary([late], () => h('strong', {}, late.data), () => h('label', {}, 'pending sibling')))));
    };
    const reader = renderToStream(page).getReader();
    const decoder = new TextDecoder();
    let wire = decoder.decode((await reader.read()).value);
    slow.resolve('server outer');
    while (!wire.includes('__AZS(0)'))
    {
        const part = await reader.read();
        expect(part.done).toBe(false);
        wire += decoder.decode(part.value);
    }
    await reader.cancel();
    const holder = document.createElement('div');
    holder.innerHTML = wire;
    const script = holder.querySelector('script[data-azs-seed="0"]')!;
    const seeds = JSON.parse(script.textContent) as Record<string, unknown>;
    expect(seeds['1.0']).toMatchObject({ d: 22 });
    delete seeds['1.0'];
    if (scenario === 'missing group')
    {
        delete seeds['1.l'];
    }
    script.textContent = JSON.stringify(seeds);
    const root = await streamPage(holder.innerHTML);
    const input = root.querySelector('input')!;
    const outerText = root.querySelector('p')!;
    const pendingLabel = root.querySelector('label')!;
    input.value = 'draft';
    client = true;
    hydrate(page, root);
    expect(root.querySelector('label')).toBe(pendingLabel);
    pending.resolve('client sibling');
    replacement.resolve(99);
    await vi.waitFor(() => expect(root.querySelector('b')?.textContent).toBe('99.0'));
    expect(root.querySelector('strong')?.textContent).toBe('client sibling');
    expect(root.querySelector('input')).toBe(input);
    expect(input.value).toBe('draft');
    expect(root.querySelector('p')).toBe(outerText);
    expect(outerText.textContent).toBe('server outer');
});
