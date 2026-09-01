// @vitest-environment happy-dom
//
// Message catalogues and locale-bound formatting.
//
// The arms that matter are the plural ones. `count === 1 ? one : other` is what a hand-rolled
// catalogue reaches for, and it is correct only for the languages the person writing it speaks -
// Arabic distinguishes six forms and Russian four, so those readers get grammatically wrong text
// from code that looks obviously right.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMessages, setLocale, useDateFormat, useListFormat, useNumberFormat, useRelativeTimeFormat } from 'azerothjs';
import { resetLocale } from 'azerothjs/internal';

beforeEach(() =>
{
    resetLocale();
    document.documentElement.removeAttribute('lang');
});

const t = createMessages({
    en: {
        hello: 'Hello {name}',
        items: { one: '{count} item', other: '{count} items' },
        plain: 'Plain'
    },
    fa: {
        hello: 'سلام {name}',
        items: { other: '{count} مورد' },
        plain: 'ساده'
    }
});

describe('messages', () =>
{
    it('answers in the current language and follows a switch', () =>
    {
        setLocale('en');
        expect(t('hello', { name: 'Ada' })).toBe('Hello Ada');
        setLocale('fa');
        expect(t('hello', { name: 'Ada' })).toBe('سلام Ada');
    });

    it('leaves an unfilled placeholder as written rather than blanking it', () =>
    {
        setLocale('en');
        // Blanking hides the bug; leaving it visible is a defect someone can see and report.
        expect(t('hello')).toBe('Hello {name}');
        expect(t('hello', { other: 'x' })).toBe('Hello {name}');
    });

    it('serves a regional reader from the base language catalogue', () =>
    {
        setLocale('fa-IR');
        expect(t('plain')).toBe('ساده');
    });

    it('falls back to the reference language rather than rendering nothing', () =>
    {
        setLocale('de');
        expect(t('plain')).toBe('Plain');
    });

    it('names a key that exists in no catalogue, once, and renders the key itself', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        setLocale('en');
        expect((t as (k: string) => string)('nope.missing')).toBe('nope.missing');
        (t as (k: string) => string)('nope.missing');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('nope.missing');
        warn.mockRestore();
    });
});

describe('plural forms come from the language, not from counting to one', () =>
{
    const counted = createMessages({
        en: { n: { one: '{count} file', other: '{count} files' } },
        ru: { n: { one: '{count} файл', few: '{count} файла', many: '{count} файлов', other: '{count} файла' } },
        ar: {
            n: {
                zero: 'لا ملفات',
                one: 'ملف واحد',
                two: 'ملفان',
                few: '{count} ملفات',
                many: '{count} ملفا',
                other: '{count} ملف'
            }
        }
    });

    it('uses two forms in English', () =>
    {
        setLocale('en');
        expect(counted('n', { count: 1 })).toBe('1 file');
        expect(counted('n', { count: 0 })).toBe('0 files');
        expect(counted('n', { count: 5 })).toBe('5 files');
    });

    it('uses FOUR in Russian, which a one-or-other rule gets wrong for 2 and 5', () =>
    {
        setLocale('ru');
        expect(counted('n', { count: 1 })).toBe('1 файл');
        // The discriminating pair: a naive rule would render both of these as the `other` form.
        expect(counted('n', { count: 3 })).toBe('3 файла');
        expect(counted('n', { count: 7 })).toBe('7 файлов');
        expect(counted('n', { count: 21 })).toBe('21 файл');
    });

    it('uses SIX in Arabic, including distinct zero and dual forms', () =>
    {
        setLocale('ar');
        expect(counted('n', { count: 0 })).toBe('لا ملفات');
        expect(counted('n', { count: 1 })).toBe('ملف واحد');
        expect(counted('n', { count: 2 })).toBe('ملفان');
        expect(counted('n', { count: 3 })).toBe('3 ملفات');
        expect(counted('n', { count: 11 })).toBe('11 ملفا');
    });

    it('falls back to `other` for a form the catalogue did not spell', () =>
    {
        // The Persian catalogue writes only `other`, which is correct for Persian.
        setLocale('fa');
        expect(t('items', { count: 1 })).toBe('1 مورد');
        expect(t('items', { count: 9 })).toBe('9 مورد');
    });

    it('uses `other` when there is no count to select on', () =>
    {
        setLocale('en');
        expect(t('items')).toBe('{count} items');
    });
});

describe('formatting follows the reader', () =>
{
    it('formats numbers in the reader\'s digits', () =>
    {
        const n = useNumberFormat();
        setLocale('en');
        expect(n(1234567.89)).toBe('1,234,567.89');
        setLocale('fa');
        // The same call, a different reading: this is the locale signal doing the work.
        expect(n(1234567.89)).toBe('۱٬۲۳۴٬۵۶۷٫۸۹');
    });

    it('formats dates in the reader\'s calendar', () =>
    {
        const d = useDateFormat();
        const when = new Date(Date.UTC(2026, 2, 14));
        setLocale('en');
        expect(d(when, { dateStyle: 'long', timeZone: 'UTC' })).toContain('2026');
        setLocale('fa');
        // Persian gets the Jalali calendar from Intl: the year is not 2026.
        expect(d(when, { dateStyle: 'long', timeZone: 'UTC' })).not.toContain('2026');
    });

    it('says how long ago in words, choosing the unit by magnitude', () =>
    {
        const ago = useRelativeTimeFormat();
        setLocale('en');
        expect(ago(Date.now() - 3 * 86_400_000)).toBe('3 days ago');
        expect(ago(Date.now() + 2 * 3_600_000)).toBe('in 2 hours');
        expect(ago(Date.now() - 5000)).toContain('seconds');
    });

    it('joins a list the way the language does', () =>
    {
        const list = useListFormat();
        setLocale('en');
        expect(list(['Ada', 'Grace', 'Katherine'])).toBe('Ada, Grace, and Katherine');
    });
});
