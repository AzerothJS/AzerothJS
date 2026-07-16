// @vitest-environment node
//
// The DRIFT GUARD for the `with { ... }` option allowlist. The azeroth/unknown-option
// diagnostic and the option completion/hover all read ONE hand-maintained table -
// KEYWORD_OPTIONS in language-data.ts - but each keyword's REAL options are the fields of the
// runtime option type it lowers to. When a runtime option is added or renamed without updating
// the table, the editor shows a FALSE "unknown option" error (this is exactly how `schema` on
// `form`, and the defer->skipInitial / timeout->delay renames, slipped out of sync).
//
// This spec pins the two sides together. For each keyword whose `with { }` clause maps 1:1 onto
// an options interface, `expectTypeOf` asserts the EXPECTED key set equals that interface's keys
// (so adding a runtime option fails the type check here), and a runtime assertion checks the
// allowlist names equal that same expected set (so the table drifting fails too). resource and
// stream are curated (their `source` is an extracted call argument and their value is the
// fetcher, not option keys), so their expected sets are documented explicitly.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { KEYWORD_OPTIONS } from '../src/language-data.ts';
import type { SignalOptions, EffectOptions, SelectorOptions } from '@azerothjs/reactivity';
import type { DeferredOptions } from '@azerothjs/reactivity';
import type { OnOptions } from '@azerothjs/reactivity';
import type { FormConfig, FieldArrayConfig } from '@azerothjs/form';

/** The option names the allowlist offers for a keyword. */
function allowed(keyword: string): Set<string>
{
    return new Set((KEYWORD_OPTIONS[keyword] ?? []).map((option) => option.name));
}

describe('KEYWORD_OPTIONS matches the runtime option surface', () =>
{
    it('state / derived == keyof SignalOptions', () =>
    {
        expectTypeOf<'equals' | 'name'>().toEqualTypeOf<keyof SignalOptions<unknown>>();
        expect(allowed('state')).toEqual(new Set(['equals', 'name']));
        expect(allowed('derived')).toEqual(new Set(['equals', 'name']));
    });

    it('effect == keyof EffectOptions', () =>
    {
        expectTypeOf<'name'>().toEqualTypeOf<keyof EffectOptions>();
        expect(allowed('effect')).toEqual(new Set(['name']));
    });

    it('deferred == keyof DeferredOptions (delay, not timeout)', () =>
    {
        expectTypeOf<'delay'>().toEqualTypeOf<keyof DeferredOptions>();
        expect(allowed('deferred')).toEqual(new Set(['delay']));
    });

    it('watch (effect deps) == keyof OnOptions (skipInitial, not defer)', () =>
    {
        expectTypeOf<'skipInitial'>().toEqualTypeOf<keyof OnOptions>();
        expect(allowed('watch')).toEqual(new Set(['skipInitial']));
    });

    it('selector == keyof SelectorOptions', () =>
    {
        expectTypeOf<'equals'>().toEqualTypeOf<keyof SelectorOptions<unknown>>();
        expect(allowed('selector')).toEqual(new Set(['equals']));
    });

    it('form == (FormConfig union FieldArrayConfig) user options, INCLUDING schema', () =>
    {
        // Every user-facing form option. `blank` is excluded: for `form NAME[] = { ...row }` the
        // declaration value IS the blank, never written in the with-clause. `initial` on a flat
        // FormConfig is likewise the declaration value, but the array-form accepts `initial` in
        // the clause, so it stays in the set.
        type FormOptionKey = Exclude<keyof FormConfig<Record<string, unknown>> | keyof FieldArrayConfig<Record<string, unknown>>, 'blank'>;
        expectTypeOf<FormOptionKey>().toEqualTypeOf<
            'initial' | 'validate' | 'schema' | 'validateForm' | 'validateAsync' | 'asyncDebounceMs' | 'onSubmit' | 'validateArray'
        >();
        expect(allowed('form')).toEqual(new Set([
            'initial', 'validate', 'schema', 'validateForm', 'validateAsync', 'asyncDebounceMs', 'onSubmit', 'validateArray'
        ]));
        // The regression that started this: `schema` must be allowed on `form`.
        expect(allowed('form').has('schema')).toBe(true);
    });

    it('resource is curated: only the extracted `source` getter (initialValue is an internal SSR seam)', () =>
    {
        expect(allowed('resource')).toEqual(new Set(['source']));
    });

    it('stream is curated: source + the StreamOptions the clause carries', () =>
    {
        expect(allowed('stream')).toEqual(new Set(['source', 'parse', 'initial']));
    });
});
