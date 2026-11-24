// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createSignal, h, renderToString } from 'azerothjs';
import { compileComponent } from './executor.ts';
import { generateModule } from '../../src/codegen.ts';

const svg = 'http://www.w3.org/2000/svg';
const html = 'http://www.w3.org/1999/xhtml';
const math = 'http://www.w3.org/1998/Math/MathML';

describe('compiled text follows its host namespace', () =>
{
    it('uses the server spelling for inert JSON data in a fresh clone', () =>
    {
        const json = '{"label":"<ScRiPture & art"}';
        const app = compileComponent(`component App { <script type="application/json">${ json }</script> }`, 'App');
        const expected = renderToString(() => h('script', { type: 'application/json' }, json));
        const node = app() as Element;
        expect(node.outerHTML).toBe(expected);
        const eager = compileComponent(`component App { <Show when={true}><script type="application/json">${ json }</script></Show> }`, 'App');
        expect((eager() as DocumentFragment).querySelector('script')?.outerHTML).toBe(expected);
        expect(JSON.parse(node.textContent)).toEqual({ label: '<ScRiPture & art' });
    });

    it('uses the server spelling for a CSS label in a fresh clone', () =>
    {
        const css = '.note { --path: "catalog</stylesheet collection" }';
        const app = compileComponent(`component App { <style>${ css }</style> }`, 'App');
        const expected = renderToString(() => h('style', {}, css));
        expect((app() as Element).outerHTML).toBe(expected);
        const eager = compileComponent(`component App { <Show when={true}><style>${ css }</style></Show> }`, 'App');
        expect((eager() as DocumentFragment).querySelector('style')?.outerHTML).toBe(expected);
    });

    it.each(['xmp', 'iframe', 'noembed', 'noframes'])('writes decoded static text verbatim inside HTML %s', tag =>
    {
        const source = `component App { <${ tag }>tea &amp; biscuits &lt; 5</${ tag }> }`;
        const expected = `<${ tag }>tea & biscuits < 5</${ tag }>`;
        expect(generateModule(source).code).toContain(`tmpl('${ expected }')`);
        expect(renderToString(() => compileComponent(source, 'App')() as HTMLElement)).toBe(expected);
    });

    it('interns detached row templates by namespace as well as HTML', () =>
    {
        const source = `component App {
            <main><For each={[1]} key={n => n} let={n}><a>row</a></For>
              <svg><For each={[1]} key={n => n} let={n}><a>row</a></For></svg></main> }`;
        const { code } = generateModule(source);
        expect(code).toContain("tmpl('<a>row</a>')");
        expect(code).toContain("tmpl('<a>row</a>', 'svg')");
        const app = compileComponent(source, 'App');
        const anchors = Array.from((app() as Element).querySelectorAll('a'));
        expect(anchors.map(a => a.namespaceURI)).toEqual([html, svg]);
    });

    it.each([
        ['svg', svg],
        ['math', math]
    ])('writes foreign text as character data inside %s', (tag, namespace) =>
    {
        const source = `component App { <${ tag }><style><![CDATA[.label { --name: "A & B < C" }]]></style></${ tag }> }`;
        const app = compileComponent(source, 'App');
        const expected = `<${ tag }><style>.label { --name: "A &amp; B &lt; C" }</style></${ tag }>`;
        expect(renderToString(() => app() as HTMLElement)).toBe(expected);
        expect(generateModule(source).code).toContain(expected);
        // happy-dom's HTML parser differs from browsers on foreign content. Exercise the eager
        // expression path here and check the clone parser separately in the packed browser app.
        const eager = compileComponent(`component App { const view = () => <${ tag }><style><![CDATA[.a { color: red }]]></style></${ tag }>; <main>{view()}</main> }`, 'App');
        const style = (eager() as Element).querySelector('style')!;
        expect([style.namespaceURI, style.textContent]).toEqual([namespace, '.a { color: red }']);
    });

    it('carries placement across a conditional expression, component fallback and callback', () =>
    {
        const app = compileComponent(`component App {
            const hNS = () => 'local';
            const view = () => <svg><g>{true ? <a/> : null}</g><Show when={false} fallback={<a/>}><g/></Show>
                <Show when={true}>{() => <a/>}</Show><desc><a>{hNS()}</a></desc></svg>;
            <main>{view()}</main> }`, 'App');
        const anchors = Array.from((app() as Element).querySelectorAll('a'));
        expect(anchors.map(a => a.namespaceURI)).toEqual([svg, svg, svg, html]);
        expect(anchors[3]?.textContent).toBe('local');
    });

    it('resolves MathML integration points after an expression chooses its root', () =>
    {
        const app = compileComponent(`component App {
            const view = () => <math>
                <mi>{true ? <mglyph/> : null}<Show when={true}>{() => <malignmark/>}</Show><a/></mi>
                <annotation-xml>{true ? <svg><style>.note { fill: red }</style></svg> : null}</annotation-xml>
                <annotation-xml ENCODING="TEXT/HTML"><a/></annotation-xml></math>;
            <main>{view()}</main> }`, 'App');
        const root = app() as Element;
        const names = ['mglyph', 'malignmark', 'mi a', 'style', 'annotation-xml a'];
        expect(names.map(name => root.querySelector(name)?.namespaceURI)).toEqual([math, math, html, svg, html]);
        expect(root.querySelectorAll('annotation-xml')[1]?.getAttribute('encoding')).toBe('TEXT/HTML');
    });

    it('passes the same SVG stylesheet through an explicit and a spread fallback', () =>
    {
        const fallback = '() => <style><![CDATA[.note { fill: green }]]></style>';
        const source = `component App { <svg><Show when={false} fallback={${ fallback }}><g/></Show>
            <Show when={false} {...{fallback: ${ fallback }}}><g/></Show></svg> }`;
        const styles = Array.from((compileComponent(source, 'App')() as Element).querySelectorAll('style'));
        expect(styles.map(style => [style.namespaceURI, style.textContent])).toEqual([
            [svg, '.note { fill: green }'], [svg, '.note { fill: green }']
        ]);
    });

    it.each([
        'innerHTML={p.owner()} textContent={p.other()}',
        'textContent={p.other()} innerHTML={p.owner()}'
    ])('keeps the elected content binding through a client update (%s)', attrs =>
    {
        const app = compileComponent(`component App(p) { <style ${ attrs }/> }`, 'App');
        const [owner, setOwner] = createSignal('first');
        const [other, setOther] = createSignal('unused');
        const view = (): HTMLElement => app({ owner, other }) as HTMLElement;
        const style = view();
        expect(style.textContent).toBe('first');
        expect(renderToString(view)).toBe('<style>first</style>');
        setOwner('second');
        setOther('later');
        expect(style.textContent).toBe('second');
    });
});
