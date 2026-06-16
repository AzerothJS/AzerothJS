// The built-in component table feeds attribute completion and hover, so its
// `props` must match the REAL renderer/component prop interfaces - right names,
// right required-ness, with a non-empty doc each. These assertions pin the data
// to that contract (e.g. Show.when is a documented required prop, For.each is
// required) so an accidental edit that drifts from the source types is caught.

import { describe, it, expect } from 'vitest';
import { BUILTIN_COMPONENT_MAP, BUILTIN_COMPONENTS } from '../../packages/language-service/src/language-data.ts';

function propsOf(name: string)
{
    const entry = BUILTIN_COMPONENT_MAP.get(name);
    if (!entry)
    {
        throw new Error(`missing built-in component: ${ name }`);
    }
    return entry.props;
}

function prop(component: string, name: string)
{
    return propsOf(component).find(candidate => candidate.name === name);
}

describe('BUILTIN_COMPONENT_MAP prop metadata', () =>
{
    it('every prop carries a non-empty one-line doc and a boolean required flag', () =>
    {
        for (const component of BUILTIN_COMPONENTS)
        {
            for (const candidate of component.props)
            {
                expect(candidate.doc.length, `${ component.name }.${ candidate.name } doc`).toBeGreaterThan(0);
                expect(typeof candidate.required, `${ component.name }.${ candidate.name } required`).toBe('boolean');
            }
        }
    });

    it('Show lists a documented required `when` and an optional `fallback`', () =>
    {
        const when = prop('Show', 'when');
        const fallback = prop('Show', 'fallback');

        expect(when?.required).toBe(true);
        expect(when?.doc.length).toBeGreaterThan(0);
        expect(fallback).toBeDefined();
        expect(fallback?.required).toBe(false);
        expect(prop('Show', 'children')?.required).toBe(true);
    });

    it('For lists a required `each` and `key`, and no `fallback` (the real type has none)', () =>
    {
        expect(prop('For', 'each')?.required).toBe(true);
        expect(prop('For', 'key')?.required).toBe(true);
        expect(prop('For', 'children')?.required).toBe(true);
        expect(prop('For', 'fallback')).toBeUndefined();
    });

    it('Switch lists a required `children` and an optional `fallback`', () =>
    {
        expect(prop('Switch', 'children')?.required).toBe(true);
        expect(prop('Switch', 'fallback')?.required).toBe(false);
    });

    it('Match lists a required `when` and `children`', () =>
    {
        expect(prop('Match', 'when')?.required).toBe(true);
        expect(prop('Match', 'children')?.required).toBe(true);
    });

    it('Portal lists an optional `target` and a required `children`', () =>
    {
        expect(prop('Portal', 'target')?.required).toBe(false);
        expect(prop('Portal', 'children')?.required).toBe(true);
    });

    it('Dynamic lists a required `component` and an optional `props`, with no `children`', () =>
    {
        expect(prop('Dynamic', 'component')?.required).toBe(true);
        expect(prop('Dynamic', 'props')?.required).toBe(false);
        expect(prop('Dynamic', 'children')).toBeUndefined();
    });

    it('Suspense lists required `fallback`, `on`, and `children`', () =>
    {
        expect(prop('Suspense', 'fallback')?.required).toBe(true);
        expect(prop('Suspense', 'on')?.required).toBe(true);
        expect(prop('Suspense', 'children')?.required).toBe(true);
    });

    it('Transition lists required `when`/`children` and optional `name`/`duration`', () =>
    {
        expect(prop('Transition', 'when')?.required).toBe(true);
        expect(prop('Transition', 'children')?.required).toBe(true);
        expect(prop('Transition', 'name')?.required).toBe(false);
        expect(prop('Transition', 'duration')?.required).toBe(false);
    });

    it('ErrorBoundary lists a required `fallback` and `children`', () =>
    {
        expect(prop('ErrorBoundary', 'fallback')?.required).toBe(true);
        expect(prop('ErrorBoundary', 'children')?.required).toBe(true);
    });

    it('Outlet lists only an optional `children`', () =>
    {
        expect(propsOf('Outlet').map(candidate => candidate.name)).toEqual(['children']);
        expect(prop('Outlet', 'children')?.required).toBe(false);
    });
});
