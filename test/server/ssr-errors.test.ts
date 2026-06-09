// SSR production audit: an UNCAUGHT throw during render (a component without an
// enclosing ErrorBoundary) must propagate to the caller AND leave the shared
// render mode clean, so a single bad request cannot poison every later render on
// a long-lived server. (ErrorBoundary's catch path is covered in
// control-flow.test.ts; this is the no-boundary case.)

import { describe, it, expect } from 'vitest';
import { getRenderMode } from '@azerothjs/reactivity';
import { h } from '@azerothjs/renderer';
import { renderToString, renderToStaticMarkup } from '@azerothjs/server';

function Boom(): HTMLElement
{
    throw new Error('render failed');
}

describe('uncaught throw during SSR', () =>
{
    it('propagates the error to the caller', () =>
    {
        expect(() => renderToString(() => h('div', {}, Boom()))).toThrow('render failed');
    });

    it('restores render mode to dom after a throw, so later renders are unaffected', () =>
    {
        expect(getRenderMode()).toBe('dom');
        expect(() => renderToString(() => Boom())).toThrow();
        // The mode must not be stuck in 'string' for the next request.
        expect(getRenderMode()).toBe('dom');

        // A subsequent normal render still works and the live DOM path is intact.
        expect(renderToString(() => h('p', {}, 'ok'))).toBe('<p>ok</p>');
        expect(renderToStaticMarkup(() => h('span', {}, 'ok'))).toBe('<span>ok</span>');
        const el = h('b', {}, 'dom');
        expect(el.outerHTML).toBe('<b>dom</b>');
    });
});
