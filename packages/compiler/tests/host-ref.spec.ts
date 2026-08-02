// @vitest-environment node
//
// A host `ref` hands the element back at creation, and its type follows the language's own
// facts: the VALUE rule is the handler convention (callback or createRef box; null/undefined/
// false mean "no ref"), and the ELEMENT type follows the tag AND its markup namespace, the
// same rule the HTML parser applies (svg subtree -> SVG namespace, back to HTML inside
// <foreignObject>; unknown or custom tags produce HTMLElement, never bare Element). A bare
// `ref` or a string-valued `ref` can never receive an element and is refused at compile time
// (azeroth/ref-value) - before that rule, the clone path stamped a literal ref attribute into
// the document while SSR dropped it, a mode divergence.
import { describe, it, expect } from 'vitest';

import { generateVirtualCode } from '../src/project.ts';
import { typeCheckModuleTS } from '../src/typecheck-ts.ts';
import { diagnoseModule } from '../src/diagnostics.ts';

const code = (source: string): string => generateVirtualCode(source).code;

describe('host ref typing - element from tag and namespace', () =>
{
    it('satisfies-checks the callback against the tag', () =>
    {
        expect(code('component C { <input ref={(element) => element.focus()} /> }'))
            .toContain("satisfies AzerothRef<'input'>");
        expect(code('component C { <input ref={(element) => element.focus()} /> }'))
            .toContain('type AzerothRef<');
    });

    it('declares the helper only where a host ref is used', () =>
    {
        expect(code('component C { <input value="x" /> }')).not.toContain('type AzerothRef<');
    });

    it('infers the element type with no annotation', () =>
    {
        expect(typeCheckModuleTS('component C { let box = ""; <input ref={(element) => box = element.value} /> }'))
            .toEqual([]);
    });

    it('rejects an annotation that contradicts the tag', () =>
    {
        const errors = typeCheckModuleTS('component C { <input ref={(element: HTMLCanvasElement) => element.getContext("2d")} /> }');
        expect(errors.length).toBeGreaterThan(0);
    });

    it('an SVG-subtree element types through the SVG map, not the HTML one', () =>
    {
        // `a` exists in BOTH tag maps; inside <svg> the parser builds an SVGAElement, whose
        // href is a readonly SVGAnimatedString. Typing it as HTMLAnchorElement certified
        // `e.href = "x"`, which throws at mount.
        expect(code('component C { <svg><a ref={(e) => e}>t</a></svg> }'))
            .toContain("satisfies AzerothRef<'a', 'svg'>");
        expect(typeCheckModuleTS('component C { <svg><a ref={(e: SVGAElement) => e}>t</a></svg> }'))
            .toEqual([]);
        expect(typeCheckModuleTS('component C { <svg><a ref={(e: HTMLAnchorElement) => e}>t</a></svg> }').length)
            .toBeGreaterThan(0);
    });

    it('resolves an SVG tag through the SVG map', () =>
    {
        expect(typeCheckModuleTS('component C { let r = 0; <svg><circle ref={(element) => r = element.r.baseVal.value} /></svg> }'))
            .toEqual([]);
    });

    it('foreignObject children return to the HTML namespace', () =>
    {
        expect(typeCheckModuleTS('component C { <svg><foreignObject><div ref={(e: HTMLDivElement) => e}>t</div></foreignObject></svg> }'))
            .toEqual([]);
    });

    it('a MathML-subtree element types through the MathML map - the parser\'s other foreign branch', () =>
    {
        // The browser builds <math><mi> as a MathMLElement in the MathML namespace; typing it
        // as HTMLElement certified `e.click()`, which threw at mount in Chromium.
        expect(code('component C { <math><mi ref={(e) => e}>x</mi></math> }'))
            .toContain("satisfies AzerothRef<'mi', 'math'>");
        expect(typeCheckModuleTS('component C { <math><mi ref={(e: MathMLElement) => e}>x</mi></math> }'))
            .toEqual([]);
        expect(typeCheckModuleTS('component C { <math><mi ref={(e: HTMLElement) => e}>x</mi></math> }').length)
            .toBeGreaterThan(0);
    });

    it('MathML text integration points re-enter HTML, exactly as the parser does', () =>
    {
        // mi/mo/mn/ms/mtext children are HTML per the tree-construction rules.
        expect(typeCheckModuleTS('component C { <math><mi><span ref={(e: HTMLSpanElement) => e}>x</span></mi></math> }'))
            .toEqual([]);
    });

    it('annotation-xml re-enters HTML only under a literal html encoding - the parser sees no other', () =>
    {
        // The encoding attribute decides integration-point-ness AT PARSE TIME; an expression
        // attribute does not exist in the template markup yet, so only a literal can switch.
        expect(typeCheckModuleTS('component C { <math><annotation-xml encoding="text/html"><span ref={(e: HTMLSpanElement) => e}>x</span></annotation-xml></math> }'))
            .toEqual([]);
        expect(typeCheckModuleTS('component C { <math><annotation-xml><thing ref={(e: MathMLElement) => e}>x</thing></annotation-xml></math> }'))
            .toEqual([]);
    });

    it('an unknown or custom-element tag produces HTMLElement, never bare Element', () =>
    {
        // createElement of ANY name yields an HTMLElement subclass (custom elements extend it,
        // unknown names give HTMLUnknownElement), so an HTMLElement annotation is CORRECT and
        // must compile. The old Element fallback refused it.
        expect(typeCheckModuleTS('component C { <my-widget ref={(e: HTMLElement) => e.style.color = "red"}>t</my-widget> }'))
            .toEqual([]);
    });

    it('host tag names are case-insensitive, as HTML defines them', () =>
    {
        expect(typeCheckModuleTS('component C { <dIv ref={(e: HTMLDivElement) => e.id = "x"}>t</dIv> }'))
            .toEqual([]);
    });

    it('leaves a component ref alone - the prop is typed by the component', () =>
    {
        expect(code('component C { <Card ref={(element) => element} /> }')).not.toContain('AzerothRef');
    });
});

