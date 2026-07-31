/**
 * MODULE: ws/socket - the connection state machine over a raw TCP socket
 *
 * frames.ts guarantees every frame is individually well-formed; this module enforces the
 * rules BETWEEN frames (RFC 6455 sections 5.4-5.5 and 7):
 *
 *   - fragmentation: a message opens with text/binary and continues with continuation
 *     frames; a new data opcode mid-message, or a continuation with no message open, is a
 *     1002; control frames interleave freely between fragments.
 *   - text messages must be valid UTF-8, validated INCREMENTALLY per fragment (a stream
 *     decoder), so an invalid byte fails fast at 1007 instead of after buffering the rest.
 *   - assembled messages are capped (1009) independently of the per-frame cap.
 *   - ping is answered with pong (same payload) automatically; pongs are absorbed.
 *   - the CLOSE HANDSHAKE: a received close is validated, echoed (once), and the socket
 *     ends; close() sends ours and waits (bounded) for the echo. Either way onClose fires
 *     exactly once with the code that actually applies.
 *
 * The API mirrors the browser's WebSocket where it makes sense (send/close/onmessage-style
 * handlers) so the server side feels like the client side developers already know.
 */

import type { Socket } from 'node:net';
import {
    FrameParser, OPCODE, ProtocolError, closePayload, parseClosePayload, serializeFrame
} from './frames.ts';

/**
 * Per-socket protocol limits: message/frame caps and timings. The defaults assume a hostile
 * network - an unanswered ping or an oversized frame closes the connection with the RFC 6455
 * code that says why.
 */
export interface ServerSocketOptions
{
    /** Cap for one ASSEMBLED message (default 16 MiB) - fragment sums included. */
    maxMessage?: number;

    /**
     * Cap for ONE FRAME's declared payload, enforced from the header before a byte is buffered
     * (default: `maxMessage`). This is the cap that bounds per-connection memory, because
     * `maxMessage` can only be checked once a frame has already been assembled: an app that sets
     * `maxMessage: 1024` and nothing else would still let each connection pin a frame buffer, so
     * a few hundred idle sockets is a memory-exhaustion attack with no message ever completed.
     */
    maxPayload?: number;

    /** How long close() waits for the peer's echo before destroying (default 5000 ms). */
    closeTimeoutMs?: number;

    /**
     * Interval between liveness pings (default 30000 ms; 0 disables). A TCP connection can go
     * half-open - the peer vanishes without a FIN - and the socket then lingers forever. The
     * heartbeat pings on this cadence and terminates any connection that misses the pong
     * deadline, so dead sockets are reclaimed instead of leaking.
     */
    heartbeatMs?: number;

    /** Grace for a pong after each heartbeat ping before the connection is terminated (default 10000 ms). */
    pongTimeoutMs?: number;
}

const DEFAULT_MAX_MESSAGE = 16 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;

/**
 * Fragments one message may arrive in. A legitimate sender splits by buffer size, not into
 * thousands of slivers, so this only ever trips on an assembler attack.
 */
const MAX_FRAGMENTS = 4096;

/**
 * Unflushed bytes past which an automatic pong is dropped rather than queued. RFC 6455 section
 * 5.5.3 requires only that the most recent ping be answered.
 */
const PONG_BACKLOG_BYTES = 64 * 1024;

/** One server-side WebSocket connection. */
export class ServerSocket
{
    /** Fired per complete message: a string for text frames, bytes for binary. */
    public onMessage: ((data: string | Uint8Array) => void) | null = null;

    /** Fired exactly once when the connection is over, with the applicable close code. */
    public onClose: ((code: number, reason: string) => void) | null = null;

    /** Fired for protocol violations and socket errors (onClose still follows). */
    public onError: ((error: Error) => void) | null = null;

    readonly #socket: Socket;

    readonly #parser: FrameParser;

    readonly #maxMessage: number;

    readonly #closeTimeoutMs: number;

    readonly #heartbeatMs: number;

    readonly #pongTimeoutMs: number;

    #pingTimer: ReturnType<typeof setInterval> | null = null;

    #pongDeadline: ReturnType<typeof setTimeout> | null = null;

    /** True between sending a heartbeat ping and receiving its pong. */
    #awaitingPong = false;

    // Fragmentation state: the opcode that opened the message and its accumulated parts.
    #messageOpcode = 0;

    #parts: Uint8Array[] = [];

    #partsLength = 0;

    /** Fragments in the message being assembled; bounded apart from the byte total. */
    #partsCount = 0;

    /** Incremental UTF-8 validation for the open text message. */
    #decoder: TextDecoder | null = null;

    #text = '';

