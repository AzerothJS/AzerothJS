// @vitest-environment happy-dom
//
// The manifest handoff: the server embeds the manifest as an inert JSON script tag
// (the same discipline as the router's loader handoff), the client reads it back
// synchronously - no /api/_manifest round trip on the hydration path - and a client
// built over an EMPTY or stale manifest fails each call with a designed error that
// names the cause, never a bare TypeError on an undefined group.
import { describe, it, expect, afterEach } from 'vitest';
import { object, string } from '@azerothjs/schema';
import { feature, manifestOf } from '@azerothjs/http/api';
import { createClient, readManifest, manifestScript, type Manifest } from '@azerothjs/http/api/shared';

const api = {
    guestbook: feature('/guestbook', (routes) => ({
        list: routes.get('/', { output: object({ name: string() }) }, () => ({ name: 'x' }))
    }))
};

afterEach(() =>
{
    document.head.innerHTML = '';
});

describe('manifest handoff wire', () =>
{
    it('round-trips: the embedded script parses back to the same manifest', () =>
    {
        const manifest = manifestOf(api);
        document.head.innerHTML = manifestScript(manifest);
        expect(readManifest()).toEqual(manifest);
    });

    it('returns undefined with no tag (plain client start) and on malformed content', () =>
    {
        expect(readManifest()).toBeUndefined();
        document.head.innerHTML = manifestScript(manifestOf(api)).replace('{', 'not json {');
        expect(readManifest()).toBeUndefined();
    });

    it('a path containing </script> cannot terminate the tag', () =>
    {
        const hostile: Manifest = { g: { esc: { method: 'GET', path: '/</script><script>alert(1)</script>' } } };
        const script = manifestScript(hostile);
        expect(script.slice(script.indexOf('>') + 1)).not.toContain('</script><script>');
        document.head.innerHTML = script;
        expect(readManifest()?.g?.esc?.path).toBe('/</script><script>alert(1)</script>');
    });
});

describe('empty or stale manifest: designed failure at the call', () =>
{
    it('a missing group fails at the CALL with an error naming the group and the cause', async () =>
    {
        const client = createClient<typeof api>({}, { baseUrl: '/api' });

        // Reading the group must NOT throw - pages render, each call fails at its site.
        const group = client.guestbook;
        expect(group).toBeTruthy();

        await expect(async () => group.list()).rejects.toThrow(/guestbook.*manifest/);
    });

    it('a real group on a partial manifest stays a plain object; only missing ones are trapped', () =>
    {
        const manifest = manifestOf(api);
        const client = createClient<typeof api>(manifest, { baseUrl: '/api' });
        expect(typeof client.guestbook.list).toBe('function');
        expect(Object.keys(client)).toEqual(['guestbook']);
    });
});
