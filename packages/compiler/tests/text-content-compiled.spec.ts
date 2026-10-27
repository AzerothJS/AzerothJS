// @vitest-environment happy-dom
//
// Regression: compiled output builds a noscript's content on a client render, and a clone built
// during a flush hands a spread-carried textarea value's text back to its children.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { createResource, createSignal, hydrate, render, renderToStream, For, Show, Suspense } from 'azerothjs';

interface AzsGlobal
{
    __AZS_S?: Record<string, unknown>;
    __AZS?: (id: number) => void;
}

/** Compiles `.azeroth` source and returns its default export, executed against the runtime. */
function compile(source: string): (props?: Record<string, unknown>) => unknown
{
    const code = generateModule(source, 'T.azeroth', {}).code;
    const name = (/^export\s+default\s+function\s+(\w+)/m.exec(code) as RegExpExecArray)[1] as string;
    const body = code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const extras = { createResource, For, Show, Suspense };
    const keys = [...Object.keys(runtime), ...Object.keys(extras)];
    const values: Record<string, unknown> = { ...(runtime as unknown as Record<string, unknown>), ...extras };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the compiler's own output
    const factory = new Function(...keys, `${ body }\nreturn ${ name };`) as (...args: unknown[]) => (props?: Record<string, unknown>) => unknown;
    return factory(...keys.map((key) => values[key]));
}

function mount(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

async function streamAll(stream: ReadableStream<Uint8Array>): Promise<string[]>
{
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const reader = stream.getReader();
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            return chunks;
        }
        chunks.push(decoder.decode(value, { stream: true }));
    }
}

// Inserts one wire chunk and runs its inline scripts in order, as a parsing browser does; happy-dom
// runs none, so each is called here with itself as document.currentScript.
function applyChunk(container: HTMLElement, chunk: string): void
{
    const holder = document.createElement('div');
    holder.innerHTML = chunk;
    for (const node of Array.from(holder.childNodes))
    {
        container.appendChild(node);
        if (node instanceof HTMLScriptElement && node.type === '')
        {
            vi.spyOn(document, 'currentScript', 'get').mockReturnValue(node);
            // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the stream's script
            (new Function(node.text) as () => void)();
        }
    }
}

afterEach(() =>
{
    document.body.innerHTML = '';
    delete (globalThis as AzsGlobal).__AZS_S;
    delete (globalThis as AzsGlobal).__AZS;
});

describe('a noscript in compiled output', () =>
{
    it('builds no image and calls no ref inside it on a client render, in a Show branch and in component children', () =>
    {
        const T = compile(
            'component Wrap(props: { children?: unknown }) { <section>{ props.children }</section> }\n'
            + 'export default component T(props: { hit: (el: unknown) => void; seen: (el: unknown) => void })\n{\n'
            + '    state on = true;\n'
            + '    <div>\n'
            + '        <Show when={ on }><noscript><img src="/a.gif" ref={ props.hit } /></noscript></Show>\n'
            + '        <Wrap><noscript><img src="/b.gif" ref={ props.hit } /></noscript></Wrap>\n'
            + '        <Show when={ on }><img src="/c.gif" ref={ props.seen } /></Show>\n'
            + '    </div>\n}\n');
        const hit = vi.fn();
        const seen = vi.fn();
        const container = mount();
        render(() => T({ hit, seen }) as HTMLElement, container);

        expect(seen).toHaveBeenCalledOnce();
        expect(hit).not.toHaveBeenCalled();
        expect(container.querySelectorAll('noscript img')).toHaveLength(0);
        expect(container.querySelectorAll('noscript')).toHaveLength(2);
    });

    // A guard that skipped the content while hydrating too would shift every later seed.
    it('keeps the streamed resource seeds aligned past a noscript at hydration (control)', async () =>
    {
        const source =
            'component NoJs()\n{\n'
            + '    const r = createResource(() => Promise.resolve(\'ns-data\'));\n'
            + '    <Suspense on={ [r] } fallback={ <i>wait</i> }><b>{ r.data() }</b></Suspense>\n}\n'
            + 'component Widget()\n{\n'
            + '    const r = createResource(() => Promise.resolve(\'w-data\'));\n'
            + '    <Suspense on={ [r] } fallback={ <i>wait</i> }><em id="w">{ r.data() }</em></Suspense>\n}\n'
            + 'export default component T()\n{\n'
            + '    <main><noscript><NoJs /></noscript><Widget /></main>\n}\n';
        const T = compile(source);

        const chunks = await streamAll(renderToStream(() => T() as HTMLElement));
        const container = mount();
        for (const chunk of chunks)
        {
            applyChunk(container, chunk);
        }
        expect(chunks.join('')).toContain('__AZS_S');
        expect(container.querySelector('#w')?.textContent).toBe('w-data');
        expect(container.querySelectorAll('script')).toHaveLength(0);

        const warn = vi.spyOn(console, 'warn');
        hydrate(() => T() as HTMLElement, container);
        await Promise.resolve();
        expect(warn.mock.calls.filter((call) => String(call[0]).includes('hydrate'))).toEqual([]);
        expect(container.querySelector('#w')?.textContent).toBe('w-data');
    });
});

describe('a spread-carried textarea value in a clone built during a flush', () =>
{
    it('wins over the children as the value and the default, and form.reset() keeps it', () =>
    {
        const T = compile(
            'export default component T(props: { rows: () => string[] })\n{\n'
            + '    state text = \'hi\';\n'
            + '    state kid = \'kid\';\n'
            + '    <form><For each={ props.rows() } key={ (row) => row } let={ row }><textarea {...{ value: () => text }}>{ kid }</textarea></For></form>\n}\n');
        const [rows, setRows] = createSignal<string[]>([]);
        const container = mount();
        render(() => T({ rows }) as HTMLElement, container);
        setRows(['a']);
        const form = container.querySelector('form')!;
        const ta = container.querySelector('textarea')!;

        expect(ta.value).toBe('hi');
        expect(ta.defaultValue).toBe('hi');
        form.reset();
        expect(ta.value).toBe('hi');
    });
});
