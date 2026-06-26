// @vitest-environment node
//
// Real-execution coverage for the built-in component tag table: the array and
// its Set form agree, membership is O(1), and the well-known control-flow tags
// are present while user/host tags are not.
import { describe, it, expect } from 'vitest';
import { BUILTIN_COMPONENTS, BUILTIN_SET } from '../src/builtins.ts';

describe('builtins', () =>
{
    it('lists the known control-flow / built-in component tags', () =>
    {
        for (const tag of ['Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic', 'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'])
        {
            expect(BUILTIN_COMPONENTS).toContain(tag);
        }
    });

    it('the Set form has exactly the same members as the array', () =>
    {
        expect(BUILTIN_SET.size).toBe(BUILTIN_COMPONENTS.length);
        for (const tag of BUILTIN_COMPONENTS)
        {
            expect(BUILTIN_SET.has(tag)).toBe(true);
        }
    });

    it('does not classify user or host tags as built-in', () =>
    {
        expect(BUILTIN_SET.has('Counter')).toBe(false);
        expect(BUILTIN_SET.has('div')).toBe(false);
        expect(BUILTIN_SET.has('show')).toBe(false);
    });

    it('has no duplicate entries', () =>
    {
        expect(new Set(BUILTIN_COMPONENTS).size).toBe(BUILTIN_COMPONENTS.length);
    });
});
