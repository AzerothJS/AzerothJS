// @vitest-environment node
//
// `resolveThunks` bounds its unwrap at MAX_THUNK_DEPTH specifically to survive "a pathological
// getter that returns a function forever" (see its module header). At the bound it returns the
// value STILL AS A FUNCTION - and `serializeChild` then called itself on that value, landing back
// in the same `typeof child === 'function'` branch, which resolved to a function again. The cap
// was real; its caller undid it. A self-returning thunk child was unbounded mutual recursion.
//
// The child-array branch had no bound of its own either, so an array containing itself recursed
// until the stack went.
//
// Both are reachable from data, and both come out of the render entry point as an uncaught
// RangeError - a request-killer, not a render error. React returns an empty element for the same
// input. Rendering nothing is also the only safe output here: a function's SOURCE TEXT must never
// reach the document, which is the entire reason resolve-thunks exists.
import { describe, expect, it } from 'vitest';

import { h, renderToStaticMarkup, type Child } from '../../src/index.ts';

describe('a render cannot be driven into unbounded recursion', () =>
{
    it('survives a thunk that always returns another thunk', () =>
    {
        const forever = function self(): unknown
        {
            return self;
        };

        expect(renderToStaticMarkup(() => h('div', {}, forever))).toBe('<div></div>');
    });

    it('never leaks a function body into the document', () =>
    {
        const forever = function secretName(): unknown
        {
            return secretName;
        };

        const html = renderToStaticMarkup(() => h('div', {}, forever));

        expect(html).not.toContain('secretName');
        expect(html).not.toContain('function');
        expect(html).not.toContain('=>');
    });

    it('survives a child array that contains itself', () =>
    {
        const cycle: Child[] = ['a'];
        cycle.push(cycle);

        expect(() => renderToStaticMarkup(() => h('div', {}, cycle))).not.toThrow();
    });

    it('survives mutually recursive child arrays', () =>
    {
        const left: Child[] = [];
        const right: Child[] = [left];
        left.push(right);

        expect(() => renderToStaticMarkup(() => h('div', {}, left))).not.toThrow();
    });

    it('still resolves the ordinary chains this exists to serve', () =>
    {
        expect(renderToStaticMarkup(() => h('div', {}, () => 'once'))).toBe('<div>once</div>');
        expect(renderToStaticMarkup(() => h('div', {}, () => () => 'twice'))).toBe('<div>twice</div>');
        expect(renderToStaticMarkup(() => h('div', {}, ['a', ['b', ['c']]]))).toBe('<div>abc</div>');
    });
});
