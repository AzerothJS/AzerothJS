// @vitest-environment node
//
// The base helpers on their own, and a router built with no document and no render pin.
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRoot, createRouter, h } from 'azerothjs';
import { joinBase, normalizeBase, stripBasePrefix } from 'azerothjs/internal';

describe('stripBasePrefix', () =>
{
    it('is the identity with no base', () =>
    {
        expect(stripBasePrefix('/about', '')).toBe('/about');
        expect(stripBasePrefix('/', '')).toBe('/');
    });

    it.each([
        ['/fa/about', '/fa', '/about'],
        ['/fa', '/fa', '/'],
        ['/fa/', '/fa', '/'],
        ['/%66a/about', '/fa', '/about'],
        ['/fa/post/a%2Fb', '/fa', '/post/a%2Fb'],
        ['/app/v2/about', '/app/v2', '/about'],
        ['/app/v2', '/app/v2', '/'],
        ['/app/v2/', '/app/v2', '/'],
        ['/app/v2/users/7', '/app/v2', '/users/7']
    ])('%s under %s is %s', (pathname, base, expected) =>
    {
        expect(stripBasePrefix(pathname, base)).toBe(expected);
    });

    it.each([
        ['/application/about', '/app'],
        ['/other/about', '/app'],
        ['/app/v3/about', '/app/v2'],
        ['/app', '/app/v2'],
        ['/%ZZ/about', '/fa'],
        ['fa/about', '/fa'],
        ['/fa//evil.example/x', '/fa'],
        ['/fa/\\evil.example/x', '/fa']
    ])('%s is outside %s', (pathname, base) =>
    {
        expect(stripBasePrefix(pathname, base)).toBeNull();
    });
});

describe('joinBase', () =>
{
    it('is the identity with no base, the root included', () =>
    {
        expect(joinBase('', '/')).toBe('/');
        expect(joinBase('', '/?a=1')).toBe('/?a=1');
        expect(joinBase('', '/#top')).toBe('/#top');
        expect(joinBase('', '/about')).toBe('/about');
    });

    it.each([
        ['/fa', '/', '/fa'],
        ['/fa', '/?a=1', '/fa?a=1'],
        ['/fa', '/#top', '/fa#top'],
        ['/fa', '/about?x', '/fa/about?x'],
        ['/fa', '/about#f', '/fa/about#f'],
        ['/app/v2', '/', '/app/v2'],
        ['/app/v2', '/about', '/app/v2/about']
    ])('%s + %s is %s', (base, fullPath, expected) =>
    {
        expect(joinBase(base, fullPath)).toBe(expected);
    });
});

describe('normalizeBase', () =>
{
    it('folds the no-base spellings and keeps every segment of a real one', () =>
    {
        expect(normalizeBase(undefined)).toBe('');
        expect(normalizeBase('')).toBe('');
        expect(normalizeBase('/')).toBe('');
        expect(normalizeBase('/app/v2/')).toBe('/app/v2');
        expect(normalizeBase('app')).toBe('/app');
    });
});

describe('a router with no document and no render pin', () =>
{
    it('has no base', () =>
    {
        createRoot((dispose) =>
        {
            const router = createRouter({
                routes: [{ path: '/about', component: () => h('p', {}, 'about') }],
                history: createMemoryHistory('/about')
            });
            expect(router.href('/about')).toBe('/about');
            expect(router.href('/')).toBe('/');
            expect(router.match()).not.toBeNull();
            dispose();
        });
    });
});
