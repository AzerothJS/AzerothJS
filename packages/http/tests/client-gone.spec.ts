// @vitest-environment node
//
// A client hanging up is not a server fault - but it is also not nothing.
//
// A handler that honours `request.signal` REJECTS when the client disconnects, and that
// rejection maps to a 500 like any other, so an abandoned navigation is indistinguishable from
// a server error at the observability seams. The kernel now reports the FACT (`clientGone`)
// rather than acting on it: nothing is suppressed, no status changes, and `logRequests`
// de-escalates a 5xx whose client had already gone.
//
// The deliberate non-suppression is the load-bearing part, and the last arm pins it. "Aborted"
// does not prove the abort CAUSED the error: a handler's own timeout controller, a mutating
// call handed `request.signal`, and a graceful-shutdown drain all raise AbortError on an
// aborted request while being real faults worth seeing. So the report still fires.
import { describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';
import { HttpError, type ErrorContext } from '../src/errors.ts';

function abortedRequest(url = 'http://local/x'): Request
{
    const controller = new AbortController();
    const request = new Request(url, { signal: controller.signal });
    controller.abort();
    return request;
}

describe('the error seam reports whether the client was already gone', () =>
{
    it('flags clientGone when the request was abandoned', async () =>
    {
        const seen: Array<ErrorContext | undefined> = [];
        const app = new App({ onError: (_error, _mapped, context) => void seen.push(context) });
        app.get('/x', () =>
        {
            throw new HttpError(500, 'upstream exploded');
        });

        const response = await app.handle(abortedRequest());
        expect(response.status).toBe(500);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.clientGone).toBe(true);
    });

    it('CONTROL: a live client\'s failure is not flagged', async () =>
    {
        const seen: Array<ErrorContext | undefined> = [];
        const app = new App({ onError: (_error, _mapped, context) => void seen.push(context) });
        app.get('/x', () =>
        {
            throw new HttpError(500, 'upstream exploded');
        });

        const response = await app.handle(new Request('http://local/x'));
        expect(response.status).toBe(500);
        expect(seen[0]?.clientGone).toBe(false);
    });

    it('STILL REPORTS an abort-shaped failure - the flag classifies, it does not silence', async () =>
    {
        // The case the design refused to suppress: this could equally be a handler's own
        // timeout, or a half-applied write that took the request signal.
        const seen: unknown[] = [];
        const app = new App({ onError: (error) => void seen.push((error as { name?: string }).name) });
        app.get('/x', () =>
        {
            throw new DOMException('The operation was aborted.', 'AbortError');
        });

        const response = await app.handle(abortedRequest());
        expect(response.status).toBe(500);
        // Reported, not swallowed.
        expect(seen).toEqual(['AbortError']);
    });

    it('the status contract is unchanged - no new code reaches the wire', async () =>
    {
        const app = new App();
        app.get('/x', () =>
        {
            throw new HttpError(503, 'nope');
        });
        expect((await app.handle(abortedRequest())).status).toBe(503);
    });
});
