// @vitest-environment happy-dom
//
// setLocale(): one shape in both client modes. The tag is checked first, because it can be
// reader-supplied text; under a url prefix the switch is a navigation to the sibling document.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString, setLocale } from 'azerothjs';
import { resetLocale } from 'azerothjs/internal';

let assigned: string[] = [];
// A fresh cookie name per arm: happy-dom keeps an expired cookie's name around.
let cookie = '';
let arms = 0;

beforeEach(() =>
{
    assigned = [];
    cookie = `choice${ arms++ }`;
    vi.spyOn(window.location, 'assign').mockImplementation((url: string | URL) =>
    {
        assigned.push(String(url));
    });
    document.documentElement.setAttribute('lang', 'fa');
    document.documentElement.setAttribute('dir', 'rtl');
    resetLocale();
});

afterEach(() =>
{
    document.documentElement.removeAttribute('data-azeroth-base');
    vi.restoreAllMocks();
});

const JUNK = ['/evil.example', '\\evil.example', '', '\t/evil', 'pt_BR', 'en?x='];

describe('on a document that carries a base', () =>
{
    beforeEach(() =>
    {
        document.documentElement.setAttribute('data-azeroth-base', '/fa');
        history.replaceState(null, '', '/fa/about?q=1');
    });

    it('writes the cookie and leaves for the sibling document, touching nothing else', () =>
    {
        let cookieAtLeave = '';
        vi.spyOn(window.location, 'assign').mockImplementation((url: string | URL) =>
        {
            cookieAtLeave = document.cookie;
            assigned.push(String(url));
        });
        setLocale('en', { cookie });
        expect(document.cookie).toContain(`${ cookie }=en`);
        expect(assigned).toEqual(['/en/about?q=1']);
        // The cookie is already written when the document leaves.
        expect(cookieAtLeave).toContain(`${ cookie }=en`);
        expect(document.documentElement.getAttribute('lang')).toBe('fa');
    });

    it('keeps a regional tag, and the root has one spelling', () =>
    {
        setLocale('zh-Hant', { cookie });
        expect(assigned).toEqual(['/zh-Hant/about?q=1']);
        history.replaceState(null, '', '/fa');
        setLocale('en', { cookie });
        expect(assigned[1]).toBe('/en');
    });

    it.each(JUNK)('refuses %j before anything is written', (junk) =>
    {
        expect(() => setLocale(junk, { cookie })).toThrow(/language tag/);
        expect(assigned).toEqual([]);
        expect(document.cookie).not.toContain(`${ cookie }=`);
        expect(document.documentElement.getAttribute('lang')).toBe('fa');
    });
});

describe('without a base', () =>
{
    it('switches the document in place, as before', () =>
    {
        setLocale('en', { cookie });
        expect(assigned).toEqual([]);
        expect(document.documentElement.getAttribute('lang')).toBe('en');
        expect(document.documentElement.getAttribute('dir')).toBe('ltr');
        expect(document.cookie).toContain(`${ cookie }=en`);
    });

    it.each(JUNK)('refuses %j', (junk) =>
    {
        expect(() => setLocale(junk, { cookie })).toThrow(/language tag/);
        expect(document.documentElement.getAttribute('lang')).toBe('fa');
        expect(document.cookie).not.toContain(`${ cookie }=`);
    });
});

describe('during a server render', () =>
{
    it('is refused as a client action first, whatever the tag', () =>
    {
        expect(() => renderToString(() =>
        {
            setLocale('pt_BR', { cookie });
            return document.createElement('div');
        })).toThrow(/client action/);
        expect(document.cookie).not.toContain(`${ cookie }=`);
    });
});