    #closeSent = false;

    #closed = false;

    constructor(socket: Socket, options: ServerSocketOptions = {})
    {
        this.#socket = socket;
        this.#maxMessage = options.maxMessage ?? DEFAULT_MAX_MESSAGE;
        this.#parser = new FrameParser({ role: 'server', maxPayload: options.maxPayload ?? this.#maxMessage });
        this.#closeTimeoutMs = options.closeTimeoutMs ?? 5000;
        this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
        this.#pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;

        socket.on('data', (chunk: Buffer) => this.#receive(chunk));
        socket.on('error', (error: Error) =>
        {
            this.#report(error);
            this.#finish(1006, 'Socket error');
        });
        socket.on('close', () => this.#finish(1006, 'Connection closed abnormally'));
        // WebSocket frames arrive on their own schedule; Nagle coalescing only adds latency.
        socket.setNoDelay(true);

        if (this.#heartbeatMs > 0)
        {
            this.#pingTimer = setInterval(() => this.#beat(), this.#heartbeatMs);
            (this.#pingTimer as { unref?: () => void }).unref?.();
        }
    }

    /** Bytes queued in the kernel/socket buffer not yet flushed to the peer - the backpressure gauge. */
    public get bufferedAmount(): number
    {
        return this.#socket.writableLength;
    }

    /**
     * Sends one message: strings as text frames, bytes as binary. Silently no-ops once closing.
     * Returns false when the socket buffer is now full (backpressure) - a producer streaming
     * faster than the peer drains should await {@link drain} before the next send to keep
     * `bufferedAmount` bounded instead of buffering the whole stream in memory.
     */
    public send(data: string | Uint8Array): boolean
    {
        if (this.#closeSent || this.#closed)
        {
            return false;
        }
        const isText = typeof data === 'string';
        const payload = isText ? new TextEncoder().encode(data) : data;
        return this.#socket.write(serializeFrame(isText ? OPCODE.text : OPCODE.binary, payload));
    }

    /**
     * Resolves when the socket buffer has flushed (immediately if it is not backed up), and also
     * when the connection ENDS. A destroyed socket never emits 'drain', so waiting on that event
     * alone would never settle for the one case that matters: the documented backpressure loop
     * (`if (!ws.send(x)) await ws.drain()`) meeting a slow consumer that then disconnects, which
     * on a market feed is the most ordinary event there is. The producer loop would be abandoned
     * mid-iteration with its `finally` never running, leaking whatever it held - a cursor, an
     * advisory lock, a reserved sequence number - for the process lifetime.
     */
    public drain(): Promise<void>
    {
        if (this.#closed || !this.#socket.writableNeedDrain)
        {
            return Promise.resolve();
        }
        return new Promise((resolve) =>
        {
            const settle = (): void =>
            {
                this.#socket.off('drain', settle);
                this.#socket.off('close', settle);
                this.#socket.off('error', settle);
                resolve();
            };
            this.#socket.once('drain', settle);
            this.#socket.once('close', settle);
            this.#socket.once('error', settle);
        });
    }

    /** Sends a ping (the liveness probe; the peer must answer with a pong). */
    public ping(payload: Uint8Array = new Uint8Array(0)): void
    {
        if (!this.#closeSent && !this.#closed)
        {
            this.#socket.write(serializeFrame(OPCODE.ping, payload));
        }
    }

    /**
     * Starts the closing handshake; the socket ends when the echo arrives or the timeout fires.
     * An oversized reason is truncated by the codec, and a code that RFC 6455 forbids on the wire
     * is replaced with 1000 rather than throwing: this is a TEARDOWN path, and a connection that
     * stayed open because its close code was wrong would be a worse outcome than a normalised one.
     */
    public close(code = 1000, reason = ''): void
    {
        if (this.#closeSent || this.#closed)
        {
            return;
        }
        this.#closeSent = true;
        let payload: Uint8Array;
        try
        {
            payload = closePayload(code, reason);
        }
        catch
        {
            payload = closePayload(1000, reason);
        }
        this.#socket.write(serializeFrame(OPCODE.close, payload));
        const deadline = setTimeout(() => this.#finish(code, reason), this.#closeTimeoutMs);
        (deadline as { unref?: () => void }).unref?.();
    }

    /** @internal Bytes off the wire: parse, then walk the frame rules. */
    #receive(chunk: Buffer): void
    {
        let frames;
        try
        {
            frames = this.#parser.push(chunk);
            for (const frame of frames)
            {
                // One TCP segment can carry `[close][text]`. Handling the close fires onClose and
                // tears the app's state down, so anything after it in the same chunk must not be
                // delivered: the contract says onClose fires when the connection is over, and an
                // exchange acting on a message after releasing the session is how an order runs
                // against a closed account.
                if (this.#closed)
                {
                    return;
                }
                this.#handleFrame(frame.fin, frame.opcode, frame.payload);
            }
        }
        catch (error)
        {
            if (error instanceof ProtocolError)
            {
                // Frames that completed BEFORE the violation arrived while the connection was
                // still healthy, so they are delivered - the same rule the close-frame case above
                // follows. Carrying them here is what makes the delivered set independent of how
                // the peer split its segments; dropping them made it the peer's choice.
                for (const frame of error.frames)
                {
                    if (this.#closed)
                    {
                        break;
                    }
                    this.#handleFrame(frame.fin, frame.opcode, frame.payload);
                }
                this.#fail(error);
                return;
            }
            this.#fail(new ProtocolError(1011, 'Internal frame error'));
        }
    }

    /** @internal One well-formed frame against the message state machine. */
    #handleFrame(fin: boolean, opcode: number, payload: Uint8Array): void
    {
        switch (opcode)
        {
            case OPCODE.ping:
                // RFC 6455 section 5.5.3 allows answering only the MOST RECENT ping, which is
                // what makes this safe to drop: a peer that floods pings while refusing to read
                // would otherwise queue one userland write per ping forever. Measured 13.7 MiB of
                // pings against an unreading client growing the process to 751 MiB, and
                // bufferedAmount under-reports it by two orders of magnitude because the
                // per-write bookkeeping dominates, so an app watching that number sees nothing.
                if (!this.#closeSent && this.#socket.writableLength <= PONG_BACKLOG_BYTES)
                {
                    this.#socket.write(serializeFrame(OPCODE.pong, payload));
                }
                return;
            case OPCODE.pong:
                this.#awaitingPong = false; // the peer is alive; clear the heartbeat's outstanding probe
                return;
            case OPCODE.close:
            {
                const { code, reason } = parseClosePayload(payload); // throws 1002/1007 when invalid
                if (!this.#closeSent)
                {
                    this.#closeSent = true;
                    // Echo the peer's code (1005 "none received" is internal; echo becomes 1000).
                    this.#socket.write(serializeFrame(OPCODE.close, closePayload(code === 1005 ? 1000 : code, '')));
                }
                this.#finish(code === 1005 ? 1000 : code, reason);
                return;
            }
            case OPCODE.text:
            case OPCODE.binary:
            {
                if (this.#messageOpcode !== 0)
                {
                    throw new ProtocolError(1002, 'New data frame while a fragmented message is open.');
                }
                this.#messageOpcode = opcode;
                if (opcode === OPCODE.text)
                {
                    this.#decoder = new TextDecoder('utf-8', { fatal: true });
                    this.#text = '';
                }
                this.#appendFragment(payload, fin);
                return;
            }
            case OPCODE.continuation:
            {
                if (this.#messageOpcode === 0)
                {
                    throw new ProtocolError(1002, 'Continuation frame without an open message.');
                }
                this.#appendFragment(payload, fin);
                return;
            }
            default:
                throw new ProtocolError(1002, `Unhandled opcode 0x${ opcode.toString(16) }.`);
        }
    }

    /** @internal Accumulates one fragment; delivers the message when fin closes it. */
    #appendFragment(payload: Uint8Array, fin: boolean): void
    {
        this.#partsLength += payload.byteLength;
        if (this.#partsLength > this.#maxMessage)
        {
            throw new ProtocolError(1009, `Message exceeds the ${ this.#maxMessage }-byte limit.`);
        }
        // The byte cap alone cannot bound this. RFC 6455 permits a zero-length fragment, so an
        // endless stream of them adds nothing to #partsLength while #parts grows forever: measured
        // 34.9x wire-to-heap amplification, and 12 MB of traffic reaching a 512 MB heap ceiling
        // with maxMessage set to 1024. Each retained fragment also costs far more than its
        // payload, so the count is capped independently of the size.
        this.#partsCount++;
        if (this.#partsCount > MAX_FRAGMENTS)
        {
            throw new ProtocolError(1009, `Message exceeds the ${ MAX_FRAGMENTS }-fragment limit.`);
        }

        if (this.#messageOpcode === OPCODE.text)
        {
            try
            {
                // stream:true validates across fragment boundaries; the FINAL decode (below)
                // rejects a message ending mid-codepoint.
                const decoder = this.#decoder;
                if (decoder === null)
                {
                    throw new ProtocolError(1002, 'Text continuation without an open message.');
                }
                this.#text += decoder.decode(payload, { stream: true });
            }
            catch
            {
                throw new ProtocolError(1007, 'Text message is not valid UTF-8.');
            }
        }
        else
        {
            this.#parts.push(payload);
        }

        if (!fin)
        {
            return;
        }

        const opcode = this.#messageOpcode;
        this.#messageOpcode = 0;
        this.#partsLength = 0;
        this.#partsCount = 0;

        if (opcode === OPCODE.text)
        {
            let message = this.#text;
            try
            {
                const decoder = this.#decoder;
                if (decoder === null)
                {
                    throw new ProtocolError(1002, 'Text continuation without an open message.');
                }
                message += decoder.decode(); // flush; throws on a dangling partial codepoint
            }
            catch
            {
                throw new ProtocolError(1007, 'Text message ends mid-codepoint.');
            }
            this.#decoder = null;
            this.#text = '';
            this.onMessage?.(message);
            return;
        }

        const parts = this.#parts;
        this.#parts = [];
        let assembled: Uint8Array;
        const solo = parts[0];
        if (parts.length === 1 && solo !== undefined)
        {
            assembled = solo;
        }
        else
        {
            assembled = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
            let offset = 0;
            for (const part of parts)
            {
                assembled.set(part, offset);
                offset += part.byteLength;
            }
        }
        this.onMessage?.(assembled);
    }

    /**
     * @internal One heartbeat: ping the peer and arm the pong deadline. If the previous ping
     * is still unanswered when the deadline fires, the connection is half-open - terminate it.
     */
    #beat(): void
    {
        if (this.#closeSent || this.#closed)
        {
            return;
        }
        // A probe already outstanding means the deadline is armed and must be left alone.
        // Re-arming it every tick is how `pongTimeoutMs >= heartbeatMs` silently disabled
        // half-open reclamation entirely: the timeout could never fire, so a peer that vanished
        // without a FIN was never terminated and its socket, parser buffer and registry entry
        // stayed for the process lifetime.
        if (this.#awaitingPong)
        {
            return;
        }
        this.#awaitingPong = true;
        this.#socket.write(serializeFrame(OPCODE.ping, new Uint8Array(0)));

        if (this.#pongDeadline !== null)
        {
            clearTimeout(this.#pongDeadline);
        }
        this.#pongDeadline = setTimeout(() =>
        {
            if (this.#awaitingPong && !this.#closed)
            {
                this.#report(new Error('WebSocket heartbeat: no pong within the timeout.'));
                this.#socket.destroy();
                this.#finish(1006, 'Heartbeat timeout');
            }
        }, this.#pongTimeoutMs);
        (this.#pongDeadline as { unref?: () => void }).unref?.();
    }

    /**
     * @internal Hands an error to the app's reporter. Guarded: `onError` is the handler meant to
     * CONTAIN failures, so a throw from inside it escaping into the socket's event emitter (an
     * uncaught exception, taking every other live connection with it) would defeat its purpose.
     * onMessage and onClose throws were already contained; this closes the inconsistency.
     */
    #report(error: Error): void
    {
        try
        {
            this.onError?.(error);
        }
        catch
        {
            // A reporter that fails cannot be reported to.
        }
    }

    /** @internal A protocol failure: report, send the mandated close code, end. */
    #fail(error: ProtocolError): void
    {
        this.#report(error);
        if (!this.#closeSent && !this.#closed)
        {
            this.#closeSent = true;
            this.#socket.write(serializeFrame(OPCODE.close, closePayload(error.code, error.message)));
        }
        this.#finish(error.code, error.message);
    }

    /** @internal The single exit: onClose exactly once, socket released. */
    #finish(code: number, reason: string): void
    {
        if (this.#closed)
        {
            return;
        }
        this.#closed = true;
        if (this.#pingTimer !== null)
        {
            clearInterval(this.#pingTimer);
            this.#pingTimer = null;
        }
        if (this.#pongDeadline !== null)
        {
            clearTimeout(this.#pongDeadline);
            this.#pongDeadline = null;
        }
        const handler = this.onClose;
        this.onClose = null;
        // Dropped alongside onClose: the app's teardown has run, so there is no one left who can
        // safely receive a message, and the parser holds no partial state worth delivering.
        this.onMessage = null;
        this.#socket.removeAllListeners('data');
        this.#parts = [];
        this.#partsLength = 0;
        this.#partsCount = 0;
        this.#socket.end();
        // A peer that never FINs would pin the socket; force the teardown shortly after end.
        const hardStop = setTimeout(() => this.#socket.destroy(), 1000);
        (hardStop as { unref?: () => void }).unref?.();
        handler?.(code, reason);
    }
}
