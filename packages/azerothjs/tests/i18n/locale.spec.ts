// @vitest-environment node
//
// Locale negotiation: the rule the server runs over `Accept-Language` and the client runs over
// `navigator.languages`. Both are "what can I serve this reader", so a divergence between them
// is a page whose language changes at hydration - which is why the rule is one function.
import { describe, expect, it } from 'vitest';
import { localeDirection, negotiateLocale, parseAcceptLanguage, resolveLocale } from 'azerothjs';

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

describe('negotiateLocale reads a hostile cookie without throwing', () =>
{
    const config = { supported: ['en', 'fa'] };
    const request = (cookie: string): Request => new Request('http://x/', { headers: { cookie } });

    it('a percent-escaped choice decodes', () =>
    {
        expect(negotiateLocale(request('locale=%66a'), config)).toEqual({ locale: 'fa', fromCookie: true });
    });

    it('a malformed escape falls back instead of failing the request', () =>
    {
        expect(negotiateLocale(request('locale=%'), config)).toEqual({ locale: 'en', fromCookie: true });
        expect(negotiateLocale(request('locale=%E0%A4%A'), config)).toEqual({ locale: 'en', fromCookie: true });
    });
});

describe('negotiateLocale: the site\'s own language first', () =>
{
    const english = (headers: Record<string, string> = {}): Request =>
        new Request('http://x/', { headers: { 'accept-language': 'en-US,en;q=0.9', ...headers } });

    it('with the header source off, a first visit lands in the default', () =>
    {
        // A Persian-first site: the browser says English, the site answers Persian.
        const config = { supported: ['en', 'fa'], default: 'fa', acceptLanguage: false };
        expect(negotiateLocale(english(), config)).toEqual({ locale: 'fa', fromCookie: false });
        // And without a named default, the first supported language.
        expect(negotiateLocale(english(), { supported: ['fa', 'en'], acceptLanguage: false }))
            .toEqual({ locale: 'fa', fromCookie: false });
    });

    it('a cookie still wins, because it is an answer the reader gave', () =>
    {
        const config = { supported: ['en', 'fa'], default: 'fa', acceptLanguage: false };
        expect(negotiateLocale(english({ cookie: 'locale=en' }), config)).toEqual({ locale: 'en', fromCookie: true });
    });

    it('with the switch unset the header still decides (control)', () =>
    {
        expect(negotiateLocale(english(), { supported: ['en', 'fa'], default: 'fa' })).toEqual({ locale: 'en', fromCookie: false });
    });

    it('a named default the site does not publish resolves to the first supported language', () =>
    {
        // Under prefix routing an unresolved default would redirect every first visit to a
        // prefix no mount serves: the whole site 404s on a typo. Resolved, it cannot.
        const config = { supported: ['en', 'fa'], default: 'de' };
        expect(negotiateLocale(new Request('http://x/'), config)).toEqual({ locale: 'en', fromCookie: false });
        expect(negotiateLocale(new Request('http://x/', { headers: { 'accept-language': 'it' } }), config))
            .toEqual({ locale: 'en', fromCookie: false });
        // A regional spelling of a published language resolves to it, like a reader's tag would.
        expect(negotiateLocale(new Request('http://x/'), { supported: ['en', 'fa'], default: 'fa-IR' }))
            .toEqual({ locale: 'fa', fromCookie: false });
    });
});
