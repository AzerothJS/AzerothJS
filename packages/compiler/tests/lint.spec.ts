// @vitest-environment node
//
// Real-execution coverage for the markup lint (style rules only: interpolation
// spacing, Show-narrowing) over both a parsed region (lintMarkup) and a whole
// module (lintSource). Duplicate attributes and lowercase on* names are
// error-severity diagnoseModule rules (GRAMMAR 6.6), tested with the rest of
// the semantic diagnostics, not here.
import { describe, it, expect } from 'vitest';
import { lintMarkup, lintSource, parseMarkup } from '@azerothjs/compiler';
import type { LintWarning } from '@azerothjs/compiler';

function lint(src: string): LintWarning[]
{
    // These cases target the non-spacing rules (Show-narrowing); spacing is
    // exercised by its own `spacing()` helper below, so disable it here.
    const { node } = parseMarkup(src, 0);
    return lintMarkup(node, src, { interpolationSpacing: 'off' });
}

describe('lintMarkup - superseded rules stay retired', () =>
{
    it('duplicate attributes and lowercase on* names produce NO lint finding (they are compile errors)', () =>
    {
        expect(lint('<div id="a" id="b">x</div>')).toEqual([]);
        expect(lint('<button onclick={f}>go</button>')).toEqual([]);
    });
});

describe('lintMarkup - unsafe-narrow-in-show', () =>
{
    it('flags guard()!.x in a plain child when the Show guards the same call', () =>
    {
        const warnings = lint('<Show when={ config() }><p>{ config()!.name }</p></Show>');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.code).toBe('azeroth/unsafe-narrow-in-show');
        expect(warnings[0]!.message).toContain('config()!');
        // The fix-it must name the form the compiler ACCEPTS. It used to recommend the
        // render-callback child, which `azeroth/callback-children-removed` rejects as a hard
        // error - following the lint's own advice broke the build.
        expect(warnings[0]!.message).toContain('let={ value }');
        expect(warnings[0]!.message).not.toContain('(value) => ...');
    });

    it('flags a dotted guarded call reached through a nested attribute', () =>
    {
        const src = '<Show when={ connection.activeConfig() }>'
            + '<div><button disabled={ !ok(connection.activeConfig()!.id) }>x</button></div>'
            + '</Show>';
        const warnings = lint(src);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.code).toBe('azeroth/unsafe-narrow-in-show');
        expect(src.slice(warnings[0]!.start, warnings[0]!.end)).toBe('disabled={ !ok(connection.activeConfig()!.id) }');
    });

    it('resolves the guarded call out of a ternary when', () =>
    {
        const warnings = lint('<Show when={ done ? configs.lastReport() : null }><ImportReport r={ configs.lastReport()!.id } /></Show>');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.message).toContain('configs.lastReport()!');
    });

    it('does not flag the let= binding form - the value is already bound, not re-read', () =>
    {
        expect(lint('<Show when={ config() } let={ value }><p>{ value.name }</p></Show>')).toEqual([]);
    });

    it('STILL flags a removed callback child, so the two layers agree', () =>
    {
        // The callback form is a compile error now, so it must not silence this warning:
        // suppressing here would hide the real problem behind a shape that cannot build.
        const warnings = lint('<Show when={ config() }>{ (config) => <p>{ config()!.name }</p> }</Show>');
        expect(warnings.map((w) => w.code)).toContain('azeroth/unsafe-narrow-in-show');
    });

    it('does not flag optional chaining (no runtime crash, left to a future rule)', () =>
    {
        expect(lint('<Show when={ config() }><p>{ config()?.name }</p></Show>')).toEqual([]);
    });

    it('does not flag when the when has no guarded call', () =>
    {
        expect(lint('<Show when={ scanning }><p>{ scanning!.toString() }</p></Show>')).toEqual([]);
    });

    it('does not flag a bare (already type-checked) read with no assertion', () =>
    {
        expect(lint('<Show when={ config() }><p>{ config().name }</p></Show>')).toEqual([]);
    });

    it('stays fast on an adversarial when with no real call (regression: a regex-based '
        + 'extractor is polynomial on strings shaped like this)', () =>
    {
        const adversarial = '$.'.repeat(50000); // no '()' anywhere - nothing to guard
        const start = performance.now();
        const warnings = lint(`<Show when={ ${ adversarial } }><p>{ config()!.x }</p></Show>`);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(200);
        expect(warnings).toEqual([]);
    });

    it('finds multiple offending reads across the subtree', () =>
    {
        const warnings = lint('<Show when={ config() }><p>{ config()!.a }</p><p>{ config()!.b }</p></Show>');
        expect(warnings).toHaveLength(2);
    });
});

describe('lintSource - whole module', () =>
{
    it('aggregates findings across the module', () =>
    {
        const warnings = lintSource('const x = <button title={f}>go</button>;');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.code).toBe('azeroth/interpolation-spacing');
    });

    it('returns no warnings for clean source', () =>
    {
        expect(lintSource('const x = <button onClick={ f }>go</button>;')).toEqual([]);
    });

    it('lints nested elements within a region', () =>
    {
        const warnings = lintSource('x = <div><input value={f} /></div>;');
        expect(warnings.map(w => w.code)).toEqual(['azeroth/interpolation-spacing']);
    });

    it('stops at an unparseable region rather than spraying noise (warning-only design)', () =>
    {
        // The first region is clean; the second is malformed, so the scan stops there.
        const warnings = lintSource('x = <p title={f}>ok</p>; y = <a></b>;');
        expect(warnings.map(w => w.code)).toEqual(['azeroth/interpolation-spacing']);
    });
});

