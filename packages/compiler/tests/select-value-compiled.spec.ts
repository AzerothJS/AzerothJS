// @vitest-environment happy-dom
//
// <select> initial value, driven through REAL COMPILED OUTPUT and the real runtime.
//
// These exist because the hand-written h() tests could not see the defect that mattered. The
// broken shapes were all compiled ones - <For> rows, <Show>/<Switch> reveals, <optgroup> nesting
// - and an earlier fix passed a browser check only because the probe used a <For> row with a
// DYNAMIC label, whose own bindContent effect happened to settle after insertion. With a STATIC
// row label there was no such accident and the defect was intact.
//
// Seed is 'de', the SECOND option, in every case: a select with no valid selection reports option
// 0, so a first-option seed passes against broken code.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { createSignal, render, renderToString, hydrate, For, Show, Switch, Match } from 'azerothjs';

/** Compiles `.azeroth` source and returns its default export, executed against the runtime. */
function compile(source: string): (props?: Record<string, unknown>) => unknown
{
    const generated = generateModule(source, 'T.azeroth', {});
    const code = typeof generated === 'string' ? generated : generated.code;
    const body = code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const name = (/^function\s+(\w+)/m.exec(body) as RegExpExecArray)[1] as string;

    const extras = { For, Show, Switch, Match };
    const keys = [...Object.keys(runtime), ...Object.keys(extras)];
    const values: Record<string, unknown> = { ...(runtime as unknown as Record<string, unknown>), ...extras };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the compiler's own output IS the point; a string assertion could not tell a working select from a well-spelled one
    const factory = new Function(...keys, `${ body }\nreturn ${ name };`) as (...args: unknown[]) => (props?: Record<string, unknown>) => unknown;
    return factory(...keys.map((k) => values[k]));
}

/** Mounts a compiled component into the document and returns its select. */
function mount(Component: (props?: Record<string, unknown>) => unknown, props: Record<string, unknown>): HTMLSelectElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(() => Component(props) as HTMLElement, container);
    return container.querySelector('select') as HTMLSelectElement;
}

const ALL = ['us', 'de', 'jp'];

// A written select repairs itself via its own MutationObserver, delivered on the microtask
// BEFORE the next paint (measured in Chrome). The invariant these tests hold is therefore
// "never painted wrong", one microtask after the change - not "true before the setter returns",
// which an earlier seam-based design provided at the cost of a quadratic mount walk.
const settled = (): Promise<void> => Promise.resolve();

