// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { diagnoseModule } from '../src/diagnostics.ts';
import { generateModule } from '../src/codegen.ts';
import { generateVirtualCode } from '../src/project.ts';

const component = (body: string): string => `export default component Inventory() {\n${ body }\n<p>Received</p>\n}`;
const errors = (source: string) => diagnoseModule(source).filter(finding => finding.severity === 'error');
const malformed = 'azeroth/malformed-declaration';

describe('reactive declarations consume one complete binding', () =>
{
    it.each(['state', 'derived', 'deferred', 'store', 'resource', 'stream', 'selector', 'form'])(
        'names the second binding in a %s declaration', kind =>
        {
            const source = component(`${ kind } open, spare = 2;`);
            const [error] = errors(source);
            expect(error?.code).toBe(malformed);
            expect(error?.message).toContain('spare');
            expect(source.slice(error!.start, error!.end)).toContain(',');
        }
    );

    it.each([
        ['state open /* retained */\n/* dropped */ mark();', 'mark'],
        ['state open /* \u{1F4E6} */\r\nmark();', 'mark'],
        ['state open: number\nmark();', 'mark'],
        ['state open mark();', 'mark'],
        ['state open: number != 2;', '!='],
        ['state open ? mark() : later();', 'later'],
        ['state open,;', ','],
        ['state open = 1\nmark();', 'mark'],
        ['state open = 1, spare = 2;', 'spare'],
        ['state open = (<b/>), spare = 2;', 'spare'],
        ['state open = (() => { state local = 1; return local; })(), spare = 2;', 'spare'],
        ['state open with { name: "open" } mark();', 'mark'],
        ['form rows[] with {} with {};', 'with'],
        ['function setup() { state open\nmark(); }', 'mark'],
        ['effect { state open\nmark(); }', 'mark']
    ])('locates and explains the unconsumed source in %s', (body, token) =>
    {
        const source = component(body);
        const findings = errors(source);
        expect(findings.map(finding => finding.code)).toEqual([malformed]);
        const [finding] = findings;
        expect(finding!.message).toContain(token);
        expect(source.slice(finding!.start, finding!.end)).toContain(token);
    });

    it.each(['state open with OPTIONS;', 'effect with OPTIONS { mark(); }', 'effect (open) with OPTIONS { mark(); }'])(
        'checks a markup handler inside %s', outer =>
        {
            for (const [declaration, code, snippet] of [
                ['state item[] = true;', 'azeroth/array-suffix', '[]'],
                ['state item\nmark();', malformed, 'mark']
            ] as const)
            {
                const handler = `{ name: (<button onClick={() => { ${ declaration } }}>Save</button>) }`;
                const source = component(outer.replace('OPTIONS', handler));
                const findings = errors(source);
                expect(findings.map(finding => finding.code)).toEqual([code]);
                expect(source.slice(findings[0]!.start, findings[0]!.end)).toContain(snippet);
            }
        }
    );

    describe.each(['as', 'satisfies'])('operator name %s', name =>
    {
        it.each([
            ['', '! = 1'], ['', ','], ['', ' + 1'], ['', ' == 1'],
            ['', '\nmark()'], ['', '!\nmark()'], ['', '\n!ready && mark()'],
            ['', ' ?Ready'], ['', ' *'], ['', '\n[0, mark()]'], ['', '\n{ hello: mark() }'],
            ['\n', ', later: number = (mark(), 1)'], ['\n', '\n[ , mark()]']
        ])('locates the tail with prefix %j and suffix %j', (prefix, tail) =>
        {
            const body = `state${ prefix || ' ' }${ name }${ tail };`;
            const source = component(body);
            const findings = errors(source);
            expect(findings.map(finding => finding.code), body).toEqual([malformed]);
            expect(findings[0]!.message, body).toContain(name);
            expect(source.slice(findings[0]!.start, findings[0]!.end)).toBe(tail.trim());
        });
    });

    it('ends each operator diagnostic before the next malformed statement while typing', () =>
    {
        const source = component(Array.from({ length: 24 }, (_, i) => `state as + ${ i }`).join('\n') + ';');
        const ranges = errors(source).map(d => source.slice(d.start, d.end));
        expect(ranges).toEqual(Array.from({ length: 24 }, (_, i) => `+ ${ i }`));
    });

    it('consumes a complete arrow containing a typed framework declaration and markup', () =>
    {
        const arrow = '() => { state k: (number extends number ? number : never)\n=\n2; return (<b>{k}</b>); }';
        const good = component(`state render = ${ arrow } with {};`);
        expect(errors(good)).toEqual([]);
        for (const ssr of [false, true])
        {
            const result = generateModule(good, 'Inventory.azeroth', { ssr });
            expect(result.code).toContain('createSignal<(number extends number ? number : never)>(2)');
        }
        for (const tail of [', spare = 2', '\nmark()'])
        {
            const bad = component(`state render = ${ arrow }${ tail };`);
            const findings = errors(bad);
            expect(findings.map(d => d.code)).toEqual([malformed]);
            expect(bad.slice(findings[0]!.start, findings[0]!.end)).toBe(tail.trim());
        }
    });

    it.each([
        'state open; mark();', 'state open = 1; mark();', 'state open!: number; mark();',
        'form rows[ /* list */ ] /* trivia */ ;', 'state open = (mark(), 2);',
        'state row: Map<string, number> = new Map<string, number>();',
        'state row = build<string, number>(1, 2);', 'state open: () => number;',
        'state row = (() => { state item = 1; return (<b>{item}</b>); })();',
        'const state = 1; type ready = number; state as\nready && mark();',
        'state as\nready && mark();', 'const state = 1; state as -1;',
        'state as [first: string, ...rest: number[]];', 'state as { mark(): number };',
        'state as { [Symbol.iterator](): Iterator<number> };',
        'state as Row ? mark() : later();',
        'const state = 1; state as number && (() => { batch { mark(); } })();',
        'const state = 1; state as number && (() => (<b title="x"/>))();',
        'const state = 1; state as number\nbatch { mark(); }',
        'const state = 1; state as number\nconst work = () => { state nested = 1; };',
        'let state = 1; let as = 2; state\nas! = 5;', 'state as [];',
        'interface Slots { state\nas, later: number; }', 'interface Slots { state\nopen, later: number; }',
        'class Slots { state\nas!: number; }'
    ])('preserves the legal reading of %s', body =>
    {
        expect(errors(component(body))).toEqual([]);
    });

    it('blocks client and server output while keeping the editor projection available for repair', () =>
    {
        const bad = component('state open\nmark();');
        for (const ssr of [false, true])
        {
            expect(() => generateModule(bad, 'Inventory.azeroth', { ssr })).toThrow(/azeroth\/malformed-declaration.*mark/s);
            expect(generateModule(component('state open; mark();'), 'Inventory.azeroth', { ssr }).code).toContain('mark()');
        }
        expect(generateVirtualCode(bad).code).toContain('mark');
    });

    it('preserves split interface members while lowering a split declaration in the next function', () =>
    {
        const members = 'interface Slots { state\nopen, later: number; }';
        const source = component(members + '\nfunction read() { state\nopen = 7; return open; }');
        expect(errors(source)).toEqual([]);
        expect(generateVirtualCode(source).code).toContain(members);
        for (const ssr of [false, true])
        {
            const code = generateModule(source, 'Inventory.azeroth', { ssr }).code;
            expect(code).toMatch(/interface Slots\s*\{\s*state\s+open,\s*later: number;\s*\}/);
            expect(code).toContain('createSignal(7)');
        }
    });
});
