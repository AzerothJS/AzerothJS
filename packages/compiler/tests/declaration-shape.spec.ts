// @vitest-environment node
//
// The declaration SHAPE rules: `[]` is form-only (azeroth/array-suffix), and a
// declaration whose slice parse fails or recovers an artifact initializer is rejected
// (azeroth/malformed-declaration) instead of silently emitting `undefined`. Both rules
// run over top-level declarations AND nested spans (effect bodies, opaque statements,
// initializer arrows). The malformed-declaration trigger is keyed on the SLICE PARSE
// OUTCOME, never a token scan: `=>` in a type annotation and markup-bearing values must
// stay silent. Residual recovery artifacts that survive the deliberately narrow
// initializer-present branch are pinned below as a documented record.
import { describe, expect, it, vi } from 'vitest';
import { diagnoseModule } from '../src/diagnostics.ts';
import { generateModule } from '../src/codegen.ts';
import { azeroth } from '../src/vite.ts';

const component = (body: string, read = 'rows()'): string =>
    `export default component Probe()\n{\n    ${ body }\n    <div>{ ${ read } }</div>\n}\n`;

const codes = (source: string): string[] => diagnoseModule(source).map((d) => d.code);

describe('azeroth/array-suffix: the [] suffix is form-only', () =>
{
    it('rejects [] on state, store and derived with a located error on the brackets', () =>
    {
        for (const [body, read] of [
            ['state rows[] = { a: 1 };', 'rows()'],
            ['store rows[] = { a: 1 };', 'rows.data()'],
            ['derived rows[] = 1 + 1;', 'rows()']
        ] as const)
        {
            const source = component(body, read);
            const findings = diagnoseModule(source);
            expect(findings.map((d) => d.code)).toEqual(['azeroth/array-suffix']);
            const suffix = findings[0]!;
            expect(source.slice(suffix.start, suffix.end)).toBe('[]');
        }
    });

    it('suppresses the misleading constant-derived hint on the flagged declaration', () =>
    {
        expect(codes(component('derived rows[] = 1 + 1;'))).not.toContain('azeroth/constant-derived');
    });

    it('suppresses the inert-effect hint on an effect whose body carries the flagged declaration', () =>
    {
        const source = component('effect { const c = 1 + 2; state y @@ = 1; }', 'x');
        expect(codes(source)).toEqual(['azeroth/malformed-declaration']);
        // The control: the same effect without the broken declaration still earns the hint.
        expect(codes(component('effect { const c = 1 + 2; }', 'x'))).toEqual(['azeroth/inert-effect']);
    });

    it('leaves the legal array-form untouched', () =>
    {
        expect(codes(component('form login[] = { email: 0 };', 'login.rows()'))).toEqual([]);
    });
});

describe('azeroth/malformed-declaration: the slice-outcome class guard', () =>
{
    it('rejects every probed recovery shape exactly once, spanning the declaration', () =>
    {
        for (const body of [
            'state rows @@ = { a: 1 };',
            'state rows = ;',
            'state rows { a: 1 };',
            'state rows = = { a: 1 };'
        ])
        {
            const source = component(body);
            const findings = diagnoseModule(source);
            expect(findings.map((d) => d.code)).toEqual(['azeroth/malformed-declaration']);
            expect(source.slice(findings[0]!.start, findings[0]!.end)).toContain('rows');
        }
    });

    it('stays silent on every legal shape, markup-bearing values and arrow types included', () =>
    {
        for (const [body, read] of [
            ['state x;', 'x()'],
            ['state cb: (e: Event) => void;', 'cb()'],
            ['state rows! = { a: 1 };', 'rows()'],
            ['state rows: number[] = [1];', 'rows()'],
            ['state f = () => (<li/>);', 'f()'],
            ['state t = `a=b`;', 't()'],
            ['state pick = 1 > 2 ? (<b>y</b>) : (<i>n</i>);', 'pick()']
        ] as const)
        {
            expect(codes(component(body, read))).toEqual([]);
        }
    });

    it('pins the documented residual: an initializer-present recovery artifact stays silent HERE (a default build still fails downstream)', () =>
    {
        expect(codes(component('state x = 1 2;', 'x()'))).toEqual([]);
    });
});

describe('nested declarations are walked, not skipped', () =>
{
    it('reaches a MARKUP-FREE effect body - the span the embedded scan cannot see', () =>
    {
        expect(codes(component('effect { state rows[] = [1]; console.log(rows); }', 'x'))).toEqual(['azeroth/array-suffix']);
    });

    it('reaches a declaration inside another declaration\'s initializer arrow', () =>
    {
        expect(codes(component('state make = () => { state y[] = []; };', 'make()'))).toEqual(['azeroth/array-suffix']);
    });

    it('reaches an opaque statement run\'s arrow body', () =>
    {
        expect(codes(component('const f = () => { state y[] = []; };', 'f()'))).toEqual(['azeroth/array-suffix']);
    });
});

describe('the rules gate every surface', () =>
{
    it('generateModule throws the named finding', () =>
    {
        expect(() => generateModule(component('state rows[] = [1];'), 'probe.azeroth'))
            .toThrow(/azeroth\/array-suffix/);
    });

    it('the dev server surfaces the NAMED finding, not the mapped projection hiccup', async () =>
    {
        const plugin = azeroth();
        (plugin.configResolved as (r: { command?: string }) => void)({ command: 'serve' });
        const transform = plugin.transform as unknown as (this: unknown, code: string, id: string) => Promise<unknown>;
        const ctx =
        {
            warn: vi.fn(),
            error: (message: unknown): never =>
            {
                throw new Error(typeof message === 'string' ? message : String(message));
            }
        };
        await expect(transform.call(ctx, component('state rows[] = [1];'), '/X.azeroth'))
            .rejects.toThrow(/azeroth\/array-suffix/);
    });
});