describe('lintMarkup - interpolation-spacing (needs the source text)', () =>
{
    function lintWith(src: string, options?: Parameters<typeof lintMarkup>[2]): LintWarning[]
    {
        const { node } = parseMarkup(src, 0);
        return lintMarkup(node, src, options);
    }
    const spacing = (src: string, options?: Parameters<typeof lintMarkup>[2]): LintWarning[] =>
        lintWith(src, options).filter(w => w.code === 'azeroth/interpolation-spacing');

    it('flags an unspaced child hole and fixes it to { expr }', () =>
    {
        const src = '<p>{count}</p>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(src.slice(warnings[0]!.start, warnings[0]!.end)).toBe('{count}');
        expect(warnings[0]!.fix).toEqual({ range: [4, 9], text: ' count ' });
    });

    it('flags an unspaced attribute expression', () =>
    {
        const src = '<div title={message}>x</div>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.fix!.text).toBe(' message ');
    });

    it('flags directive and event expressions too (class:, onClick)', () =>
    {
        const src = '<button class:on={ok} onClick={()=>go()}>x</button>';
        expect(spacing(src)).toHaveLength(2);
    });

    it('collapses runs of spaces to exactly one', () =>
    {
        const src = '<p>{  wide  }</p>';
        expect(spacing(src)[0]!.fix!.text).toBe(' wide ');
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
        expect(src.slice(warnings[0]!.start, warnings[0]!.end)).toBe('{a}');
    });

    it('fixes only the tight side of a mixed multiline hole, preserving the layout', () =>
    {
        const src = '<p>{\n    value}</p>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.fix!.text).toBe('\n    value ');
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
        expect(warnings[0]!.fix!.text).toBe(' { a: 1 } ');
    });

    it('preserves string content verbatim in the fix (braces inside strings)', () =>
    {
        const src = '<p>{fn("} x")}</p>';
        const warnings = spacing(src);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.fix!.text).toBe(' fn("} x") ');
    });

    it('never mode inverts the rule', () =>
    {
        expect(spacing('<p>{x}</p>', { interpolationSpacing: 'never' })).toEqual([]);
        const warnings = spacing('<p>{ x }</p>', { interpolationSpacing: 'never' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.fix).toEqual({ range: [4, 7], text: 'x' });
    });

    it('off mode disables the interpolation-spacing rule', () =>
    {
        expect(spacing('<p>{x}</p>', { interpolationSpacing: 'off' })).toEqual([]);
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

describe('markup-indent - the tag indentation ESLint cannot see', () =>
{
    const indent = (source: string, step = 4): LintWarning[] =>
        lintSource(source, { markupIndent: step }).filter((w) => w.code === 'azeroth/markup-indent');

    it('is off unless a step is given - it rewrites whitespace, so it opts in', () =>
    {
        const source = '<div>\n<span>a</span>\n</div>';
        expect(lintSource(source)).toEqual([]);
        expect(indent(source, 0)).toEqual([]);
    });

    it('measures a child against its parent, not against column zero', () =>
    {
        // The root sits at column 4, so its child belongs at 8 - exactly how a component's
        // markup sits inside a function body.
        expect(indent('    <div>\n        <span>a</span>\n    </div>')).toEqual([]);
        const [warning] = indent('    <div>\n    <span>a</span>\n    </div>');
        expect(warning?.message).toBe('Expected an indent of 8 spaces, found 4.');
    });

    it('counts every level of nesting', () =>
    {
        expect(indent('<a>\n    <b>\n        <c>x</c>\n    </b>\n</a>')).toEqual([]);
        expect(indent('<a>\n    <b>\n    <c>x</c>\n    </b>\n</a>')).toHaveLength(1);
    });

    it('leaves tags that share a line alone - that is an authoring choice', () =>
    {
        expect(indent('<div>\n    <b>a</b><i>b</i>\n</div>')).toEqual([]);
    });

    it('never looks inside an expression hole - its contents are TypeScript', () =>
    {
        const source = '<ul>\n    { rows.map((r) =>\n<li>{ r }</li>) }\n</ul>';
        expect(indent(source)).toEqual([]);
    });

    it('says nothing when the root shares its line with code', () =>
    {
        // No baseline to measure against, so the whole region is left alone.
        expect(indent('const view = <div>\n<span>a</span>\n</div>;')).toEqual([]);
    });

    it('honours a step other than four', () =>
    {
        expect(indent('<a>\n  <b>x</b>\n</a>', 2)).toEqual([]);
        expect(indent('<a>\n    <b>x</b>\n</a>', 2)).toHaveLength(1);
    });

    it('its fix lands on the leading whitespace and settles in one pass', () =>
    {
        const src = '<div>\n  <span>a</span>\n      <em>b</em>\n</div>';
        let out = src;
        for (const w of indent(src).sort((a, b) => b.fix!.range[0] - a.fix!.range[0]))
        {
            out = out.slice(0, w.fix!.range[0]) + w.fix!.text + out.slice(w.fix!.range[1]);
        }
        expect(out).toBe('<div>\n    <span>a</span>\n    <em>b</em>\n</div>');
        expect(indent(out)).toEqual([]);
    });
});
