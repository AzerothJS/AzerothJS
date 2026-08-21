// @vitest-environment happy-dom
//
// The marked-with-a-document shape: a consumer test file that constructs a server and
// then exercises components in the same DOM-emulating worker. Refusal must hold (the
// mark is process-global), the DEV warning must describe THIS trigger accurately and
// name the between-tests remedy, and resetDataCache must restore caching - a real
// browser never hosts a server entry point, so this test-environment shape is the entire
// audience of the browser-branch diagnostic.
import { describe, expect, it, vi } from 'vitest';
import { cached } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import { App } from '@azerothjs/http';

describe('a marked process with a document (consumer test shape)', () =>
{
    it('caches before marking, refuses after with the DOM-context warning, and resets back', async () =>
    {
        let count = 0;
        const family = cached('dom-marked', (key: string) =>
        {
            count++;
            return Promise.resolve(`dom-marked:${ key }`);
        });
        await family('k');
        await family('k');
        expect(count).toBe(1);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            new App();
            expect(await family('k')).toBe('dom-marked:k');
            await family('k');
            expect(count).toBe(3);
            const lines = warn.mock.calls.map((call) => String(call[0]));
            const hits = lines.filter((line) => line.includes('DOM context') && line.includes('resetDataCache'));
            expect(hits).toHaveLength(1);
        }
        finally
        {
            warn.mockRestore();
        }

        resetDataCache();
        await family('k');
        await family('k');
        expect(count).toBe(4);
    });
});
