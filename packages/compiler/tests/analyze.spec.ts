// @vitest-environment node
//
// Real-execution coverage for analyzeComponent: declared sources (state/derived),
// hasProps, and per-scope dependency sets (derived/effect/text/attribute) with
// shadowing soundness and conservative purity. Runs the real TypeScript-backed
// analysis - no mocks.
import { describe, it, expect } from 'vitest';
import { parseModule } from '@azerothjs/compiler';
import { analyzeComponent } from '../src/analyze.ts';
import type { ReactiveAnalysis, ReactiveScope } from '../src/analyze.ts';
import type { ComponentDecl } from '@azerothjs/compiler';

function analyze(src: string): ReactiveAnalysis
{
    const c = parseModule(src).items.find(i => i.kind === 'component') as ComponentDecl;
    return analyzeComponent(src, c);
}

function scope(a: ReactiveAnalysis, origin: ReactiveScope['origin']): ReactiveScope
{
    const s = a.scopes.find(x => x.origin === origin);
    expect(s, `expected a ${ origin } scope`).toBeDefined();
    return s as ReactiveScope;
}

describe('analyzeComponent - sources and hasProps', () =>
{
    it('records each state/derived source with its name span and kind', () =>
    {
        const src = 'component C { state n = 0; derived d = n + 1; <p>{d}</p> }';
        const a = analyze(src);
        expect(a.sources.map(s => ({ kind: s.kind, name: s.name }))).toEqual([
            { kind: 'state', name: 'n' },
            { kind: 'derived', name: 'd' }
        ]);
        expect(src.slice(a.sources[0].span.start, a.sources[0].span.end)).toBe('n');
    });

    it('sets hasProps when (and only when) the component declares a parameter', () =>
    {
        // Any parameter form means the component takes props.
        expect(analyze('component C(props: { x: number }) { <p>x</p> }').hasProps).toBe(true);
        expect(analyze('component C(props: CProps) { <p>x</p> }').hasProps).toBe(true);
        expect(analyze('component C({ x }: { x: number }) { <p>{x}</p> }').hasProps).toBe(true);
        // No parameter (bare or empty parens) means no props.
        expect(analyze('component C { state n = 0; <p>{n}</p> }').hasProps).toBe(false);
        expect(analyze('component C() { <p>x</p> }').hasProps).toBe(false);
    });

    it('maps destructured prop names to reactive aliases (props.<name>, with ?? defaults)', () =>
    {
        const a = analyze('component C({ title, size = "sm" }: P) { <p class={size}>{title}</p> }');
        expect(a.propAliases?.get('title')).toBe('props.title');
        expect(a.propAliases?.get('size')).toBe('(props.size ?? "sm")');
    });
});

describe('analyzeComponent - dependency sets', () =>
{
    it('a derived depends on the source it reads', () =>
    {
        const a = analyze('component C { state n = 0; derived d = n * 2; <p>{d}</p> }');
        const derived = scope(a, 'derived');
        expect(derived.name).toBe('d');
        expect(derived.deps).toEqual([{ kind: 'source', name: 'n' }]);
    });

    it('a constant derived has no dependencies and is pure', () =>
    {
        const a = analyze('component C { derived d = 1 + 2; <p>{d}</p> }');
        const derived = scope(a, 'derived');
        expect(derived.deps).toEqual([]);
        expect(derived.pure).toBe(true);
    });

    it('an effect collects both source and props dependencies, in first-seen order', () =>
    {
        const a = analyze('component C(props: { x: number }) { state n = 0; effect { console.log(props.x, n); } <p>{n}</p> }');
        const effect = scope(a, 'effect');
        expect(effect.deps).toEqual([
            { kind: 'prop', field: 'x' },
            { kind: 'source', name: 'n' }
        ]);
        // A call (console.log) makes the scope impure.
        expect(effect.pure).toBe(false);
    });

    it('a text binding scope carries the read of its hole expression', () =>
    {
        const a = analyze('component C { state n = 0; <p>{n}</p> }');
        const text = scope(a, 'text');
        expect(text.deps).toEqual([{ kind: 'source', name: 'n' }]);
    });

    it('an attribute binding scope carries the read of its value expression', () =>
    {
        const a = analyze('component C { state cls = "a"; <div class={cls}>x</div> }');
        const attr = scope(a, 'attribute');
        expect(attr.deps).toEqual([{ kind: 'source', name: 'cls' }]);
    });

    it('dedupes a source read repeated within one scope', () =>
    {
        const a = analyze('component C { state n = 0; derived d = n + n + n; <p>{d}</p> }');
        expect(scope(a, 'derived').deps).toEqual([{ kind: 'source', name: 'n' }]);
    });
});

describe('analyzeComponent - shadowing soundness', () =>
{
    it('a lambda parameter shadowing a state is NOT a dependency', () =>
    {
        const a = analyze('component C { state n = 0; derived d = ((n) => n + 1)(5); <p>{d}</p> }');
        expect(scope(a, 'derived').deps).toEqual([]);
    });

    it('a local const shadowing a state suppresses the source dep', () =>
    {
        const a = analyze('component C { state n = 0; effect { const n = 5; console.log(n); } <p>x</p> }');
        const effect = scope(a, 'effect');
        expect(effect.deps.some(d => d.kind === 'source' && d.name === 'n')).toBe(false);
    });

    it('markup embedded in a hole keeps lambda scope sound (For-row param shadows nothing real)', () =>
    {
        // items.map(i => <li>{i.name}</li>) - `i` is a param, `items` is the read.
        const a = analyze('component C { state items = []; <ul>{items.map(i => <li>{i.name}</li>)}</ul> }');
        const text = scope(a, 'text');
        expect(text.deps).toEqual([{ kind: 'source', name: 'items' }]);
    });

    it('a bare props read is recorded as the whole-bag dependency (*)', () =>
    {
        const a = analyze('component C(props: { x: number }) { derived d = JSON.stringify(props); <p>{d}</p> }');
        expect(scope(a, 'derived').deps).toContainEqual({ kind: 'prop', field: '*' });
    });
});
