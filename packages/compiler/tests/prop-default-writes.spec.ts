// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderToString } from 'azerothjs';
import { diagnoseModule } from '@azerothjs/compiler';
import { generateModule } from '../src/codegen.ts';
import { compileComponent } from './conformance/executor.ts';

const diagnostic = 'azeroth/prop-default-write';
const modes = [{ ssr: false }, { ssr: true }, { dev: true }];

describe('writes inside a destructured prop default', () =>
{
    it.each([
        'item = 4',
        'item += 1',
        'item ??= 4',
        '++item',
        'item--',
        '((item as number)!) = 4',
        'delete item',
        '({ item } = {})',
        '({ item = 4 } = {})',
        '({ first: { next: item } } = source)',
        '([...item] = [])',
        '({ ...item } = {})',
        '(() => { for (item of [4]) {} })()',
        '(() => { for ([item] of [[4]]) {} })()',
        '(() => { for (item in {}) {} })()'
    ])('refuses a write to the local prop alias at its original source span (%s)', expression =>
    {
        const source = `const source = { first: { next: 4 } };
            component Probe({ first: item = 2, label = (${ expression }) }) { <p>{label}</p> }`;
        const errors = diagnoseModule(source).filter(issue => issue.severity === 'error');
        const start = source.indexOf(expression) + expression.indexOf('item');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ code: diagnostic, start, end: start + 4 });
        for (const options of modes)
        {
            expect(() => generateModule(source, 'probe.azeroth', options)).toThrow(diagnostic);
        }
    });

    it('points at the complete authored Unicode escape in an identifier', () =>
    {
        const name = String.raw`it\u0065m`;
        const source = `component Probe({ item, callback = () => ++${ name } }) { <p/> }`;
        const errors = diagnoseModule(source).filter(issue => issue.code === diagnostic);
        expect(errors).toHaveLength(1);
        expect(source.slice(errors[0]?.start, errors[0]?.end)).toBe(name);
    });

    it.each([
        ['local assignment', '((item) => ++item)(6)', 7],
        ['module assignment', 'outside = 8', 8],
        ['member write', 'item.value += 3', 7],
        ['indexed member write', 'item["value"]++', 4],
        ['ordinary target using a computed key', '(() => { ({ [item.value]: outside } = { 4: 6 }); return outside; })()', 6],
        ['ordinary target with a default on its right', '(() => { [outside = item.value] = []; return outside; })()', 4],
        ['shorthand with a read in its default', '(() => { ({ outside = item.value } = {}); return outside; })()', 4],
        ['a spread on the right of an assignment', '(outside = { ...item }).value', 4],
        ['a shadowing loop declaration', '(() => { for (const item of [9]) { return item; } })()', 9]
    ] as const)('executes %s', (_description, expression, expected) =>
    {
        const source = `let outside;
            component Probe({ first: item, label = (${ expression }) }) { <p>{label}</p> }`;
        expect(diagnoseModule(source).filter(issue => issue.severity === 'error')).toEqual([]);
        const Probe = compileComponent(source, 'Probe', { ssr: true });
        expect(renderToString(() => Probe({ first: { value: 4 } }) as HTMLElement)).toContain(`-->${ expected }<!--`);
    });
});
