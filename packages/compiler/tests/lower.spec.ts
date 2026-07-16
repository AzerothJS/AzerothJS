// @vitest-environment node
//
// Real-execution coverage for lowerComponent + lowerMarkup -> RenderPlan IR.
// Validates the static template tree (node kinds + ids), binding kinds/targets,
// dependency wiring (looked up by span from analysis), the slot-vs-hole
// distinction (components/control-flow vs reactive text), and the render-clone
// sub-plan path. Asserts STRUCTURE, not snapshots.
import { describe, it, expect } from 'vitest';
import { parseModule, parseMarkup } from '@azerothjs/compiler';
import { analyzeComponent } from '../src/analyze.ts';
import { lowerComponent, lowerMarkup } from '../src/lower.ts';
import type { ComponentDecl } from '@azerothjs/compiler';
import type {
    RenderPlan,
    TemplateElement,
    TextBinding,
    AttributeBinding,
    EventBinding,
    SpreadBinding,
    RefBinding,
    ComponentBinding,
    Binding
} from '../src/ir.ts';

function lower(src: string): RenderPlan
{
    const c = parseModule(src).items.find(i => i.kind === 'component') as ComponentDecl;
    const plan = lowerComponent(src, c, analyzeComponent(src, c));
    expect(plan, 'expected a non-null plan').not.toBeNull();
    return plan as RenderPlan;
}

function bindingsOf<K extends Binding['kind']>(plan: RenderPlan, kind: K): Extract<Binding, { kind: K }>[]
{
    return plan.bindings.filter((b): b is Extract<Binding, { kind: K }> => b.kind === kind);
}

describe('lowerComponent - template tree', () =>
{
    it('returns null for a component with no markup output', () =>
    {
        const c = parseModule('component C { state n = 0; }').items.find(i => i.kind === 'component') as ComponentDecl;
        expect(lowerComponent('component C { state n = 0; }', c, analyzeComponent('component C { state n = 0; }', c))).toBeNull();
    });

    it('builds an element root with static text and assigns sequential ids', () =>
    {
        const plan = lower('component C { <div><span>hi</span></div> }');
        const root = plan.template as TemplateElement;
        expect(root.kind).toBe('element');
        expect(root.tag).toBe('div');
        expect(root.id).toBe(0);
        const span = root.children[0] as TemplateElement;
        expect(span.kind).toBe('element');
        expect(span.tag).toBe('span');
        expect(span.children[0]).toMatchObject({ kind: 'text', value: 'hi' });
        expect(plan.bindings).toHaveLength(0);
    });

    it('lowers a fragment root to a fragment node', () =>
    {
        const plan = lower('component C { state n = 0; <><p>{n}</p></> }');
        expect(plan.template.kind).toBe('fragment');
    });

    it('bakes static and boolean attributes into the element, no binding', () =>
    {
        const plan = lower('component C { <a class="box" disabled>x</a> }');
        const root = plan.template as TemplateElement;
        expect(root.attrs).toEqual([
            { name: 'class', value: 'box' },
            { name: 'disabled', value: true }
        ]);
        expect(plan.bindings).toHaveLength(0);
    });
});

describe('lowerComponent - text holes and dep wiring', () =>
{
    it('a reactive text hole becomes a hole node + a text binding carrying its deps', () =>
    {
        const plan = lower('component C { state n = 0; <p>{n}</p> }');
        const root = plan.template as TemplateElement;
        const hole = root.children[0]!;
        expect(hole.kind).toBe('hole');

        const texts = bindingsOf(plan, 'text');
        expect(texts).toHaveLength(1);
        const binding = texts[0] as TextBinding;
        expect(binding.target).toBe(hole.id);
        expect(binding.expr.deps).toEqual([{ kind: 'source', name: 'n' }]);
        // The hole binding's span is the inner expression (without the braces).
        const src = 'component C { state n = 0; <p>{n}</p> }';
        expect(src.slice(binding.expr.span.start, binding.expr.span.end)).toBe('n');
    });

    it('a depless constant hole produces a binding with empty deps', () =>
    {
        const plan = lower('component C { <p>{1 + 2}</p> }');
        const binding = bindingsOf(plan, 'text')[0] as TextBinding;
        expect(binding.expr.deps).toEqual([]);
        expect(binding.expr.pure).toBe(true);
    });
});

describe('lowerComponent - element bindings', () =>
{
    it('a dynamic attribute becomes an attribute binding wired to its deps', () =>
    {
        const src = 'component C { state cls = "a"; <div class={cls}>x</div> }';
        const plan = lower(src);
        const attr = bindingsOf(plan, 'attribute')[0] as AttributeBinding;
        expect(attr.name).toBe('class');
        expect(attr.property).toBe(false);
        expect(attr.target).toBe((plan.template as TemplateElement).id);
        expect(attr.expr.deps).toEqual([{ kind: 'source', name: 'cls' }]);
    });

    it('a DOM-property attribute (value) is flagged property:true', () =>
    {
        const plan = lower('component C { state v = "x"; <input value={v} /> }');
        const attr = bindingsOf(plan, 'attribute')[0] as AttributeBinding;
        expect(attr.name).toBe('value');
        expect(attr.property).toBe(true);
    });

    it('an on* attribute becomes an event binding with the lower-cased event name', () =>
    {
        const plan = lower('component C { <button onClick={save}>x</button> }');
        const event = bindingsOf(plan, 'event')[0] as EventBinding;
        expect(event.event).toBe('click');
        const src = 'component C { <button onClick={save}>x</button> }';
        expect(src.slice(event.handler.start, event.handler.end)).toBe('save');
    });

    it('a {...spread} becomes a spread binding', () =>
    {
        const plan = lower('component C { state p = 0; <div {...p}>x</div> }');
        const spread = bindingsOf(plan, 'spread')[0] as SpreadBinding;
        expect(spread.target).toBe((plan.template as TemplateElement).id);
        const src = 'component C { state p = 0; <div {...p}>x</div> }';
        expect(src.slice(spread.expr.span.start, spread.expr.span.end)).toBe('p');
    });

    it('a ref attribute becomes a ref binding (not an attribute binding)', () =>
    {
        const plan = lower('component C { <div ref={el}>x</div> }');
        expect(bindingsOf(plan, 'ref')).toHaveLength(1);
        expect(bindingsOf(plan, 'attribute')).toHaveLength(0);
        const ref = bindingsOf(plan, 'ref')[0] as RefBinding;
        const src = 'component C { <div ref={el}>x</div> }';
        expect(src.slice(ref.ref.start, ref.ref.end)).toBe('el');
    });
});