describe('host ref typing - the value rule (the handler convention)', () =>
{
    it('null, undefined, and false mean "no ref", so conditional refs need no ternary', () =>
    {
        expect(typeCheckModuleTS('component C(props: { on: boolean }) { <div ref={ props.on && ((e) => e.id = "x") }>t</div> }'))
            .toEqual([]);
    });

    it('accepts a createRef box typed to the element', () =>
    {
        expect(typeCheckModuleTS('component C { const box = { current: null as HTMLInputElement | null }; <input ref={ box } /> }'))
            .toEqual([]);
    });

    it('rejects a box typed to a different element', () =>
    {
        expect(typeCheckModuleTS('component C { const box = { current: null as HTMLCanvasElement | null }; <input ref={ box } /> }').length)
            .toBeGreaterThan(0);
    });

    it('rejects a value that is neither callback, box, nor "no ref"', () =>
    {
        const errors = typeCheckModuleTS('component C { <div ref={ 5 }>t</div> }');
        expect(errors.length).toBeGreaterThan(0);
        // ... and reports it as a REF failure, not as an event handler.
        expect(errors[0]!.code).toBe('azeroth/ref-type');
        expect(errors[0]!.message).not.toContain('Event handler');
    });

    it('a non-function handler still reports as a handler failure', () =>
    {
        const errors = typeCheckModuleTS('component C { <button onClick={ 5 }>x</button> }');
        expect(errors[0]!.code).toBe('azeroth/handler-type');
    });
});

describe('host ref - statically evident dead values are refused', () =>
{
    it('a bare ref can never receive the element', () =>
    {
        const found = diagnoseModule('component C { <div ref>t</div> }');
        expect(found.map((d) => d.code)).toContain('azeroth/ref-value');
    });

    it('a string-valued ref can never receive the element', () =>
    {
        const found = diagnoseModule('component C { <div ref="x">t</div> }');
        expect(found.map((d) => d.code)).toContain('azeroth/ref-value');
    });

    it('an expression ref is not the diagnostic\'s business - the type layer owns it', () =>
    {
        expect(diagnoseModule('component C { <div ref={(e) => e.id = "y"}>t</div> }')).toEqual([]);
    });

    it('a component ref="x" stays an ordinary string prop', () =>
    {
        expect(diagnoseModule('component C { <Card ref="x" /> }')).toEqual([]);
    });
});
