// The RAW half of the API: routes with no JSON body for a contract to validate. Uploads
// (streamMultipart), webhooks, redirects, downloads and this token stream live here; app.ts
// stays a wiring table.
import { type App, sse } from '@azerothjs/http';

const REPLY = 'Streaming works: each word arrived as its own server-sent event, appended to one reactive string.';

export function mountStream(app: App): void
{
    app.get('/api/assistant', (context) =>
        sse(context.request, async (connection) =>
        {
            const question = context.url.searchParams.get('q')?.trim();
            connection.send(`${ question === undefined || question === '' ? 'Ask me anything.' : `You asked: ${ question }.` } `);

            for (const word of REPLY.split(' '))
            {
                // Where a real handler cancels its upstream model call: an abandoned tab must
                // stop costing money.
                if (connection.signal.aborted)
                {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 90));
                // The separator rides IN the payload, as a tokenizer emits it: a trailing space
                // survives SSE framing, a leading one is eaten.
                connection.send(`${ word } `);
            }
            // Emits the [DONE] terminator the client's stream parser waits for.
            connection.close();
        }));
}
