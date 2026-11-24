// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { diagnoseModule } from '@azerothjs/compiler';
import { renderToString } from 'azerothjs';
import { generateModule } from '../src/codegen.ts';
import { compileComponent } from './conformance/executor.ts';

const modes = [{ ssr: false }, { ssr: true }, { dev: true }];
const spacer = 'component Spacer { <i/> }';

describe('reactive reads in declaration and label positions', () =>
{
    it.each(modes)('executes labeled control flow with a namesake reactive value (%o)', options =>
    {
        const source = `state n = 3;
            function run() {
                let sum = 0;
                n: for (let i = 0; i < n; i++) {
                    if (i === 0) continue n;
                    sum += i;
                    if (i === n - 1) break n;
                }
                return sum;
            }`;
        expect(compileComponent(source, 'run', options)()).toBe(3);
    });

    it.each(modes)('evaluates class and object keys in the enclosing scope (%o)', options =>
    {
        const source = `state key = 'ticket';
            function run() {
                class Field { key = key; [key] = key + '!'; }
                class Method { [key](key) { return key; } }
                class Accessor { get [key]() { return key; } }
                const object = { [key](key) { return key; } };
                const field = new Field();
                return [field.key, field.ticket, new Method().ticket('row'), new Accessor().ticket, object.ticket('seat')];
            }`;
        expect(compileComponent(source, 'run', options)()).toEqual(['ticket', 'ticket!', 'row', 'ticket', 'seat']);
    });

    it('scopes a class expression name to the class, and a declaration to its enclosing block', () =>
    {
        const source = `state key = 'outer';
            function run() {
                const Inner = class key { static self() { return key; } };
                let declared;
                { class key { static self() { return key; } } declared = key === key.self(); }
                return [Inner === Inner.self(), declared, key];
            }`;
        expect(compileComponent(source, 'run')()).toEqual([true, true, 'outer']);
    });

    it('uses the row in a field initializer and preserves the literal field name', () =>
    {
        const source = `component Probe { <For each={['seat']} key={seat => seat} let={name}>
            <p>{(() => { class Ticket { name = name; } return new Ticket().name; })()}</p>
        </For> }`;
        const Probe = compileComponent(source, 'Probe');
        expect(renderToString(() => Probe() as HTMLElement)).toContain('seat');
    });

    it('keeps type names and enum member names while evaluating the value expressions', () =>
    {
        const source = `state key = 5;
            type key = number;
            interface Field<key> { key: key }
            class Box<key> { key = key; }
            enum Outer { value = key }
            enum Inner { key = 2, other = key + 1 }
            function run() { return [new Box().key, Outer.value, Inner.other, key]; }`;
        const emitted = generateModule(source).code;
        expect(emitted).toContain('type key = number;');
        expect(emitted).toContain('interface Field<key> { key: key }');
        expect(emitted).toContain('class Box<key> { key = key(); }');
        expect(compileComponent(source, 'run', {}, true)()).toEqual([5, 5, 3, 5]);
    });

    it('distinguishes an implements type from a reactive class base', () =>
    {
        const source = `state key = 3;
            state base = class { value = 2; };
            interface key { label: number }
            class Ticket extends base implements key { label = key; }
            function run() { const ticket = new Ticket(); return [ticket.value, ticket.label]; }`;
        expect(generateModule(source).code).toContain('extends base() implements key {');
        expect(compileComponent(source, 'run', {}, true)()).toEqual([2, 3]);
    });

    it('resolves declarations within each namespace body and restores the enclosing value', () =>
    {
        const source = `state key = 1;
            namespace Area {
                export function read() { return key; }
                export const key = 2;
            }
            namespace Queue {
                export function read() { return key; }
                if (true) { var key = 3; }
            }
            namespace Desk {
                export function read() { return key.seat; }
                export namespace key { export const seat = 4; }
            }
            function run() { return [Area.read(), Queue.read(), Desk.read(), key]; }`;
        expect(compileComponent(source, 'run', {}, true)()).toEqual([2, 3, 4, 1]);
    });

    it('resolves literal computed enum names in later members', () =>
    {
        const source = `state key = 1;
            enum Ticket { ["key"] = 2, other = key + 5 }
            enum Seat { [\`key\`] = 3, other = key + 5 }
            function run() { return [Ticket.other, Seat.other, key]; }`;
        expect(compileComponent(source, 'run', {}, true)()).toEqual([7, 8, 1]);
    });
});

describe('named exports of module-level reactive values', () =>
{
    it.each([
        'state n = 0; export { n };',
        'derived n = 2; export { n as total };',
        'deferred n = 3; export { n as "total seats" };',
        'export { n as total }; ' + spacer + ' state n = 0;',
        'state n = 0; ' + spacer + ' export { n };'
    ])('reports the local value name in the source diagnostic and every build mode (%s)', source =>
    {
        const diagnostics = diagnoseModule(source).filter(d => d.severity === 'error');
        expect(diagnostics).toHaveLength(1);
        const [issue] = diagnostics;
        expect(issue?.code).toBe('azeroth/reactive-export');
        expect(issue?.start).toBe(source.indexOf('{ n', source.indexOf('export {')) + 2);
        expect(source.slice(issue?.start, issue?.end)).toBe('n');
        for (const options of modes)
        {
            expect(() => generateModule(source, 'example.azeroth', options)).toThrow(/azeroth\/reactive-export/);
        }
    });

    it.each([
        'export { n as value } from "./away";',
        'export type { n };',
        'export { type n as T };',
        'export { other as n };',
        'export * as n from "./away";',
        'import { n as remote } from "./away";'
    ])('preserves type, remote and public names (%s)', clause =>
    {
        const source = 'state n = 3; const other = 5; ' + clause;
        expect(diagnoseModule(source).filter(d => d.severity === 'error')).toEqual([]);
        expect(generateModule(source).code).toContain(clause);
    });

    it('distinguishes nested reactive declarations and supports an explicit value reader', () =>
    {
        const ordinary = 'state total = 0; const n = 2; function child() { state n = 1; return n; } export { n };';
        expect(diagnoseModule(ordinary).filter(d => d.severity === 'error')).toEqual([]);
        expect(generateModule(ordinary).code).toContain('export { n };');
        const reader = 'state n = 3; export function read() { return n; }';
        expect(generateModule(reader).code).toContain('export function read() { return n(); }');
        expect(compileComponent(reader.replace('export function', 'function'), 'read')()).toBe(3);
    });

    it('leaves diagnostics for unrecognized keyword positions to the existing syntax checks', () =>
    {
        const source = 'const previous = 1\nstate n = 3; export { n };';
        expect(diagnoseModule(source).map(d => d.code)).not.toContain('azeroth/reactive-export');
    });
});
