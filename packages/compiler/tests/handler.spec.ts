// @vitest-environment node
//
// The executable spec of the event-handler boundary: isSetupHandler is the conservative,
// type-free subset of "an on* handler must be a function" that the compiler enforces. It
// returns true ONLY for expressions provably recognizable as a setup-time side effect, and
// false (deferred to the type system) for everything else. Internal module - imported by
// relative path.
import { describe, it, expect } from 'vitest';
import { isSetupHandler } from '../src/handler.ts';

describe('isSetupHandler - rejected (provably a setup-time effect)', () =>
{
    it('flags assignments (any assignment operator)', () =>
    {
        expect(isSetupHandler('count = 1')).toBe(true);
        expect(isSetupHandler('x += y')).toBe(true);
        expect(isSetupHandler('flag ||= true')).toBe(true);
    });

    it('flags increment / decrement (prefix and postfix)', () =>
    {
        expect(isSetupHandler('count++')).toBe(true);
        expect(isSetupHandler('count--')).toBe(true);
        expect(isSetupHandler('++count')).toBe(true);
        expect(isSetupHandler('--count')).toBe(true);
    });

    it('flags a zero-argument call of a plain identifier or member path', () =>
    {
        expect(isSetupHandler('save()')).toBe(true);
        expect(isSetupHandler('actions.reset()')).toBe(true);
        expect(isSetupHandler('props.onClose()')).toBe(true);
        expect(isSetupHandler('save?.()')).toBe(true);
    });

    it('sees through wrapping parentheses', () =>
    {
        expect(isSetupHandler('(count++)')).toBe(true);
        expect(isSetupHandler('(save())')).toBe(true);
    });
});

describe('isSetupHandler - accepted (deferred to the type system)', () =>
{
    it('does not flag bare references (identifier or member path)', () =>
    {
        expect(isSetupHandler('save')).toBe(false);
        expect(isSetupHandler('props.onClose')).toBe(false);
        expect(isSetupHandler('actions.reset')).toBe(false);
    });

    it('does not flag function literals', () =>
    {
        expect(isSetupHandler('() => count++')).toBe(false);
        expect(isSetupHandler('(e) => save(e)')).toBe(false);
        expect(isSetupHandler('function () { save(); }')).toBe(false);
    });

    it('does not flag a call WITH arguments (the handler-factory idiom)', () =>
    {
        expect(isSetupHandler('makeHandler(id)')).toBe(false);
        expect(isSetupHandler('bind(this)')).toBe(false);
    });

    it('does not flag a call whose callee is itself a call or an index access', () =>
    {
        expect(isSetupHandler('getHandlers().save()')).toBe(false);
        expect(isSetupHandler('handlers[key]()')).toBe(false);
        expect(isSetupHandler('getHandler()()')).toBe(false);
    });

    it('does not flag other expression forms', () =>
    {
        expect(isSetupHandler('cond ? a : b')).toBe(false);
        expect(isSetupHandler('handlers[key]')).toBe(false);
        expect(isSetupHandler('obj.handler ?? fallback')).toBe(false);
        expect(isSetupHandler('new Thing()')).toBe(false);
    });
});
