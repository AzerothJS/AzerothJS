// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Runtime = typeof import('azerothjs');

// Browsers expose named controls over inherited properties on their form.
// Install that lookup in DOM emulators that only expose form.elements by name.
function exposeNamedControls(form: HTMLFormElement): () => void
{
    const installed: string[] = [];
    for (const input of form.querySelectorAll('input[name]'))
    {
        const name = input.getAttribute('name')!;
        if (Reflect.get(form, name) !== input)
        {
            Object.defineProperty(form, name, { configurable: true, value: input });
            installed.push(name);
        }
    }
    return () => installed.forEach(name => Reflect.deleteProperty(form, name));
}

it('locates a standalone cursor mismatch in a supplied DOM without global DOM constructors', async () =>
{
    const { HydrationCursor, HydrationMismatchError } = await import('azerothjs/internal');
    customElements.define('standalone-draft', class extends HTMLElement
    {
        public override get tagName(): string
        {
            throw new Error('application getter reached by the standalone cursor');
        }
    });
    const host = document.createElement('standalone-draft');
    host.appendChild(document.createElement('span'));
    const cursor = new HydrationCursor(host);
    let error: unknown;
    vi.stubGlobal('Node', undefined);
    vi.stubGlobal('Element', undefined);
    try
    {
        cursor.takeElement('button');
    }
    catch (caught)
    {
        error = caught;
    }
    finally
    {
        vi.unstubAllGlobals();
    }
    expect(error).toBeInstanceOf(HydrationMismatchError);
    expect((error as Error).message).toContain('<standalone-draft>');
    expect((error as Error).message).toContain('<span>');
});

