/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Refuse-by-drop at every head serialization site: a value the runtime cannot represent
// (a jsonLd hole, a BigInt, a non-string composed title) costs ITSELF, never the response.
// The server sites run inside the host's finally, where a throw would REPLACE the render's
// real outcome - the masking shape pinned below is exactly that: a stale poison frame must
// not convert a later request's genuine error into a TypeError.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, h, renderToString, unsafeUrl, useHead } from 'azerothjs';
import { collectHead, resetHead } from 'azerothjs/internal';

beforeEach(() =>
{
    resetHead();
    vi.restoreAllMocks();
});

const page = (input: Parameters<typeof useHead>[0]) => (): HTMLElement =>
{
    useHead(input);
    return h('div', {}, 'body');
};

describe('collectHead - refuse-by-drop at the drain sites', () =>
{
    it('a jsonLd array with a top-level hole drops the hole and serves its siblings', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        renderToString(page({ jsonLd: [{ '@type': 'Thing', name: 'good' }, undefined] as never }));
        const collected = collectHead();
        expect(collected.additions).toContain('"name":"good"');
        expect(warn.mock.calls.some((c) => /jsonLd block was DROPPED/.test(String(c[0])))).toBe(true);
    });

    it('a BigInt inside one jsonLd block drops that block only', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        renderToString(page({ jsonLd: [{ price: 129n }, { '@type': 'Thing', name: 'ok' }] as never }));
        const collected = collectHead();
        expect(collected.additions).toContain('"name":"ok"');
        expect(collected.additions).not.toContain('129');
        expect(warn.mock.calls.some((c) => /jsonLd block was DROPPED/.test(String(c[0])))).toBe(true);
    });

    it('a non-string title drops the title and keeps the rest of the head', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        renderToString(page({
            title: (() => 42) as never,
            meta: [{ name: 'description', content: 'still here' }]
        }));
        const collected = collectHead();
        expect(collected.titleElementHtml).toBeNull();
        expect(collected.replacements.some((r) => r.html.includes('still here'))).toBe(true);
        expect(warn.mock.calls.some((c) => /title was DROPPED/.test(String(c[0])))).toBe(true);
    });

    it('a non-string titleTemplate drops the composed title instead of throwing from composeTitle', () =>
    {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // The template only composes when it comes from an EARLIER entry (a layout's
        // template + a leaf's title) - one entry's own template never wraps its own title.
        renderToString(() =>
        {
            useHead({ titleTemplate: 42 as never });
            useHead({ title: 'Page' });
            return h('div', {}, 'body');
        });
        const collected = collectHead();
        expect(collected.titleElementHtml).toBeNull();
    });

    it('a stale poison frame no longer masks a later request\'s real error at the host drain', () =>
    {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // Request A renders a poison head and its host never drains (crash between
        // render and drain, or a host that only drains styles).
        renderToString(page({ jsonLd: [undefined] as never }));
        // Request B throws for a real reason; its own throw-path discard no-ops on A's
        // frame (different render scope), so A's poison survives to B's host drain.
        expect(() => renderToString(() =>
        {
            throw new Error('database exploded: connection refused');
        })).toThrow('database exploded');
        // The host's finally drains. Pre-fix: TypeError from inertJson REPLACED the real
        // error the caller was already handling. Post-fix: the drain drops and proceeds.
        expect(() => collectHead()).not.toThrow();
    });
});

describe('collectHead - the no-user-code invariant holds even for pathological getters', () =>
{
    it('a title getter resolving to a FUNCTION is dropped at registration; the drain never invokes it', () =>
    {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let ranAtDrain = false;
        renderToString(page({
            title: (() => () =>
            {
                ranAtDrain = true;
                throw new Error('inner boom');
            }) as never
        }));
        const collected = collectHead();
        expect(ranAtDrain).toBe(false);
        expect(collected.titleElementHtml).toBeNull();
    });
});

