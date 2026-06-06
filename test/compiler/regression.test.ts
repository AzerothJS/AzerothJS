import { describe, it, expect } from 'vitest';
import { compile } from '@azerothjs/compiler';

/** Compiles and returns just the code (including the auto h-import). */
function body(src: string): string
{
    return compile(src).code;
}

// BUG 2 - a component tag with no attributes and no children must compile to a
// zero-argument call `Comp()`, not `Comp({  })`. The empty-object form forces
// every prop-less component to declare a props parameter, and otherwise the
// language service reports "Expected 0 arguments, but got 1".
describe('compile() - attribute-less component call (Bug 2)', () =>
{
    it('emits Comp() for a self-closing component with no attributes', () =>
    {
        expect(body('const x = () => <Comp />;')).toContain('Comp()');
        expect(body('const x = () => <Comp />;')).not.toContain('Comp({');
    });

    it('emits Comp() for an empty open/close component with no attributes', () =>
    {
        expect(body('const x = () => <Comp></Comp>;')).toContain('Comp()');
        expect(body('const x = () => <Comp></Comp>;')).not.toContain('Comp({');
    });

    it('still passes a props object when the component has attributes', () =>
    {
        expect(body('const x = () => <Comp a="1" />;')).toContain('Comp({ a: \'1\' })');
    });

    it('still passes a props object (children) when the component wraps content', () =>
    {
        expect(body('const x = () => <Comp>hi</Comp>;')).toContain('Comp({ children:');
    });

    it('does not affect host elements (still h(\'div\', {  }))', () =>
    {
        expect(body('const x = () => <div />;')).toContain('h(\'div\', {  })');
    });
});

// BUG 3 - a generic arrow function in expression position must NOT be parsed as
// markup. `<T extends X>(a: T): T => a` and `<T,>(x) => x` previously threw.
describe('compile() - generic arrow functions are not markup (Bug 3)', () =>
{
    const unchanged = (src: string): void =>
    {
        const result = compile(src);
        expect(result.code).toBe(src);
        expect(result.map).toBeNull();
    };

    it('leaves a constrained generic arrow byte-for-byte', () =>
    {
        unchanged('const f = <T extends X>(a: T): T => a;');
    });

    it('leaves a trailing-comma generic arrow byte-for-byte', () =>
    {
        unchanged('const f = <T,>(x) => x;');
    });

    it('leaves a multi-parameter generic arrow byte-for-byte', () =>
    {
        unchanged('const f = <T, U>(a: T, b: U): T => a;');
    });

    it('leaves a default-type generic arrow byte-for-byte', () =>
    {
        unchanged('const f = <T = string>(x: T): T => x;');
    });

    it('leaves a nested-generic constraint byte-for-byte', () =>
    {
        unchanged('const f = <T extends Array<number>>(x: T): T => x;');
    });

    it('still compiles markup inside a generic arrow body', () =>
    {
        const out = body('const f = <T,>(x: T) => <div>{x}</div>;');
        expect(out).toContain('const f = <T,>(x: T) => h(\'div\', {  }, x);');
    });

    it('keeps treating return/assignment markup as markup', () =>
    {
        expect(body('const a = <div/>;')).toContain('h(\'div\', {  })');
        expect(body('const f = () => <span>hi</span>;')).toContain('h(\'span\', {  }, \'hi\')');
    });

    it('keeps type annotations and comparisons byte-for-byte (no markup)', () =>
    {
        unchanged('const x: Array<number> = [];');
        unchanged('const b = a < c && d > e;');
        unchanged('function g<T>(x: T): T { return x; }');
    });
});

// BUG 3 (cont.) - clear diagnostics for two authoring mistakes.
describe('compile() - clear diagnostics for markup mistakes (Bug 3)', () =>
{
    it('reports a literal < in text-child position with a helpful message', () =>
    {
        expect(() => compile('const x = <p>a < b</p>;')).toThrow(/literal '<'|\{'<'\}/);
    });

    it('reports a // line comment among markup children with a helpful message', () =>
    {
        expect(() => compile('const x = <div>{a}\n// note\n{b}</div>;')).toThrow(/line comment|\{\/\*/i);
    });
});
