// @vitest-environment node
//
// Real-execution coverage for the markup lint: duplicate-attr and event-case,
// over both a parsed region (lintMarkup) and a whole module (lintSource). Verifies
// the rules' near-zero false-positive design (unknown on* names, components,
// unparseable regions).
import { describe, it, expect } from 'vitest';
import { lintMarkup, lintSource } from '@azerothjs/compiler';
import { parseMarkup } from '@azerothjs/compiler';
import type { MarkupElement, MarkupFragment, LintWarning } from '@azerothjs/compiler';

function lint(src: string): LintWarning[]
{
    const { node } = parseMarkup(src, 0);
    return lintMarkup(node as MarkupElement | MarkupFragment);
}

describe('lintMarkup - duplicate-attr', () =>
{
    it('flags the same attribute written twice on one element', () =>
    {
        const warnings = lint('<div id="a" id="b">x</div>');
        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('azeroth/duplicate-attr');
        expect(warnings[0].message).toContain('Duplicate attribute `id`');
    });

    it('does not flag distinct attributes', () =>
    {
        expect(lint('<div id="a" class="b">x</div>')).toEqual([]);
    });

    it('carries the source span of the offending (later) attribute', () =>
    {
        const src = '<div id="a" id="b">x</div>';
        const warning = lint(src)[0];
        expect(src.slice(warning.start, warning.end)).toBe('id="b"');
    });
});

describe('lintMarkup - event-case', () =>
{
    it('flags a lowercase known event handler on a host element', () =>
    {
        const warnings = lint('<button onclick={f}>go</button>');
        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('azeroth/event-case');
        expect(warnings[0].message).toContain('onClick');
    });

    it('does not flag the camelCase form', () =>
    {
        expect(lint('<button onClick={f}>go</button>')).toEqual([]);
    });

    it('does not flag an attribute that merely starts with "on" but is not a known event', () =>
    {
        // `online` is not a known DOM event, so it is left alone.
        expect(lint('<a online="yes">x</a>')).toEqual([]);
    });

    it('does not flag a lowercase event-looking prop on a component', () =>
    {
        // The rule only fires for host elements; components get their own contract.
        expect(lint('<Widget onclick={f} />')).toEqual([]);
    });
});

describe('lintSource - whole module', () =>
{
    it('aggregates findings across the module', () =>
    {
        const warnings = lintSource('const x = <button onclick={ f }>go</button>;');
        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('azeroth/event-case');
    });

    it('returns no warnings for clean source', () =>
    {
        expect(lintSource('const x = <button onClick={ f }>go</button>;')).toEqual([]);
    });

    it('lints nested elements within a region', () =>
    {
        const warnings = lintSource('x = <div><input onchange={ f } /></div>;');
        expect(warnings.map(w => w.code)).toEqual(['azeroth/event-case']);
    });

    it('stops at an unparseable region rather than spraying noise (warning-only design)', () =>
    {
        // The first region is clean; the second is malformed, so the scan stops there.
        const warnings = lintSource('x = <p onclick={ f }>ok</p>; y = <a></b>;');
        expect(warnings.map(w => w.code)).toEqual(['azeroth/event-case']);
    });
});

describe('lintMarkup - interpolation-spacing (needs the source text)', () =>
{
    function lintWith(src: string, options?: Parameters<typeof lintMarkup>[2]): LintWarning[]
    {
        const { node } = parseMarkup(src, 0);
        return lintMarkup(node as MarkupElement | MarkupFragment, src, options);
    }
    const spacing = (src: string, options?: Parameters<typeof lintMarkup>[2]): LintWarning[] =>
        lintWith(src, options).filter(w => w.code === 'azeroth/interpolation-spacing');

    it('flags an unspaced child hole and fixes it to { expr }', () =>
    {
        const src = '<p>{count}</p>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(src.slice(warnings[0].start, warnings[0].end)).toBe('{count}');
        expect(warnings[0].fix).toEqual({ range: [4, 9], text: ' count ' });
    });

    it('flags an unspaced attribute expression', () =>
    {
        const src = '<div title={message}>x</div>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].fix!.text).toBe(' message ');
    });

    it('flags directive and event expressions too (class:, onClick)', () =>
    {
        const src = '<button class:on={ok} onClick={()=>go()}>x</button>';
        expect(spacing(src)).toHaveLength(2);
    });

    it('collapses runs of spaces to exactly one', () =>
    {
        const src = '<p>{  wide  }</p>';
        expect(spacing(src)[0].fix!.text).toBe(' wide ');
    });

    it('accepts the canonical form on both positions', () =>
    {
        expect(spacing('<div title={ m }>{ count }</div>')).toEqual([]);
    });

    it('accepts a multiline side (newline counts as spacing) but still flags a tight same-line hole', () =>
    {
        const src = '<div title={\n    long()\n}>{a}</div>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(src.slice(warnings[0].start, warnings[0].end)).toBe('{a}');
    });

    it('fixes only the tight side of a mixed multiline hole, preserving the layout', () =>
    {
        const src = '<p>{\n    value}</p>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].fix!.text).toBe('\n    value ');
    });

    it('exempts spreads in attribute and child position', () =>
    {
        expect(spacing('<div {...props}>{...list}</div>')).toEqual([]);
    });

    it('ignores static and bare attributes', () =>
    {
        expect(spacing('<input type="text" disabled />')).toEqual([]);
    });

    it('handles nested object braces: outer padding is what counts', () =>
    {
        expect(spacing('<C opts={ { a: 1 } } />')).toEqual([]);
        const warnings = spacing('<C opts={{ a: 1 }} />');
        expect(warnings).toHaveLength(1);
        expect(warnings[0].fix!.text).toBe(' { a: 1 } ');
    });

    it('preserves string content verbatim in the fix (braces inside strings)', () =>
    {
        const src = '<p>{fn("} x")}</p>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].fix!.text).toBe(' fn("} x") ');
    });

    it('never mode inverts the rule', () =>
    {
        expect(spacing('<p>{x}</p>', { interpolationSpacing: 'never' })).toEqual([]);
        const warnings = spacing('<p>{ x }</p>', { interpolationSpacing: 'never' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0].fix).toEqual({ range: [4, 7], text: 'x' });
    });

    it('off mode and the source-less legacy call disable the rule', () =>
    {
        expect(spacing('<p>{x}</p>', { interpolationSpacing: 'off' })).toEqual([]);
        const { node } = parseMarkup('<p>{x}</p>', 0);
        expect(lintMarkup(node as MarkupElement)).toEqual([]);
    });

    it('lintSource threads the source and options through', () =>
    {
        const module = 'const view = <p>{x}</p>;';
        expect(lintSource(module).some(w => w.code === 'azeroth/interpolation-spacing')).toBe(true);
        expect(lintSource(module, { interpolationSpacing: 'off' })).toEqual([]);
    });

    it('applying every fix yields a clean, idempotent result', () =>
    {
        const src = '<div title={m} class:on={  b  }>{count} { ok }</div>';
        let out = src;
        for (const w of spacing(src).sort((a, b) => b.fix!.range[0] - a.fix!.range[0]))
        {
            out = out.slice(0, w.fix!.range[0]) + w.fix!.text + out.slice(w.fix!.range[1]);
        }
        expect(out).toBe('<div title={ m } class:on={ b }>{ count } { ok }</div>');
        expect(spacing(out)).toEqual([]);
    });
});