describe('client faces - the same drops, mid-navigation safe', () =>
{
    it('a poison jsonLd block among good ones applies the good ones and drops the bad', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            useHead({ jsonLd: [{ '@type': 'Thing', name: 'client-good' }, { bad: 10n }] as never });
        });
        // Query while the root lives: disposal releases the jsonLd identities.
        const blocks = [...document.head.querySelectorAll('script[data-azeroth-head="jsonld"]')];
        dispose();
        expect(blocks.some((b) => b.textContent.includes('client-good'))).toBe(true);
        expect(blocks.some((b) => b.textContent.includes('10'))).toBe(false);
        expect(warn.mock.calls.some((c) => /jsonLd block was DROPPED/.test(String(c[0])))).toBe(true);
    });

    it('a non-string layout template drops the composed title instead of throwing inside the effect', () =>
    {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const boot = document.title;
        // The discriminating shape: the template comes from an EARLIER entry, so
        // composeTitle takes the replace path and template.replace throws on a
        // non-string template - mid-navigation, inside the winner-gated effect.
        expect(() => createRoot((dispose) =>
        {
            useHead({ titleTemplate: 42 as never });
            useHead({ title: 'Page' });
            dispose();
        })).not.toThrow();
        expect(document.title).toBe(boot);
    });

    it('a composed value with a throwing toString cannot escape the title effect', () =>
    {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const boot = document.title;
        expect(() => createRoot((dispose) =>
        {
            useHead({ title: (() => ({ toString: () =>
            {
                throw new Error('title toString boom');
            } })) as never });
            dispose();
        })).not.toThrow();
        expect(document.title).toBe(boot);
    });

    it('with a document present, useHead outside string mode stays on the client contract (no bare-server diagnostic)', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        createRoot((dispose) =>
        {
            useHead({ meta: [{ name: 'description', content: 'client path' }] });
            dispose();
        });
        expect(warn.mock.calls.some((c) => /no document/.test(String(c[0])))).toBe(false);
    });
});

// A refresh pragma's `content` IS a navigation directive, and useHead is the one path that
// builds one from DATA. It answers to the same rule a guard redirect does; every other meta
// keeps its absolute URLs, which is what makes the rule safe rather than noisy.
describe('a meta refresh directive is judged like a redirect target', () =>
{
    const meta = (input: Parameters<typeof useHead>[0]): string =>
    {
        renderToString(page(input));
        // ONE drain: collectHead empties the frame, so a second call returns nothing and
        // would make every not-to-contain assertion below pass on an empty string.
        const collected = collectHead();
        return collected.additions + collected.replacements.map((r) => r.html).join('');
    };

    it('DROPS a refresh whose target leaves the origin, in every legal spelling', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            for (const content of [
                '0;url=https://evil.example/',
                '0;https://evil.example/',
                '0,https://evil.example/',
                '0 https://evil.example/',
                '0;url=//evil.example/'
            ])
            {
                resetHead();
                expect(meta({ meta: [{ httpEquiv: 'refresh', content }] })).not.toContain('evil.example');
            }
            expect(warn).toHaveBeenCalled();
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('KEEPS an ordinary absolute URL in any other meta - the rule is refresh-only', () =>
    {
        // og:url and og:image carry absolute URLs by definition; judging `content` on every
        // meta would refuse the single most common head declaration on the web.
        const html = meta({ meta: [
            { property: 'og:url', content: 'https://example.com/post/1' },
            { name: 'twitter:image', content: 'https://cdn.example.com/a.png' }
        ] });
        expect(html).toContain('https://example.com/post/1');
        expect(html).toContain('https://cdn.example.com/a.png');
    });

    it('KEEPS an internal refresh target and a self-refresh', () =>
    {
        expect(meta({ meta: [{ httpEquiv: 'refresh', content: '3;url=/thanks' }] })).toContain('/thanks');
        resetHead();
        expect(meta({ meta: [{ httpEquiv: 'refresh', content: '30' }] })).toContain('content="30"');
    });

    it('KEEPS an author-vetted off-origin refresh', () =>
    {
        const html = meta({ meta: [{ httpEquiv: 'refresh', content: unsafeUrl('0;url=https://payments.example/') }] });
        expect(html).toContain('payments.example');
    });
});