// DEV is read when the module loads. Exercise both real configurations with a fresh
// runtime, including its renderer, reactive graph and route completion barrier.
describe.each(['development', 'production'])('%s hydration fallback reporting', environment =>
{
    let az: Runtime;
    let root: HTMLElement;
    beforeAll(async () =>
    {
        vi.resetModules();
        vi.stubEnv('NODE_ENV', environment);
        az = await import('azerothjs');
        expect((await import('../../src/reactivity/dev.ts')).DEV).toBe(environment === 'development');
    });
    afterAll(() => vi.unstubAllEnvs());
    beforeEach(() =>
    {
        root = document.body.appendChild(document.createElement('div'));
    });
    afterEach(() =>
    {
        az.render(() => document.createElement('i'), root);
        root.remove();
    });

    it.each([
        ['wrong element', '<main><label><b title="private-value"></b></label></main>', /<label>/, /<b>/],
        ['missing element', '<main><label></label></main>', /<label>/, /end of children/i],
        ['unexpected text', '<main><label>private-value</label></main>', /<label>/, /text/i],
        ['unexpected comment', '<main><label><!--private-value--></label></main>', /<label>/, /comment/i],
        ['unrecognized control marker', '<main><label><!--azc:private-value--></label></main>', /<label>/, /comment/i]
    ] as const)('%s identifies its local parent and stopping node', (_name, html, parent, stop) =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        root.innerHTML = html;
        const old = root.firstChild;
        const clicked = vi.fn();
        az.hydrate(() => az.h('main', {}, az.h('label', {}, az.h('button', { onClick: clicked }))), root);
        expect(root.firstChild).not.toBe(old);
        root.querySelector('button')!.click();
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toMatch(/falling back to full client render/i);
        expect(message).toContain('<button>');
        expect(message).toMatch(parent);
        expect(message).toMatch(stop);
        expect(message).not.toContain('private-value');
    });

    it('names the actual parent of a row inside a parser-inserted table section', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        root.innerHTML = '<table><tbody><tr><td>served</td></tr></tbody></table>';
        az.hydrate(() => az.h('table', {}, az.h('caption', {}, 'client')), root);
        expect(root.querySelector('caption')?.textContent).toBe('client');
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toMatch(/<tbody>/);
        expect(message).toMatch(/<tr>/);
    });

    it.each([
        ['tagName alone', ['tagName']],
        ['multiple DOM properties', ['nodeType', 'nodeName', 'tagName', 'parentNode']]
    ] as const)(
        'reports the form container when controls shadow %s', (_case, names) =>
        {
            const form = root.appendChild(document.createElement('form'));
            for (const name of names)
            {
                const input = document.createElement('input');
                input.name = name;
                form.appendChild(input);
            }
            const served = form.appendChild(document.createElement('span'));
            const restore = exposeNamedControls(form);
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try
            {
                az.hydrate(() => [...names.map(name => az.h('input', { name })), az.h('button', {}, 'fresh')], form);
                expect(form.contains(served)).toBe(false);
                expect(form.querySelector('button')?.textContent).toBe('fresh');
                expect(warn).toHaveBeenCalledTimes(1);
                const message = String(warn.mock.calls[0]![0]);
                expect(message).toMatch(/falling back to full client render/i);
                expect(message).toContain('<form>');
                expect(message).toContain('<span>');
            }
            finally
            {
                restore();
            }
        }
    );

    it.each([false, true])('adopts the nested form before handling its children (mismatch: %s)', mismatch =>
    {
        const app = (tag: string) => az.h('section', {}, az.h('form', {},
            az.h('input', { name: 'tagName' }), az.h('input', { name: 'nodeType' }), az.h(tag, {})));
        root.innerHTML = az.renderToString(() => app('span'));
        const form = root.querySelector('form')!;
        const draft = form.querySelector('input')!;
        draft.value = 'draft before boot';
        const restore = exposeNamedControls(form);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            az.hydrate(() => app(mismatch ? 'button' : 'span'), root);
            if (mismatch)
            {
                expect(root.querySelector('button')).not.toBeNull();
                expect(warn).toHaveBeenCalledTimes(1);
                expect(String(warn.mock.calls[0]![0])).toContain('<form>');
                expect(String(warn.mock.calls[0]![0])).toContain('<span>');
            }
            else
            {
                expect(root.firstChild?.firstChild).toBe(form);
                expect(form.firstChild).toBe(draft);
                expect(draft.value).toBe('draft before boot');
                expect(warn).not.toHaveBeenCalled();
            }
        }
        finally
        {
            restore();
        }
    });

    it('reports the end of an unterminated reactive hole in its own bounded range', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const app = () => az.h('main', {}, az.Show({
            when: true, children: () => [az.h('b', {}), () => 'note']
        }), az.h('aside', {}));
        root.innerHTML = az.renderToString(app).replace('<!--]-->', '');
        const old = root.querySelector('aside');
        az.hydrate(app, root);
        expect(root.querySelector('aside')).not.toBe(old);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toMatch(/unterminated reactive-hole/i);
        expect(message).toContain('<main>');
        expect(message).toMatch(/end of children/i);
        expect(message).not.toContain('<aside>');
    });

    it.each(['parent', 'stopped'] as const)('uses the DOM tag of the %s custom element during recovery', position =>
    {
        const tag = `draft-station-${ environment }-${ position }`;
        customElements.define(tag, class extends HTMLElement
        {
            public override get nodeName(): string
            {
                throw new Error('application getter reached during recovery');
            }
        });
        const host = document.createElement(tag);
        const target = position === 'parent' ? host : root;
        target.appendChild(position === 'parent' ? document.createElement('span') : host);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        az.hydrate(() => az.h('button', {}, 'fresh'), target);
        expect(target.querySelector('button')?.textContent).toBe('fresh');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain(`<${ tag }>`);
    });

    it.each(['extra node', 'missing control close'] as const)('locates a %s during the child walk', kind =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const app = () => az.h('figure', {}, az.Show({ when: true, children: () => az.h('i', {}) }));
        const served = az.renderToString(app);
        root.innerHTML = kind === 'extra node' ? served.replace('</figure>', '<!--private-value--></figure>') :
            served.replace('<!--/azc-->', '');
        const old = root.firstChild;
        az.hydrate(app, root);
        expect(root.firstChild).not.toBe(old);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toContain('<figure>');
        expect(message).toMatch(kind === 'extra node' ? /unexpected extra node/i : /unterminated control-flow/i);
        expect(message).toMatch(kind === 'extra node' ? /comment/i : /end of children/i);
        expect(message).not.toContain('private-value');
    });

    it('identifies a version-skewed route outlet without publishing the served marker body', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const router = az.createRouter({ history: az.createMemoryHistory('/team/desk'), routes: [{
            path: '/team',
            component: props => az.h('article', {}, az.Outlet({ children: props.children })),
            children: [{ path: 'desk', component: () => az.h('input', {}) }]
        }] });
        const app = () => az.h('main', {}, az.Routes({ router }));
        const served = az.renderToString(app);
        expect(served).toContain('<!--azc:outlet-->');
        root.innerHTML = served.replace('<!--azc:outlet-->', '<!--azc:private-value-->');
        const input = root.querySelector('input');
        warn.mockClear();
        az.hydrate(app, root);
        expect(root.querySelector('input')).not.toBe(input);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toMatch(/version skew/);
        expect(message).toContain('<article>');
        expect(message).toMatch(/comment/i);
        expect(message).not.toContain('private-value');
    });

    it('reports only the replaced island and leaves the shell and matching island live', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const click = vi.fn();
        const button = () => az.h('button', { onClick: click }, 'claim');
        root.innerHTML = az.renderToString(() => az.h('main', {}, az.h('input', {}),
            az.island('/served', () => az.h('section', {}, az.h('i', {})), {}),
            az.island('/matching', button, {})));
        const input = root.querySelector('input');
        const oldButton = root.querySelector('button')!;
        const oldSection = root.querySelector('section');
        const revived = await az.hydrateIslands({
            '/served': async () => () => az.h('section', {}, az.h('b', {})),
            '/matching': async () => button
        }, root);
        expect(revived).toBe(2);
        expect(root.querySelector('section')).not.toBe(oldSection);
        expect(root.querySelector('section > b')).not.toBeNull();
        expect(root.querySelector('input')).toBe(input);
        expect(root.querySelector('button')).toBe(oldButton);
        oldButton.click();
        expect(click).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toMatch(/island replaced/i);
        expect(message).toContain('<section>');
        expect(message).toContain('<i>');
        expect(message).not.toContain('full client render');
    });

    it('emits no fallback report on successful adoption or an application exception', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const app = () => az.h('main', {}, 'served');
        root.innerHTML = az.renderToString(app);
        const served = root.firstChild;
        az.hydrate(app, root);
        expect(root.firstChild).toBe(served);
        const error = new Error('application error');
        expect(() => az.hydrate(() =>
        {
            throw error;
        }, root)).toThrow(error);
        expect(warn).not.toHaveBeenCalled();
    });

    it('reports the active deferred mismatch once and ignores a different abandoned mount', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        function start(container: HTMLElement)
        {
            const serverRouter = az.createRouter({ history: az.createMemoryHistory('/'),
                routes: [{ path: '/', component: () => az.h('article', {}, az.h('span', {})) }] });
            container.innerHTML = az.renderToString(() => az.h('main', {}, az.Routes({ router: serverRouter })));
            const chunk = Promise.withResolvers<{ default: () => HTMLElement }>();
            const router = az.createRouter({ history: az.createMemoryHistory('/'),
                routes: [{ path: '/', lazy: () => chunk.promise }] });
            az.hydrate(() => az.h('main', {}, az.Routes({ router })), container);
            return { router, land: () => chunk.resolve({ default: () => az.h('article', {}, az.h('b', {})) }) };
        }
        const other = document.createElement('div');
        const active = start(root);
        const abandoned = start(other);
        const replacement = document.createElement('address');
        az.render(() => replacement, other);
        warn.mockClear(); // A router created outside an owner can issue its own development hint.
        abandoned.land();
        active.land();
        await vi.waitFor(() =>
        {
            expect(abandoned.router.chainReady()).toBe(true);
            expect(active.router.chainReady()).toBe(true);
            expect(root.querySelector('article > b')).not.toBeNull();
        });
        expect(other.firstChild).toBe(replacement);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        expect(message).toMatch(/falling back to full client render/i);
        expect(message).toContain('<article>');
        expect(message).toContain('<span>');
    });
});