describe('lowerComponent - components and control-flow use slots', () =>
{
    it('a user component fills a slot (not a hole) with a component binding', () =>
    {
        const plan = lower('component C { state n = 0; <div><Foo count={n} label="hi" /></div> }');
        const root = plan.template as TemplateElement;
        expect(root.children[0]?.kind).toBe('slot');

        const comps = bindingsOf(plan, 'component');
        expect(comps).toHaveLength(1);
        const comp = comps[0]!;
        expect(comp.tag).toBe('Foo');
        expect(comp.builtin).toBe(false);
        expect(comp.target).toBe(root.children[0]!.id);
        // A reactive prop (count) and a static prop (label).
        expect(comp.props).toContainEqual(expect.objectContaining({ kind: 'prop', name: 'count' }));
        expect(comp.props).toContainEqual({ kind: 'static', name: 'label', value: 'hi' });
    });

    it('a built-in control-flow tag is marked builtin and wires its when prop deps', () =>
    {
        const plan = lower('component C { state on = true; <div><Show when={on}><p>yes</p></Show></div> }');
        const comp = bindingsOf(plan, 'component')[0] as ComponentBinding;
        expect(comp.tag).toBe('Show');
        expect(comp.builtin).toBe(true);
        const whenProp = comp.props.find(p => p.kind === 'prop' && p.name === 'when');
        expect(whenProp).toMatchObject({ kind: 'prop', name: 'when' });
        expect((whenProp as { expr: { deps: unknown[] } }).expr.deps).toEqual([{ kind: 'source', name: 'on' }]);
    });

    it('component markup children form a self-contained nested plan with its own id space', () =>
    {
        const plan = lower('component C { <div><Show when={true}><p>yes</p></Show></div> }');
        const comp = bindingsOf(plan, 'component')[0] as ComponentBinding;
        expect(comp.children).not.toBeNull();
        expect(comp.children!.kind).toBe('markup');
        const nested = (comp.children as { kind: 'markup'; plan: RenderPlan }).plan;
        // Nested plan re-starts ids at 0 (its own id space).
        expect(nested.template.id).toBe(0);
    });

    it('an event prop on a component becomes an event prop entry', () =>
    {
        const plan = lower('component C { <Foo onSelect={pick} /> }');
        const comp = bindingsOf(plan, 'component')[0] as ComponentBinding;
        expect(comp.props).toContainEqual(expect.objectContaining({ kind: 'event', event: 'select' }));
    });
});

describe('lowerComponent - render-fn children (clone path)', () =>
{
    it('a render-fn child with a single host element lowers to a clonable render sub-plan with the param captured', () =>
    {
        const src = 'component C { state items = []; <For each={items}>{(item) => <li>{item.name}</li>}</For> }';
        const plan = lower(src);
        const comp = bindingsOf(plan, 'component')[0] as ComponentBinding;
        expect(comp.tag).toBe('For');
        expect(comp.children).not.toBeNull();
        expect(comp.children!.kind).toBe('render');
        const render = comp.children as { kind: 'render'; param: { start: number; end: number } | null; body: RenderPlan };
        expect(render.param).not.toBeNull();
        expect(src.slice(render.param!.start, render.param!.end)).toBe('(item)');
        // The body is a clonable sub-plan (has a template).
        expect('template' in render.body).toBe(true);
        // Every binding in a render-row sub-plan is forced reactive (per-row signals).
        for (const binding of render.body.bindings)
        {
            if ('expr' in binding)
            {
                expect('reactive' in binding.expr && binding.expr.reactive).toBe(true);
            }
        }
    });

    it('a {expr} child that is not a function literal becomes dynamic children', () =>
    {
        const plan = lower('component C { state kids = null; <Foo>{kids}</Foo> }');
        const comp = bindingsOf(plan, 'component')[0] as ComponentBinding;
        expect(comp.children!.kind).toBe('dynamic');
    });

    it('a component with no children lowers children to null', () =>
    {
        const plan = lower('component C { <Foo /> }');
        const comp = bindingsOf(plan, 'component')[0] as ComponentBinding;
        expect(comp.children).toBeNull();
    });
});

describe('lowerMarkup - embedded markup (no analysis)', () =>
{
    it('lowers an embedded element with EMPTY dependency sets', () =>
    {
        const code = '<li>{i.name}</li>';
        const { node } = parseMarkup(code, 0);
        const plan = lowerMarkup(code, node);
        const root = plan.template as TemplateElement;
        expect(root.tag).toBe('li');
        const binding = plan.bindings[0] as TextBinding;
        expect(binding.kind).toBe('text');
        // No component scope -> empty deps (reactivity decided by codegen heuristic).
        expect(binding.expr.deps).toEqual([]);
        expect(code.slice(binding.expr.span.start, binding.expr.span.end)).toBe('i.name');
    });
});
