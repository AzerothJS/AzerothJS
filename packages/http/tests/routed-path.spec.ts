// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { App, json, pipeline, RadixRouter, routedPath } from '@azerothjs/http';
import { createAdapterRequest } from '../src/adapter-request.ts';
import { requestSegments } from '../src/request-path.ts';

describe('routed path identity', () =>
{
    it.each([
        ['%61rt/', '/gallery/art', 'art'],
        ['caf%C3%A9%20noir', '/gallery/café noir', 'café noir'],
        ['A%2fB', '/gallery/A%2FB', 'A/B'],
        ['A%252FB', '/gallery/A%252FB', 'A%2FB'],
        ['100%25', '/gallery/100%25', '100%'],
        ['paper%3f%23%5c', '/gallery/paper%3F%23%5C', 'paper?#\\']
    ])('gives a wrapper and a handler the same identity for %s', async (leaf, identity, label) =>
    {
        const app = new App();
        app.get('/gallery/:label', context => json({ path: context.path, label: context.params.label }));
        let observed: string | null = null;
        const handler = pipeline(app, next => ({
            handle(request)
            {
                observed = routedPath(request);
                return next.handle(request);
            }
        }));
        const response = await handler.handle(new Request(`https://example.test/gallery/${ leaf }?page=1`));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ path: identity, label });
        expect(observed).toBe(identity);
    });

    it.each([
        ['/', '/'],
        ['/exhibits/v1.2/', '/exhibits/v1.2'],
        ['/gallery?next=https://example.test/other', '/gallery'],
        ['HTTPS://example.test/gallery#ref/2', '/gallery'],
        ['https://example.test?next=/gallery', '/'],
        ['https://example.test#next/gallery', '/'],
        ['https://example.test', '/'],
        ['/gallery/%ZZ', null],
        ['gallery', null],
        ['ftp://example.test/gallery', null],
        ['https://', null],
        ['https:///gallery', null],
        ['https://bad host/gallery', null]
    ])('reads %s as a request target', (target, identity) =>
    {
        expect(routedPath(target)).toBe(identity);
    });

    it('agrees with the Node request adapter when a root URL has a slash in its query', () =>
    {
        const target = 'https://example.test?next=/gallery';
        const incoming = new IncomingMessage(new Socket());
        incoming.url = target;
        const request = createAdapterRequest(incoming, 'http');
        expect(new URL(request.url).searchParams.get('next')).toBe('/gallery');
        expect(routedPath(request)).toBe('/');
        expect(routedPath(target)).toBe(routedPath(request));
    });

    it('distinguishes a refused component from a malformed escape', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/:label', 'label');
        for (const component of ['.', '..', '%2E', '%2e%2E', 'a\\b'])
        {
            const target = '/' + component;
            expect(requestSegments(target)).toBe('miss');
            expect(routedPath(target)).toBeNull();
            expect(routedPath('https://example.test' + target)).toBeNull();
            expect(router.match('GET', target).kind).toBe('miss');
        }
        expect(requestSegments('/gallery//')).toBe('miss');
        expect(requestSegments('/gallery/%ZZ')).toBe('decode-error');
        expect(requestSegments('/.well-known/v1.2/')).toEqual(['.well-known', 'v1.2']);
    });

    it('preserves method outcomes on ordinary gallery targets', async () =>
    {
        const app = new App();
        app.get('/gallery', () => json({ available: true }));
        const target = 'https://example.test/%67allery/';
        const head = await app.handle(new Request(target, { method: 'HEAD' }));
        expect(head.status).toBe(200);
        expect(head.body).toBeNull();
        const post = await app.handle(new Request(target, { method: 'POST' }));
        expect(post.status).toBe(405);
        expect(post.headers.get('allow')).toBe('GET, HEAD');
    });
});