describe('compiled <select> value with control-flow children', () =>
{
    it('<For> rows with a STATIC option label', async () =>
    {
        // The shape with no per-row reactive binding, so nothing incidentally settles after the
        // rows land. This is the case that survived the first fix.
        const C = compile(
            'export default component T(props: { list: () => string[] })\n{\n'
            + '    state country = \'de\';\n'
            + '    <select bind:value={country}>\n'
            + '        <For each={ props.list() } key={ (c) => c } let={ code }>\n'
            + '            <option value={code}>pick</option>\n'
            + '        </For>\n'
            + '    </select>\n}\n');

        const [list, setList] = createSignal<string[]>([]);
        const select = mount(C, { list });

        expect(select.options.length).toBe(0);
        setList(ALL);
        await settled();

        expect(select.options.length).toBe(3);
        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
    });

    it('<Show> revealing the matching option after mount', async () =>
    {
        const C = compile(
            'export default component T(props: { ready: () => boolean })\n{\n'
            + '    state country = \'de\';\n'
            + '    <select bind:value={country}>\n'
            + '        <option value="us">us</option>\n'
            + '        <Show when={ props.ready() }>\n'
            + '            <option value="de">de</option>\n'
            + '        </Show>\n'
            + '    </select>\n}\n');

        const [ready, setReady] = createSignal(false);
        const select = mount(C, { ready });

        expect(select.value).toBe('us');
        setReady(true);
        await settled();

        expect(select.options.length).toBe(2);
        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
    });

    it('<Switch>/<Match> revealing it', async () =>
    {
        const C = compile(
            'export default component T(props: { phase: () => string })\n{\n'
            + '    state country = \'de\';\n'
            + '    <select bind:value={country}>\n'
            + '        <option value="us">us</option>\n'
            + '        <Switch>\n'
            + '            <Match when={ props.phase() === \'loaded\' }>\n'
            + '                <option value="de">de</option>\n'
            + '            </Match>\n'
            + '        </Switch>\n'
            + '    </select>\n}\n');

        const [phase, setPhase] = createSignal('pending');
        const select = mount(C, { phase });

        setPhase('loaded');
        await settled();

        expect(select.options.length).toBe(2);
        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
    });

    it('<optgroup> nesting, where the option is two levels down', async () =>
    {
        const C = compile(
            'export default component T(props: { list: () => string[] })\n{\n'
            + '    state country = \'de\';\n'
            + '    <select bind:value={country}>\n'
            + '        <optgroup label="g">\n'
            + '            <For each={ props.list() } key={ (c) => c } let={ code }>\n'
            + '                <option value={code}>pick</option>\n'
            + '            </For>\n'
            + '        </optgroup>\n'
            + '    </select>\n}\n');

        const [list, setList] = createSignal<string[]>([]);
        const select = mount(C, { list });

        setList(ALL);
        await settled();

        expect(select.options.length).toBe(3);
        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
    });

    it('a user choice is never overwritten when the framework value arrives later', async () =>
    {
        // The hazard the re-apply model creates: the framework wanted 'de', 'de' did not exist,
        // the person picked something else, and then 'de' appeared. Their choice wins until the
        // application asks for something new.
        const C = compile(
            'export default component T(props: { list: () => string[] })\n{\n'
            + '    const country = \'de\';\n'
            + '    <select value={country}>\n'
            + '        <For each={ props.list() } key={ (c) => c } let={ code }>\n'
            + '            <option value={code}>pick</option>\n'
            + '        </For>\n'
            + '    </select>\n}\n');

        const [list, setList] = createSignal(['us', 'jp']);
        const select = mount(C, { list });

        select.selectedIndex = 1;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(select.value).toBe('jp');

        setList(ALL);
        await settled();

        expect(select.options.length).toBe(3);
        expect(select.value).toBe('jp');
    });

    it('recovers when a matched option is removed and re-added', async () =>
    {
        // A one-shot write forgets as soon as it succeeds, so an option that left and came back
        // never regained its selection.
        const C = compile(
            'export default component T(props: { list: () => string[] })\n{\n'
            + '    const country = \'de\';\n'
            + '    <select value={country}>\n'
            + '        <For each={ props.list() } key={ (c) => c } let={ code }>\n'
            + '            <option value={code}>pick</option>\n'
            + '        </For>\n'
            + '    </select>\n}\n');

        const [list, setList] = createSignal(ALL);
        const select = mount(C, { list });
        // Rows seeded at mount still insert AFTER the value effect ran (emit order), so even the
        // initial selection is the observer microtask.
        await settled();
        expect(select.value).toBe('de');

        setList(['us', 'jp']);
        await settled();
        expect(select.value).not.toBe('de');

        setList(ALL);
        await settled();
        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
    });

    it('<select multiple> selects every value in the array', async () =>
    {
        const C = compile(
            'export default component T(props: { list: () => string[] })\n{\n'
            + '    const chosen = [\'de\', \'jp\'];\n'
            + '    <select multiple value={chosen}>\n'
            + '        <For each={ props.list() } key={ (c) => c } let={ code }>\n'
            + '            <option value={code}>pick</option>\n'
            + '        </For>\n'
            + '    </select>\n}\n');

        const [list, setList] = createSignal<string[]>([]);
        const select = mount(C, { list });

        setList(ALL);
        await settled();

        expect(select.options.length).toBe(3);
        expect([...select.selectedOptions].map((o) => o.value)).toEqual(['de', 'jp']);
    });

    it('CONTROL: a first-option seed passes either way - the vacuity rule, pinned', async () =>
    {
        const C = compile(
            'export default component T(props: { list: () => string[] })\n{\n'
            + '    const country = \'us\';\n'
            + '    <select value={country}>\n'
            + '        <For each={ props.list() } key={ (c) => c } let={ code }>\n'
            + '            <option value={code}>pick</option>\n'
            + '        </For>\n'
            + '    </select>\n}\n');

        const [list, setList] = createSignal<string[]>([]);
        const select = mount(C, { list });
        setList(ALL);
        await settled();

        expect(select.options.length).toBe(3);
        expect(select.selectedIndex).toBe(0);
    });
});

