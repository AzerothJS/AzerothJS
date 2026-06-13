// The `dom` compile target: host-element regions hoist their static
// structure as one tmpl() and bind only the dynamic parts per clone;
// component/fragment regions fall back to h(); the default target is
// untouched by any of this.

import { describe, it, expect } from 'vitest';
import { compile } from '@azerothjs/compiler';

describe('compile target: dom', () =>
{
    it('hoists a fully static region behind the render-mode guard', () =>
    {
        const { code } = compile(
            'const x = <h1 class="title">Static heading</h1>;',
            'static.azeroth',
            { target: 'dom' }
        );

        expect(code).toContain("import { h, tmpl, isStringMode, isHydrating } from '@azerothjs/core';");
        expect(code).toContain("const _tmpl$1 = tmpl('<h1 class=\"title\">Static heading</h1>');");
        // Both forms, mode-selected: the universal h() branch serves SSR and
        // hydration, the clone branch serves fresh client creation.
        expect(code).toContain("const x = (isStringMode() || isHydrating() ? h('h1', { class: 'title' }, 'Static heading') : _tmpl$1());");
        expect(code).not.toContain('bindHole');
    });

    it('binds holes and dynamic props on a cloned template', () =>
    {
        const { code } = compile(
            'const x = <button class={cls()} onClick={inc}>Count: {count()}</button>;',
            'counter.azeroth',
            { target: 'dom' }
        );

        // Static structure with a comment marker for the hole.
        expect(code).toContain("tmpl('<button>Count: <!--$--></button>')");
        // The dynamic class and the event handler route through bindProps.
        expect(code).toContain('bindProps(_r, { class: () => (cls()), onClick: inc });');
        // The hole binds to the marker: firstChild is the text, the marker
        // is its next sibling.
        expect(code).toContain('const _e$1 = _r.firstChild.nextSibling;');
        expect(code).toContain('bindHole(_e$1, () => (count()));');
        // The universal branch sits beside the clone, selected at runtime.
        expect(code).toContain('isStringMode() || isHydrating() ?');
        expect(code).toContain("h('button', { class: () => (cls()), onClick: inc }, 'Count: ', () => (count()))");
        // Imports exactly what was emitted.
        expect(code).toContain("import { h, tmpl, bindHole, bindProps, isStringMode, isHydrating } from '@azerothjs/core';");
    });

    it('keeps nested static elements in the template and walks paths to dynamic ones', () =>
    {
        const { code } = compile(
            'const x = <div><span>a</span><p>{val()}</p></div>;',
            'nested.azeroth',
            { target: 'dom' }
        );

        // A sole-child hole gets the marker-free append path: the <p> stays
        // empty in the template and bindChild fills it.
        expect(code).toContain("tmpl('<div><span>a</span><p></p></div>')");
        expect(code).toContain('const _e$1 = _r.firstChild.nextSibling;');
        expect(code).toContain('bindChild(_e$1, () => (val()));');
        expect(code).not.toContain('bindHole');
    });

    it('uses the marker path only for holes with siblings', () =>
    {
        const { code } = compile(
            'const x = <p>before {val()} after</p>;',
            'mixed-children.azeroth',
            { target: 'dom' }
        );

        expect(code).toContain("tmpl('<p>before <!--$--> after</p>')");
        expect(code).toContain('bindHole(');
        expect(code).not.toContain('bindChild(');
    });

    it('falls back to h() for regions containing components', () =>
    {
        const { code } = compile(
            'const x = <div><Show when={a}><p>hi</p></Show></div>;',
            'mixed.azeroth',
            { target: 'dom' }
        );

        expect(code).not.toContain('tmpl(');
        expect(code).toContain("h('div'");
        expect(code).toContain('Show({');
    });

    it('falls back to h() for fragments', () =>
    {
        const { code } = compile(
            'const x = <><p>a</p><p>b</p></>;',
            'frag.azeroth',
            { target: 'dom' }
        );

        expect(code).not.toContain('tmpl(');
        expect(code).toContain("h('p'");
    });

    it('deduplicates identical templates within a module', () =>
    {
        const { code } = compile(
            'const a = <li class="row">x</li>;\nconst b = <li class="row">x</li>;',
            'dedupe.azeroth',
            { target: 'dom' }
        );

        expect(code.match(/= tmpl\(/g)).toHaveLength(1);
        expect(code.match(/_tmpl\$1\(\)/g)).toHaveLength(2);
    });

    it('escapes text and attribute values in the template HTML', () =>
    {
        const { code } = compile(
            'const x = <p data-note=\'say "hi" 1 < 2\'>a & b {val()}</p>;',
            'escape.azeroth',
            { target: 'dom' }
        );

        // The static attribute's quotes are entity-escaped; the text's
        // ampersand is too.
        expect(code).toContain('say &quot;hi&quot;');
        expect(code).toContain('a &amp; b');
    });

    it('routes static DOM-property attributes through bindProps', () =>
    {
        const { code } = compile(
            'const x = <input value="initial" type="text" />;',
            'props.azeroth',
            { target: 'dom' }
        );

        // `type` is a plain attribute (template HTML); `value` must be set
        // as a DOM property to match h()'s semantics.
        expect(code).toContain('type="text"');
        expect(code).toContain("bindProps(_r, { value: 'initial' });");
    });

    it('emits void elements without end tags', () =>
    {
        const { code } = compile(
            'const x = <div><input type="text" /><br /></div>;',
            'void.azeroth',
            { target: 'dom' }
        );

        expect(code).toContain('<input type="text"><br>');
        expect(code).not.toContain('</input>');
        expect(code).not.toContain('</br>');
    });

    it('default target is unchanged: h() output, no templates', () =>
    {
        const { code } = compile(
            'const x = <h1 class="title">Static heading</h1>;',
            'universal.azeroth'
        );

        expect(code).toContain("import { h } from '@azerothjs/core';");
        expect(code).toContain("h('h1', { class: 'title' }, 'Static heading')");
        expect(code).not.toContain('tmpl(');
    });
});
