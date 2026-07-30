// The explorer page's own RUNTIME. The HTML string is inert; every defect the page can
// have lives in the inline script, so these tests boot that script in a real DOM against
// a generated document. A page that throws on render still serves 200 and still contains
// every substring a string assertion would look for.

import { describe, it, expect, afterEach } from 'vitest';
import { object, string, number, boolean } from '@azerothjs/schema';
import { defineContract, post, multipart, toOpenApi } from '@azerothjs/http/api';

import { renderExplorerHtml } from '../../src/api/explorer.ts';

const INFO = { title: 'Test API', version: '1.0.0' };
const originalFetch = globalThis.fetch;

/**
 * Mounts the page's markup, stubs the spec fetch, and runs its inline script to
 * completion. The script is an async IIFE, so the returned promise carries anything it
 * throws straight into the test - a blank page is a failure here, not a silent pass.
 */
async function boot(specDocument: unknown): Promise<void>
{
    const html = renderExplorerHtml('/openapi.json', 'Test API');
    const bodyAt = html.indexOf('<body>') + '<body>'.length;
    const scriptAt = html.indexOf('<script>', bodyAt);
    document.body.innerHTML = html.slice(bodyAt, scriptAt);
    // Trimmed: a newline after `return` is a semicolon, and the page's promise would be lost.
    const source = html.slice(scriptAt + '<script>'.length, html.indexOf('</script>', scriptAt)).trim();
    globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve(specDocument) })) as unknown as typeof fetch;
    // The page ships as one <script> body; running it as written is the only way to test
    // what the browser actually executes.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    await (new Function(`return ${ source }`) as () => Promise<void>)();
}

afterEach(() =>
{
    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
});

describe('the explorer renders every declared media type', () =>
{
    // The multipart route is FIRST on purpose: the page renders operations[0] on boot, so
    // a throw there means the page never boots at all.
    const contract = defineContract({
        upload: post('/files', { input: multipart({ fields: object({ title: string({ nonempty: true }) }) }), output: object({ ok: boolean() }) }),
        create: post('/things', { input: object({ name: string() }), output: object({ id: number() }) })
    });
    const spec = toOpenApi(contract, { info: INFO });

    it('boots on a multipart-first document and shows the declared media type', async () =>
    {
        await boot(spec);
        const content = document.getElementById('content');
        expect(content?.textContent).toContain('upload');
        expect(content?.textContent).toContain('multipart/form-data');
        // The fields schema still renders - the fix widens the lookup, it does not drop the box.
        expect(content?.querySelector('.schema')).not.toBeNull();
        expect(content?.textContent).toContain('title');
    });

    it('offers no JSON body editor for a non-JSON media type, and still offers one for JSON', async () =>
    {
        await boot(spec);
        expect(document.querySelector('.try textarea')).toBeNull();

        const links = document.querySelectorAll('#nav .op-link');
        expect(links.length).toBe(2);
        (links[1] as HTMLElement).click();
        expect(document.getElementById('content')?.textContent).toContain('application/json');
        expect(document.querySelector('.try textarea')).not.toBeNull();
    });

    it('skips the schema box for a media type that carries no schema', async () =>
    {
        await boot({
            openapi: '3.1.0',
            info: { title: 'Bare', version: '1' },
            paths: {
                '/api/raw': {
                    post: {
                        operationId: 'raw',
                        requestBody: { required: true, content: { 'text/plain': {} } },
                        responses: { 200: { description: 'OK' } }
                    }
                }
            },
            components: { schemas: {} }
        });
        const content = document.getElementById('content');
        expect(content?.textContent).toContain('text/plain');
        expect(content?.querySelector('.schema')).toBeNull();
    });
});
