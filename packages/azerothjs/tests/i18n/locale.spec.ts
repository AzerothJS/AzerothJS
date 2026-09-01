// @vitest-environment node
//
// Locale negotiation: the rule the server runs over `Accept-Language` and the client runs over
// `navigator.languages`. Both are "what can I serve this reader", so a divergence between them
// is a page whose language changes at hydration - which is why the rule is one function.
import { describe, expect, it } from 'vitest';
import { localeDirection, parseAcceptLanguage, resolveLocale } from 'azerothjs';

describe('parseAcceptLanguage', () =>
{
    it('returns tags most-wanted first, which is not the order they were written in', () =>
    {
        expect(parseAcceptLanguage('en;q=0.5,fa;q=0.9,de;q=0.1')).toEqual(['fa', 'en', 'de']);
    });

    it('treats a weightless tag as fully wanted', () =>
    {
        expect(parseAcceptLanguage('fa-IR,fa;q=0.9,en;q=0.8')).toEqual(['fa-ir', 'fa', 'en']);
    });

    it('keeps header order between equal weights, because the client still wrote one first', () =>
    {
        expect(parseAcceptLanguage('en,fr,de')).toEqual(['en', 'fr', 'de']);
        expect(parseAcceptLanguage('en;q=0.7,fr;q=0.7')).toEqual(['en', 'fr']);
    });

    it('drops `*`, which names no language', () =>
    {
        expect(parseAcceptLanguage('*')).toEqual([]);
        expect(parseAcceptLanguage('fa,*;q=0.1')).toEqual(['fa']);
    });

    it('keeps a tag whose weight is malformed, ranked last rather than discarded', () =>
    {
        // The reader still named a language; only the weight is unreadable.
        expect(parseAcceptLanguage('fa;q=banana,en')).toEqual(['en', 'fa']);
    });

    it('survives the shapes a header can arrive in', () =>
    {
        expect(parseAcceptLanguage('')).toEqual([]);
        expect(parseAcceptLanguage('   ')).toEqual([]);
        expect(parseAcceptLanguage(' fa ; q=0.9 , en ')).toEqual(['en', 'fa']);
        expect(parseAcceptLanguage('fa;q=5')).toEqual(['fa']);
    });
});

describe('resolveLocale', () =>
{
    const supported = ['en', 'fa'] as const;

    it('serves the reader\'s FIRST choice, not merely one they would accept', () =>
    {
        // The mistake worth pinning: scanning for "is fa in there" answers Persian to a reader
        // who asked for English and would settle for Persian.
        expect(resolveLocale(['en-US', 'fa'], supported, 'en')).toBe('en');
        expect(resolveLocale(['fa', 'en-US'], supported, 'en')).toBe('fa');
    });

    it('serves a region variant from the language it belongs to', () =>
    {
        expect(resolveLocale(['fa-AF'], supported, 'en')).toBe('fa');
        expect(resolveLocale(['en-GB'], supported, 'en')).toBe('en');
    });

    it('matches a bare language against a regional catalogue too', () =>
    {
        expect(resolveLocale(['zh'], ['en', 'zh-CN'], 'en')).toBe('zh-CN');
    });

    it('prefers an EXACT match over a same-language one, wherever it sits', () =>
    {
        expect(resolveLocale(['pt-BR'], ['pt', 'pt-BR'], 'pt')).toBe('pt-BR');
    });

    it('answers with the app\'s own spelling, so the tag it returns is one it declared', () =>
    {
        expect(resolveLocale(['FA-ir'], ['en', 'fa'], 'en')).toBe('fa');
        expect(resolveLocale(['fa'], ['en', 'FA'], 'en')).toBe('FA');
    });

    it('falls back rather than guessing', () =>
    {
        expect(resolveLocale(['de', 'ja'], supported, 'en')).toBe('en');
        expect(resolveLocale([], supported, 'en')).toBe('en');
        expect(resolveLocale(['fa'], [], 'en')).toBe('en');
    });
});

describe('localeDirection', () =>
{
    it('knows the right-to-left languages, including the ones a hand-kept table forgets', () =>
    {
        for (const tag of ['fa', 'ar', 'he', 'ur', 'ps', 'sd', 'yi', 'ckb', 'fa-IR', 'ar-EG'])
        {
            expect(localeDirection(tag), tag).toBe('rtl');
        }
    });

    it('leaves the left-to-right ones alone', () =>
    {
        for (const tag of ['en', 'fr', 'zh-CN', 'ru', 'hi', 'tr', 'en-US'])
        {
            expect(localeDirection(tag), tag).toBe('ltr');
        }
    });

    it('answers ltr for a tag it cannot read, rather than throwing into the render', () =>
    {
        expect(localeDirection('not a tag')).toBe('ltr');
        expect(localeDirection('')).toBe('ltr');
        expect(localeDirection('xx-yy-zz-nonsense')).toBe('ltr');
    });
});