describe('compiled <select> value through SSR and hydration', () =>
{
    const SOURCE = 'export default component T(props: { v: () => string })\n{\n'
        + '    <select value={ props.v() }>\n'
        + '        <option value="us">us</option>\n'
        + '        <option value="de" selected>de</option>\n'
        + '        <option value="jp">jp</option>\n'
        + '    </select>\n}\n';

    it('the select value beats an authored selected in SSR, hydration and client render alike', async () =>
    {
        // Hydration adopts an element's props BEFORE walking its children, so the authored
        // <option selected> was written after the select's own value and won - the hydrated page
        // then disagreed with its own client render, and the placeholder pattern
        // (<option value="" selected>Choose...</option> beside a controlled value) flipped to the
        // placeholder on hydration and submitted it. The adopter settles the select after its
        // child walk for exactly this reason; adoption performs no childList mutation, so the
        // observer that covers every other path cannot see it.
        const C = compile(SOURCE);
        const v = (): string => 'jp';

        const html = renderToString(() => C({ v }) as HTMLElement);
        expect(html.match(/selected/g)?.length).toBe(1);
        expect(html).toContain('<option value="jp" selected="">');

        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);
        const server = container.querySelector('select') as HTMLSelectElement;
        // NOT asserted through happy-dom's parser: it reports index 1 for this markup, while
        // Chrome reads index 2. The markup itself is asserted above; the parse is the environment's.
        expect(server.nodeName).toBe('SELECT');

        hydrate(() => C({ v }) as HTMLElement, container);
        const hydrated = container.querySelector('select') as HTMLSelectElement;
        expect(hydrated.selectedIndex).toBe(2);

        const client = mount(C, { v });
        expect(client.selectedIndex).toBe(2);
    });
});

describe('bind:value write-back on a multiple select', () =>
{
    it('writes back the selected SET, not the first option', async () =>
    {
        // $event.target.value reports only the first selected option, so a user ADDING a
        // selection collapsed the whole set to one entry and corrupted string[] state to a
        // string. The emitted write-back reads selectedOptions when the target is multiple.
        const C = compile(
            'export default component T(props: { seen: (v: unknown) => void })\n{\n'
            + '    state chosen = [\'de\'];\n'
            + '    effect { props.seen(chosen); }\n'
            + '    <select multiple bind:value={chosen}>\n'
            + '        <option value="us">us</option>\n'
            + '        <option value="de">de</option>\n'
            + '        <option value="jp">jp</option>\n'
            + '    </select>\n}\n');

        let last: unknown;
        const select = mount(C, { seen: (v: unknown) =>
        {
            last = v;
        } });
        await settled();
        // Per-option flags, NEVER selectedOptions: happy-dom caches that collection on first
        // read, and the write-back itself reads it - a pre-dispatch read here handed the
        // write-back a STALE one-entry set and made this test fail against correct code.
        expect([...select.options].map((o) => o.selected)).toEqual([false, true, false]);

        // The user adds jp; the write-back must deliver BOTH as an array.
        (select.options[2] as HTMLOptionElement).selected = true;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        await settled();

        expect(last).toEqual(['de', 'jp']);
    });
});
