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
        const warnings = lintSource('const x = <button onclick={f}>go</button>;');
        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('azeroth/event-case');
    });

    it('returns no warnings for clean source', () =>
    {
        expect(lintSource('const x = <button onClick={f}>go</button>;')).toEqual([]);
    });

    it('lints nested elements within a region', () =>
    {
        const warnings = lintSource('x = <div><input onchange={f} /></div>;');
        expect(warnings.map(w => w.code)).toEqual(['azeroth/event-case']);
    });

    it('stops at an unparseable region rather than spraying noise (warning-only design)', () =>
    {
        // The first region is clean; the second is malformed, so the scan stops there.
        const warnings = lintSource('x = <p onclick={f}>ok</p>; y = <a></b>;');
        expect(warnings.map(w => w.code)).toEqual(['azeroth/event-case']);
    });
});
