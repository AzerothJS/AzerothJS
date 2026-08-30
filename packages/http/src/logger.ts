/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The request-logging observer.
 *
 * The kernel does not log; it OBSERVES. `logRequests(logger)` is the one logging concern that
 * belongs to this package - one structured line per completed request - and it writes through
 * whatever logger the application brought. THE logger is `@azerothjs/logger`'s `createLogger`
 * (two faces, redaction, file sinks); anything else (pino, OpenTelemetry, a test spy) fits the
 * two-method structural contract below.
 *
 * The field names this emits (`method`, `path`, `status`, `durationMs`, `requestId`) are a wire
 * convention: `@azerothjs/logger`'s pretty face recognizes exactly these and renders a request
 * line. Rename one here and the pretty rendering silently degrades - the convention's other
 * half lives in that package's sinks.
 */

import { requestIdOf } from './edge.ts';
// The kernel's own scan, not `new URL`: a malformed authority (a forged Host header) makes URL
// parsing throw, App.handle swallows an observer throw, and a request served with no audit line
// is exactly the failure this observer exists to prevent.
import { pathnameOf } from './app.ts';

/**
 * The structural minimum {@link logRequests} writes through: an info line per request, an error
 * line per 5xx. `@azerothjs/logger`'s Logger satisfies it, and so does any logging library
 * behind a five-line adapter the application owns.
 */
export interface RequestLogger
{
    info(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * The standard request-logging observer: one info line per completed request with method,
 * path, status, and wall time; 5xx log at error level. A correlation id assigned by the
 * `requestId` edge middleware rides along automatically. Wire it as `observe` on the App.
 */
export function logRequests(logger: RequestLogger): { onComplete(request: Request, response: Response, durationMs: number): void }
{
    return {
        onComplete(request, response, durationMs): void
        {
            const fields: Record<string, unknown> = {
                method: request.method,
                path: pathnameOf(request.url),
                status: response.status,
                durationMs: Math.round(durationMs * 100) / 100
            };
            const id = requestIdOf(request);
            if (id !== undefined)
            {
                fields.requestId = id;
            }
            // A 5xx whose CLIENT had already hung up is an abandoned navigation, not a server
            // fault: a handler that honours request.signal rejects on disconnect and maps to
            // 500 like anything else, so escalating it burns an error budget on ordinary user
            // behaviour. The signal is read only on this branch - a 2xx never touches the lazy
            // getter - and the event is still recorded, at info, carrying clientGone so it stays
            // countable. It is NOT dropped: the abort may have interrupted real work.
            if (response.status >= 500 && request.signal.aborted)
            {
                logger.info('request abandoned by client', { ...fields, clientGone: true });
            }
            else if (response.status >= 500)
            {
                logger.error('request failed', fields);
            }
            else
            {
                logger.info('request', fields);
            }
        }
    };
}
