// End-to-end check of the `dom` compile target: compile real markup, run
// the EMITTED code against the real runtime, and assert the resulting DOM
// behaves - clone structure, static text, reactive holes, events, dynamic
// props. The emission-shape tests (template-target.test.ts) and the runtime
// helpers' tests (renderer/template.test.ts) each cover one side; this
// closes the seam between them.

import { describe, it, expect } from 'vitest';
import { compile } from '@azerothjs/compiler';
import * as runtime from '@azerothjs/core';
import { createSignal, subscriberCount } from '@azerothjs/reactivity';
import { hydrate } from '@azerothjs/renderer';
import { renderToString } from '@azerothjs/server';

/**
 * Compiles `source` with the dom target and evaluates the output. The
 * injected `import { ... } from '@azerothjs/core'` line becomes a
 * destructuring from the real runtime; `scope` supplies the source's free
 * identifiers. The source must be plain JS (oxc/TS stripping is Vite's job,
 * not the compiler's).
 */
function run(source: string, scope: Record<string, unknown>): unknown
{
    const { code } = compile(source, 'e2e.azeroth', { target: 'dom' });

    const body = code.replace(
        /import \{ ([^}]+) \} from '@azerothjs\/core';/,
        'const { $1 } = __runtime;'
    );
    expect(body).not.toContain('import ');

    const names = Object.keys(scope);
    const factory = new Function('__runtime', ...names, `${ body }\nreturn __result;`);
    return factory(runtime, ...Object.values(scope));
}

describe('dom target end to end', () =>
{
    it('renders a static region from a cloned template', () =>
    {
        const el = run(
            'const __result = <h1 class="title">Static heading</h1>;',
            {}
        ) as HTMLElement;

        expect(el.tagName).toBe('H1');
        expect(el.className).toBe('title');
        expect(el.textContent).toBe('Static heading');
    });

    it('binds reactive holes, dynamic props, and events on the clone', () =>
    {
        const [count, setCount] = createSignal(0);
        const [active, setActive] = createSignal(false);
        let clicks = 0;

        const el = run(
            'const __result = <button class={active() ? "on" : "off"} onClick={bump}>Count: {count()}</button>;',
            { count, active, bump: (): number => clicks++ }
        ) as HTMLElement;

        expect(el.textContent).toBe('Count: 0');
        expect(el.getAttribute('class')).toBe('off');

        setCount(5);
        expect(el.textContent).toBe('Count: 5');

        setActive(true);
        expect(el.getAttribute('class')).toBe('on');

        // Compiled events are delegated; the click must bubble from a
        // connected element.
        document.body.appendChild(el);
        el.click();
        expect(clicks).toBe(1);
        el.remove();
    });

    it('fills sole-child holes through the marker-free path', () =>
    {
        const [name, setName] = createSignal('a');

        const el = run(
            'const __result = <li class="row"><span class="id">{id}</span><a class="label">{name()}</a></li>;',
            { id: 42, name }
        ) as HTMLElement;

        expect(el.querySelector('.id')?.textContent).toBe('42');
        expect(el.querySelector('.label')?.textContent).toBe('a');

        setName('b');
        expect(el.querySelector('.label')?.textContent).toBe('b');
    });

    it('one dom-target artifact serves SSR, hydration, and fresh creation', () =>
    {
        const [count, setCount] = createSignal(3);

        // The compiled output is shared by every render mode: the guard
        // selects the universal h() branch for string/hydration and the
        // clone branch for fresh DOM.
        const source = 'const __result = () => <button class="counter">Count: {count()}</button>;';
        const App = run(source, { count }) as () => HTMLElement;

        // Server: string mode rides the universal branch.
        const html = renderToString(App);
        expect(html).toContain('class="counter"');
        expect(html).toContain('Count: ');

        // Client page load: drop the markup in, then hydrate with the SAME
        // compiled component.
        const container = document.createElement('div');
        container.innerHTML = html;
        const serverButton = container.querySelector('button')!;
        const serverText = serverButton.textContent;

        hydrate(App, container);

        // The server node was ADOPTED, not replaced, and is now live.
        expect(container.querySelector('button')).toBe(serverButton);
        expect(serverButton.textContent).toBe(serverText);
        setCount(4);
        expect(serverButton.textContent).toBe('Count: 4');

        // Post-hydration fresh creation takes the clone path.
        const fresh = App();
        expect(fresh).not.toBe(serverButton);
        expect(fresh.textContent).toBe('Count: 4');
    });

    it('component regions fall back to the live h() path', () =>
    {
        const [show, setShow] = createSignal(true);
        const [tick] = createSignal(0);

        const el = run(
            'const __result = <Show when={show}><p>{tick()}</p></Show>;',
            { show, tick }
        ) as HTMLElement;

        expect(el.textContent).toBe('0');
        setShow(false);
        expect(el.textContent).toBe('');
        // The hidden branch released its subscription - the fallback path
        // has the same lifetime behavior as hand-written h().
        expect(subscriberCount(tick)).toBe(0);
    });
});
