/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @internal A Node readable as a response body, owned HERE rather than by `Readable.toWeb`.
 *
 * Node's adapter keeps its `'data'` listener attached after a cancel and enqueues whatever the
 * source emits next onto a controller it has already closed. A cancelled download reaches that
 * state routinely: the adapter destroys the socket, cancels this reader, and a source whose flow
 * was resumed a tick earlier still delivers one more chunk. The enqueue throws synchronously
 * inside the emitter, above every framework catch, so a client that stalls and disconnects
 * mid-download takes the process down with it.
 *
 * So the boundary is written out: one latch closed by cancel, end or error, and nothing touches
 * the controller after it. Backpressure is the adapter's own rule (enqueue, pause when the queue
 * is full, resume on pull), and cancel destroys the source WITH its reason, so a source that
 * distinguishes an abort from a broken pipe still can and its file descriptor is released.
 *
 * This lives in one module because it was fixed in one caller first and the other kept the
 * crash: a compressed download and a static file both cross this boundary, and a rule that
 * exists twice is a rule that gets fixed once.
 */

import type { Readable } from 'node:stream';

/** @internal How one caller wants a truncated body reported. */
export interface WebStreamOptions
{
    /**
     * Builds the error for a source that closed without ending. The default is an unbranded
     * `ERR_STREAM_PREMATURE_CLOSE`, which the error path reads as the server fault a truncated
     * read is; a caller whose truncation means the PEER left supplies a client-fault error
     * instead. It is per-caller because the same event means opposite things: a compressed
     * response stops short because the client went away, a file read stops short because the
     * file or the disk did.
     */
    prematureClose?: () => Error;
}

/** @internal Default: a truncated body is this server's problem, and carries the code the error path classifies on. */
function prematureCloseError(): Error
{
    const premature = new Error('The stream closed before it ended.');
    (premature as { code?: string }).code = 'ERR_STREAM_PREMATURE_CLOSE';
    return premature;
}

/**
 * @internal Wraps `source` as a web stream that cannot enqueue after it settles.
 *
 * @param source - The Node readable to serve. It is paused immediately and driven by `pull`.
 * @param options - Per-caller policy; see {@link WebStreamOptions}.
 * @returns A web stream suitable as a `Response` body.
 */
export function webStreamOf(source: Readable, options: WebStreamOptions = {}): ReadableStream<Uint8Array>
{
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;

    const settle = (fn: () => void): void =>
    {
        if (closed)
        {
            return;
        }
        closed = true;
        source.off('data', onData);
        fn();
    };
    // Named, so the settle path can detach it: a listener still attached after the controller
    // closes is the entire defect.
    function onData(chunk: Buffer): void
    {
        if (closed)
        {
            return;
        }
        // Copied out of the pool, as Node's own adapter does. Not for correctness - neither zlib
        // nor a file read rewrites a region it already emitted - but for retention: an un-copied
        // 28-byte chunk pins the whole pool buffer it was cut from, for as long as it sits in
        // this queue or the socket's.
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0)
        {
            source.pause();
        }
    }

    source.pause();
    source.on('data', onData);
    source.once('end', () => settle(() => controller.close()));
    source.once('error', (error: Error) => settle(() => controller.error(error)));
    // A destroy without `end` truncated the body; a consumer must hear that rather than read a
    // short response as a complete one.
    source.once('close', () => settle(() => controller.error((options.prematureClose ?? prematureCloseError)())));
    // A stream that emits a SECOND error after settling would otherwise reach an emitter with no
    // listener, which is an immediate process exit - the same class this whole function exists to
    // close. Node's adapter keeps a bare listener for it; so does this.
    source.on('error', () => undefined);

    return new ReadableStream<Uint8Array>({
        start(active): void
        {
            controller = active;
        },
        pull(): void
        {
            if (!closed)
            {
                source.resume();
            }
        },
        cancel(reason: unknown): void
        {
            closed = true;
            source.off('data', onData);
            // The reason travels, so a source that distinguishes an abort from a broken pipe
            // still can. Dropping it would answer every cancelled download with the same
            // anonymous teardown.
            source.destroy(reason instanceof Error ? reason : undefined);
        }
    }, new ByteLengthQueuingStrategy({ highWaterMark: source.readableHighWaterMark }));
}
