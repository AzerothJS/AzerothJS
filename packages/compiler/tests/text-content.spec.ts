// @vitest-environment node
//
// Regression: the clone template writes hole anchors and tags inside <textarea> and <title>, which
// the parser reads as text, and bakes a static textarea value in as an attribute it ignores.
import { describe, expect, it } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import { diagnoseModule } from '../src/diagnostics.ts';

const component = (markup: string): string =>
    `export default component C() { state v = 'hi'; state w = 'x'; state on = true; state items = ['a']; const rest = {}; ${ markup } }`;

const emitted = (markup: string): string => generateModule(component(markup)).code;

const findings = (markup: string): { code: string; text: string }[] =>
{
    const source = component(markup);
    return diagnoseModule(source)
        .filter(d => d.severity === 'error')
        .map(d => ({ code: d.code, text: source.slice(d.start, d.end) }));
};

describe('textarea and title compile to one text binding', () =>
{
    it('keeps holes out of the template and drives them with one bindText', () =>
    {
        const code = emitted('<textarea name="t">Hello { v } and { w }</textarea>');

        expect(code).toContain('tmpl(\'<textarea name="t"></textarea>\')');
        expect(code).toContain('bindText(_n0, \'Hello \', () => ( v() ), \' and \', () => ( w() ));');
        expect(code).not.toContain('bindHole');
        expect(code).toContain('h(\'textarea\', { name: \'t\' }, \'Hello \', () => ( v() ), \' and \', () => ( w() ))');
    });

    it('drives a sole hole and a title the same way', () =>
    {
        expect(emitted('<textarea>{ v }</textarea>')).toContain('bindText(_n0, () => ( v() ));');
        const title = emitted('<div><title>{ v } - Site</title></div>');
        expect(title).toContain('tmpl(\'<div><title></title></div>\')');
        expect(title).toContain('bindText(_n1, () => ( v() ), \' - Site\');');
    });

    it('drives a textarea in a For row clone the same way', () =>
    {
        const code = emitted('<ul><For each={ items } key={ (item) => item } let={ item }><li><textarea>Row { item }</textarea></li></For></ul>');

        expect(code).toContain('tmpl(\'<li><textarea></textarea></li>\')');
        expect(code).toContain('bindText(_n1, \'Row \', () => (item()));');
    });

    it('passes text and holes as children in a Show branch and component children (control)', () =>
    {
        expect(emitted('<div><Show when={ on }><textarea>Hello { v }</textarea></Show></div>'))
            .toContain('h(\'textarea\', {  }, \'Hello \', () => ( v() ))');
        expect(emitted('<Wrap><title>{ v } - Site</title></Wrap>'))
            .toContain('h(\'title\', {  }, () => ( v() ), \' - Site\')');
    });

    it('drives a mixed-case textArea and tiTle with bindText and leaves a noScript\'s content out of the clone', () =>
    {
        const area = emitted('<div><textArea>Hello { v }</textArea></div>');
        expect(area).toContain('tmpl(\'<div><textArea></textArea></div>\')');
        expect(area).toContain('bindText(_n1, \'Hello \', () => ( v() ));');
        expect(emitted('<div><tiTle>{ v } - Site</tiTle></div>')).toContain('bindText(_n1, () => ( v() ), \' - Site\');');
        expect(emitted('<div><noScript><b>x</b></noScript></div>')).toContain('tmpl(\'<div><noScript></noScript></div>\')');
    });

    it('adds the LF the parser drops after <textarea> to baked static text', () =>
    {
        expect(emitted('<textarea>hi</textarea>')).toContain('tmpl(\'<textarea>hi</textarea>\')');
        const lead = emitted('<textarea>&#10;hi</textarea>');
        expect(lead).toContain('tmpl(\'<textarea>\\n\\nhi</textarea>\')');
        expect(lead).toContain('h(\'textarea\', {  }, \'\\nhi\')');
        expect(emitted('<textarea>{ \'\\nfoo\' }</textarea>')).toContain('tmpl(\'<textarea>\\n\\nfoo</textarea>\')');
        expect(emitted('<div><title>&#10;hi</title></div>')).toContain('tmpl(\'<div><title>\\nhi</title></div>\')');
    });

    it('lowers a static value with no spread before it to the default text, in the template and the h() tree', () =>
    {
        const plain = emitted('<textarea value="hi"></textarea>');
        expect(plain).toContain('tmpl(\'<textarea>hi</textarea>\')');
        expect(plain).toContain('h(\'textarea\', {  }, \'hi\')');

        const before = emitted('<textarea value="hi" {...rest}></textarea>');
        expect(before).toContain('tmpl(\'<textarea>hi</textarea>\')');
        expect(before).toContain('h(\'textarea\', { ...rest }, \'hi\')');
        expect(before).toContain('bindProps(_n0, { ...rest });');

        expect(emitted('<div><Show when={ on }><textarea value="hi"></textarea></Show></div>')).toContain('h(\'textarea\', {  }, \'hi\')');
    });

    it('writes a CR in baked textarea and title text as a reference, padding a leading one', () =>
    {
        expect(emitted('<textarea>a&#13;b</textarea>')).toContain('tmpl(\'<textarea>a&#13;b</textarea>\')');
        expect(emitted('<div><title>a&#13;b</title></div>')).toContain('tmpl(\'<div><title>a&#13;b</title></div>\')');
        const lead = emitted('<textarea>&#13;x</textarea>');
        expect(lead).toContain('tmpl(\'<textarea>\\n&#13;x</textarea>\')');
        expect(lead).toContain('h(\'textarea\', {  }, \'\\rx\')');
    });

    it('keeps a CR raw in every other element\'s template text (control)', () =>
    {
        expect(emitted('<pre>a&#13;b</pre>')).toContain('tmpl(\'<pre>a\\rb</pre>\')');
    });

    it('normalizes the line breaks of a static value as the parser does', () =>
    {
        const code = emitted('<textarea value="a\r\nb\rc"></textarea>');

        expect(code).toContain('tmpl(\'<textarea>a\\nb\\nc</textarea>\')');
        expect(code).toContain('h(\'textarea\', {  }, \'a\\nb\\nc\')');
    });

    it('keeps a constant value and a static value after a spread on the property path, never a template attribute', () =>
    {
        const constant = emitted('<textarea value={ \'hi\' }></textarea>');
        expect(constant).toContain('tmpl(\'<textarea></textarea>\')');
        expect(constant).toContain('setProp(_n0, \'value\', \'hi\')');

        const after = emitted('<textarea {...rest} value="hi"></textarea>');
        expect(after).toContain('tmpl(\'<textarea></textarea>\')');
        expect(after).toContain('bindProps(_n0, { ...rest, value: \'hi\' });');

        expect(emitted('<input value="hi" />')).toContain('tmpl(\'<input value="hi">\')');
    });

    it('leaves noscript content out of the clone and builds it in the h() tree only to serialize or hydrate', () =>
    {
        const code = emitted('<div><noscript>Hello { v } <b>x</b></noscript><i>{ v }</i></div>');

        expect(code).toContain('tmpl(\'<div><noscript></noscript><i></i></div>\')');
        expect(code).toContain('bindContent(_n8, () => ( v() ));');
        expect(code.match(/bind(Content|Hole|Text)\(/g)).toHaveLength(1);
        expect(code).toContain('h(\'noscript\', {  }, ...(isStringMode() || isHydrating() ? [\'Hello \', () => ( v() ), \' \', h(\'b\', {  }, \'x\')] : []))');
        expect(emitted('<div><Show when={ on }><noscript><img src="/p.gif" /></noscript></Show></div>'))
            .toContain('h(\'noscript\', {  }, ...(isStringMode() || isHydrating() ? [h(\'img\', { src: \'/p.gif\' })] : []))');
    });

    it('keeps the anchor scheme in every other element (control)', () =>
    {
        const code = emitted('<p>Hello { v }</p>');

        expect(code).toContain('tmpl(\'<p>Hello <!--[--><!--]--></p>\')');
        expect(code).toContain('bindHole(_n2, () => ( v() ));');
    });
});

describe('content with no text meaning is refused where it is written', () =>
{
    it('refuses an element, a component, control flow or a fragment inside textarea and title, in any case', () =>
    {
        expect(findings('<textarea><b>x</b></textarea>')).toEqual([{ code: 'azeroth/text-only-content', text: '<b>x</b>' }]);
        expect(findings('<textarea>Hello <Show when={ on }>a</Show></textarea>')).toEqual([{ code: 'azeroth/text-only-content', text: '<Show when={ on }>a</Show>' }]);
        expect(findings('<div><title><>a</></title></div>')).toEqual([{ code: 'azeroth/text-only-content', text: '<>a</>' }]);
        expect(findings('<div><svg><title><g></g></title></svg></div>')).toEqual([{ code: 'azeroth/text-only-content', text: '<g></g>' }]);
        expect(findings('<textArea><b>x</b></textArea>')).toEqual([{ code: 'azeroth/text-only-content', text: '<b>x</b>' }]);
        expect(findings('<div><tiTle><Wrap /></tiTle></div>')).toEqual([{ code: 'azeroth/text-only-content', text: '<Wrap />' }]);
    });

    it('names the refused child in the message, an element by its tag and a fragment as <>', () =>
    {
        const messages = (markup: string): string[] => diagnoseModule(component(markup))
            .filter(d => d.code === 'azeroth/text-only-content')
            .map(d => d.message);

        expect(messages('<textarea><b>x</b></textarea>')).toEqual([
            '<textarea> holds text only - the browser never renders <b> inside it as an element. Write text and { holes } here, or move <b> outside the <textarea>.'
        ]);
        expect(messages('<div><svg><title><g></g></title></svg></div>')[0]).toContain('never renders <g> inside it as an element');
        expect(messages('<div><title><>a</></title></div>')[0]).toContain('never renders <> inside it as an element');
    });

    it('accepts text and holes in any mix (control)', () =>
    {
        expect(findings('<div><textarea>a { v } b { w }</textarea><title>{ v } - { w }</title></div>')).toEqual([]);
    });

    it('refuses value or bind:value beside children, textContent or innerHTML on a textarea, in any case', () =>
    {
        expect(findings('<textarea value={ v }>child</textarea>')).toEqual([{ code: 'azeroth/content-property-children', text: 'value={ v }' }]);
        expect(findings('<textarea bind:value={ v }>{ w }</textarea>')).toEqual([{ code: 'azeroth/content-property-children', text: 'bind:value={ v }' }]);
        expect(findings('<textarea value={ v } textContent={ w }></textarea>')).toEqual([{ code: 'azeroth/content-property-children', text: 'value={ v }' }]);
        expect(findings('<textarea innerHTML={ w } bind:value={ v }></textarea>')).toEqual([{ code: 'azeroth/content-property-children', text: 'bind:value={ v }' }]);
        expect(findings('<textArea value="a">child</textArea>')).toEqual([{ code: 'azeroth/content-property-children', text: 'value="a"' }]);
        expect(findings('<textarea bind:value={ v }></textarea>')).toEqual([]);
    });

    it('refuses value on a title, in any case', () =>
    {
        expect(findings('<div><title value={ v }>x</title></div>')).toEqual([{ code: 'azeroth/title-value', text: 'value={ v }' }]);
        expect(findings('<div><tiTle bind:value={ v }>x</tiTle></div>')).toEqual([{ code: 'azeroth/title-value', text: 'bind:value={ v }' }]);
    });

    it('refuses a hole or markup in the elements the parser reads as raw text, but not in noscript', () =>
    {
        expect(findings('<div><iframe>{ v } x</iframe></div>')).toEqual([{ code: 'azeroth/raw-text-content', text: '{ v }' }]);
        expect(findings('<div><xmp><b>x</b></xmp></div>')).toEqual([{ code: 'azeroth/raw-text-content', text: '<b>x</b>' }]);
        expect(findings('<div><xMp>{ v }</xMp></div>')).toEqual([{ code: 'azeroth/raw-text-content', text: '{ v }' }]);
        expect(findings('<div><noembed><i>a</i></noembed><noframes>{ w }</noframes></div>').map(f => f.code))
            .toEqual(['azeroth/raw-text-content', 'azeroth/raw-text-content']);
        expect(findings('<div><iframe>no frames</iframe></div>')).toEqual([]);
        expect(findings('<div><noscript><p>Hello { v }</p></noscript></div>')).toEqual([]);
    });

    it('counts a child that is only whitespace as content beside textContent, innerHTML and value', () =>
    {
        expect(findings('<div textContent={ v }> </div>')).toEqual([{ code: 'azeroth/content-property-children', text: 'textContent={ v }' }]);
        expect(findings('<div innerHTML={ v }>&nbsp;</div>')).toEqual([{ code: 'azeroth/content-property-children', text: 'innerHTML={ v }' }]);
        expect(findings('<textarea value={ v }>&#9;</textarea>')).toEqual([{ code: 'azeroth/content-property-children', text: 'value={ v }' }]);
        expect(findings('<div textContent={ v }>&#10;</div>')).toEqual([{ code: 'azeroth/content-property-children', text: 'textContent={ v }' }]);
    });

    it('accepts a child that is only a line break, which the markup drops (control)', () =>
    {
        expect(findings('<div textContent={ v }>\n</div>')).toEqual([]);
        expect(findings('<textarea value={ v }>\n    </textarea>')).toEqual([]);
    });

    it('refuses the same shapes in embedded and module-scope markup', () =>
    {
        expect(findings('const row = <textarea><b>x</b></textarea>; <div>{ row }</div>').map(f => f.code)).toEqual(['azeroth/text-only-content']);
        expect(findings('const field = <textarea value={ v }> </textarea>; <div>{ field }</div>').map(f => f.code)).toEqual(['azeroth/content-property-children']);
        const source = 'const piece = () => <title><i>x</i></title>;\nexport default component C() { <div>{ piece() }</div> }';
        expect(diagnoseModule(source).map(d => d.code)).toEqual(['azeroth/text-only-content']);
    });
});

describe('a mixed-case host tag compiles like its lowercase twin', () =>
{
    const refusals = (markup: string): string[][] =>
    {
        const source = component(markup);
        return diagnoseModule(source)
            .filter(d => d.severity === 'error')
            .map(d => [d.code, source.slice(d.start, d.end), d.message]);
    };
    const refusedTwin = (markup: string, tag: string): void =>
    {
        expect(refusals(markup), markup).toEqual(refusals(markup.replaceAll(tag, tag.toLowerCase())));
    };
    const twin = (markup: string, tag: string): void =>
    {
        expect(emitted(markup).replaceAll(tag, tag.toLowerCase()), markup).toBe(emitted(markup.replaceAll(tag, tag.toLowerCase())));
        refusedTwin(markup, tag);
    };

    it('reads <sTyle> content as raw text, as <style>', () =>
    {
        twin('<div><sTyle>p {{ color: red }}</sTyle></div>', 'sTyle');
    });

    it('emits and refuses textArea, tiTle, noScript and xMp as their lowercase twins (control)', () =>
    {
        twin('<div><textArea>Hello { v }</textArea></div>', 'textArea');
        twin('<div><tiTle>{ v } - Site</tiTle></div>', 'tiTle');
        twin('<div><noScript>Hello { v }</noScript><i>{ v }</i></div>', 'noScript');
        twin('<textArea>&#10;hi</textArea>', 'textArea');
        twin('<textArea value="hi"></textArea>', 'textArea');
        refusedTwin('<textArea value={ v }>child</textArea>', 'textArea');
        refusedTwin('<div><xMp>{ v }</xMp></div>', 'xMp');
        refusedTwin('<textArea><b>x</b></textArea>', 'textArea');
        refusedTwin('<div><tiTle><>a</></tiTle></div>', 'tiTle');
    });

    it('keeps a capitalized <Style> a component (control)', () =>
    {
        expect(emitted('<div><Style>x</Style></div>')).toContain('Style({ get children() { return (() => \'x\'); } })');
    });
});
