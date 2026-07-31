/**
 * MODULE: ws/frames - the RFC 6455 frame codec
 *
 * The byte-level heart of the WebSocket implementation: an incremental parser that turns an
 * arbitrary chunking of the TCP stream into frames, and a serializer for the server's own.
 * Everything section 5 of the RFC mandates is enforced HERE, as a typed ProtocolError
 * carrying the close code the connection must die with - the state machine above
 * (socket.ts) never sees a malformed frame:
 *
 *   - RSV bits must be 0 (no extension is ever negotiated)          -> 1002
 *   - reserved opcodes (3-7, 11-15)                                 -> 1002
 *   - control frames: FIN required, payload <= 125 bytes            -> 1002
 *   - client-to-server frames MUST be masked; server frames MUST NOT -> 1002
 *   - lengths MUST use the minimal encoding (a 16-bit field holding
 *     a value under 126 is an attack fingerprint, not sloppiness)   -> 1002
 *   - 64-bit lengths with the high bit set                          -> 1002
 *   - 64-bit lengths beyond the addressable range                   -> 1009
 *   - payloads above the configured cap                             -> 1009
 *
 * The parser retains at most one partial frame of buffered bytes; masked payloads are
 * unmasked in place on a copy, never mutating caller memory.
 *
 * The serializer is held to the same rules on the way OUT: an illegal frame this server
 * emits is worse than one it receives, since a compliant peer answers it by killing the
 * connection with 1002 and the application's own close code is lost.
 */

/** RFC 6455 opcodes. */
export const OPCODE =
{
    continuation: 0x0,
    text: 0x1,
    binary: 0x2,
    close: 0x8,
    ping: 0x9,
    pong: 0xa
} as const;

/** A protocol violation: the connection must close with `code`. */
export class ProtocolError extends Error
{
    public readonly code: number;

    /**
     * Frames that were completely and validly parsed BEFORE the violation, in the same push.
     *
     * They are carried on the error rather than dropped because the alternative made delivery
     * depend on the peer's TCP segmentation: the same bytes in one segment lost them with the
     * local array this call was building, while in two segments an earlier push had already
     * returned them. Whoever handles the error decides what to do with them; the point is that
     * the set is the same either way.
     */
    public readonly frames: readonly Frame[];

    constructor(code: number, message: string, frames: readonly Frame[] = [])
    {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
        this.frames = frames;
    }
}

/** One parsed frame (payload already unmasked). */
export interface Frame
{
    /** Final fragment of the message (RFC 6455 FIN bit). */
    fin: boolean;

    /** The {@link OPCODE} value: continuation, text, binary, close, ping, or pong. */
    opcode: number;

    /** The frame payload, already unmasked. */
    payload: Uint8Array;
}

/** How the codec is used: a server parses masked client frames; a client the reverse. */
export interface ParserOptions
{
    /** 'server' (default): require masked frames. 'client': require unmasked. */
    role?: 'server' | 'client';

    /** Maximum single-frame payload in bytes (default 16 MiB) - the 1009 boundary. */
    maxPayload?: number;
}

const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024;

const EMPTY = new Uint8Array(0);

/**
 * Incremental frame parser: feed it the TCP stream in whatever chunks arrive; it yields
 * complete frames and buffers the remainder. Throws {@link ProtocolError} - after which the
 * parser must be discarded along with the connection.
 *
 * Buffering is a window (`#read`..`#write`) into a growable buffer, never a concatenation
 * per push: reconcatenating made a frame of n bytes arriving in k chunks cost O(n*k) - a
 * 16 MiB upload over 64 KiB reads copied 2 GiB, and over 1400-byte segments blocked the
 * event loop for 30 seconds, starving every other connection on the process.
 */
export class FrameParser
{
    readonly #requireMask: boolean;

    readonly #maxPayload: number;

    #buffer: Uint8Array = EMPTY;

    /** Start of the unconsumed window; bytes below it are parsed frames awaiting reclaim. */
    #read = 0;

    /** End of the unconsumed window; bytes above it are spare capacity. */
    #write = 0;

    /** False while #buffer is a caller's chunk adopted verbatim - never written into. */
    #owned = false;

    /** Window bytes the frame at #read still needs, or 0 when no header has been read yet. */
    #required = 0;

    constructor(options: ParserOptions = {})
    {
        this.#requireMask = (options.role ?? 'server') === 'server';
        this.#maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    }

    /** Feeds bytes; returns every frame completed by them. */
    public push(chunk: Uint8Array): Frame[]
    {
        this.#append(chunk);

        const frames: Frame[] = [];
        for (;;)
        {
            let frame;
            try
            {
                frame = this.#tryParseOne();
            }
            catch (error)
            {
                // Hand the caller what already parsed cleanly. Losing it here is what made
                // delivery depend on the peer's segmentation - see ProtocolError.frames.
                if (error instanceof ProtocolError)
                {
                    throw new ProtocolError(error.code, error.message, frames);
                }
                throw error;
            }
            if (frame === null)
            {
                break;
            }
            frames.push(frame);
        }

        if (this.#read === this.#write)
        {
            // Nothing partial: release the buffer so an idle connection retains no bytes.
            this.#buffer = EMPTY;
            this.#owned = false;
            this.#read = 0;
            this.#write = 0;
        }
        else if (this.#owned && this.#read > this.#buffer.byteLength >>> 1)
        {
            this.#buffer.copyWithin(0, this.#read, this.#write);
            this.#write -= this.#read;
            this.#read = 0;
        }
        return frames;
    }

    /**
     * @internal Adds a chunk to the window: appended in place while capacity allows, else
     * copied into a buffer grown by doubling but never past what the pending frame needs -
     * so a declared-but-unsent length cannot make the parser preallocate for it.
     */
    #append(chunk: Uint8Array): void
    {
        if (chunk.byteLength === 0)
        {
            return;
        }

        const unread = this.#write - this.#read;
        if (unread === 0)
        {
            this.#buffer = chunk;
            this.#owned = false;
            this.#read = 0;
            this.#write = chunk.byteLength;
            return;
        }

        const need = unread + chunk.byteLength;
        if (this.#owned && need <= this.#buffer.byteLength)
        {
            if (this.#write + chunk.byteLength > this.#buffer.byteLength)
            {
                this.#buffer.copyWithin(0, this.#read, this.#write);
                this.#read = 0;
                this.#write = unread;
            }
            this.#buffer.set(chunk, this.#write);
            this.#write += chunk.byteLength;
            return;
        }

        let capacity = Math.max(need, this.#buffer.byteLength * 2);
        if (this.#required > 0 && this.#required < capacity)
        {
            capacity = Math.max(need, this.#required);
        }
        const grown = new Uint8Array(capacity);
        grown.set(this.#buffer.subarray(this.#read, this.#write), 0);
        grown.set(chunk, unread);
        this.#buffer = grown;
        this.#owned = true;
        this.#read = 0;
        this.#write = need;
    }

    /** @internal One frame off the front of the window, or null while incomplete. */
    #tryParseOne(): Frame | null
    {
        const buffer = this.#buffer;
        const base = this.#read;
        const available = this.#write - base;
        if (available < 2)
        {
            this.#required = 2;
            return null;
        }

        // ?? 0 arms are unreachable (available >= 2 was just checked); they satisfy the
        // indexed-access check without a branch in the parser hot path.
        const first = buffer[base] ?? 0;
        const second = buffer[base + 1] ?? 0;
        const fin = (first & 0x80) !== 0;
        const rsv = first & 0x70;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        const lengthField = second & 0x7f;

        if (rsv !== 0)
        {
            throw new ProtocolError(1002, 'RSV bits set without a negotiated extension.');
        }
        if ((opcode >= 0x3 && opcode <= 0x7) || opcode >= 0xb)
        {
            throw new ProtocolError(1002, `Reserved opcode 0x${ opcode.toString(16) }.`);
        }
        const isControl = opcode >= 0x8;
        if (isControl && !fin)
        {
            throw new ProtocolError(1002, 'Control frames must not be fragmented.');
        }
        if (isControl && lengthField > 125)
        {
            throw new ProtocolError(1002, 'Control frames carry at most 125 payload bytes.');
        }
        if (this.#requireMask && !masked)
        {
            throw new ProtocolError(1002, 'Client frames must be masked.');
        }
        if (!this.#requireMask && masked)
        {
            throw new ProtocolError(1002, 'Server frames must not be masked.');
        }

        let offset = 2;
        let payloadLength = lengthField;
        if (lengthField === 126)
        {
            if (available < offset + 2)
            {
                this.#required = offset + 2;
                return null;
            }
            payloadLength = ((buffer[base + offset] ?? 0) << 8) | (buffer[base + offset + 1] ?? 0);
            if (payloadLength < 126)
            {
                throw new ProtocolError(1002, 'Length not minimally encoded.');
            }
            offset += 2;
        }
        else if (lengthField === 127)
        {
            if (available < offset + 8)
            {
                this.#required = offset + 8;
                return null;
            }
            const view = new DataView(buffer.buffer, buffer.byteOffset + base + offset, 8);
            const big = view.getBigUint64(0);
            if ((big & 0x8000_0000_0000_0000n) !== 0n)
            {
                throw new ProtocolError(1002, 'A 64-bit payload length must have its high bit clear.');
            }
            if (big > BigInt(Number.MAX_SAFE_INTEGER))
            {
                throw new ProtocolError(1009, 'Payload length beyond addressable range.');
            }
            payloadLength = Number(big);
            if (payloadLength < 65_536)
            {
                throw new ProtocolError(1002, 'Length not minimally encoded.');
            }
            offset += 8;
        }

        if (payloadLength > this.#maxPayload)
        {
            throw new ProtocolError(1009, `Frame payload of ${ payloadLength } bytes exceeds the ${ this.#maxPayload }-byte limit.`);
        }

        let maskKey: Uint8Array | null = null;
        if (masked)
        {
            if (available < offset + 4)
            {
                this.#required = offset + 4;
                return null;
            }
            maskKey = buffer.subarray(base + offset, base + offset + 4);
            offset += 4;
        }

        if (available < offset + payloadLength)
        {
            this.#required = offset + payloadLength;
            return null;
        }

        // Copy the payload out (unmasking into the copy), then advance past the consumed bytes.
        const payload = new Uint8Array(payloadLength);
        payload.set(buffer.subarray(base + offset, base + offset + payloadLength));
        if (maskKey !== null)
        {
            for (let i = 0; i < payloadLength; i++)
            {
                payload[i] = (payload[i] ?? 0) ^ (maskKey[i & 3] ?? 0);
            }
        }
        this.#read = base + offset + payloadLength;
        this.#required = 0;

        return { fin, opcode, payload };
    }
}

/** The longest reason a close frame can carry: 125 control-frame bytes minus the 2-byte code. */
const MAX_CLOSE_REASON = 123;

/**
 * Serializes one frame. Servers never mask (the RFC forbids it); `mask: true` is the client
 * role, used by tests to speak valid client frames at the parser.
 *
 * An oversized control payload is a RangeError, not a frame: it is this server's own bug,
 * and putting it on the wire would make the peer kill the connection with 1002.
 */
export function serializeFrame(
    opcode: number,
    payload: Uint8Array,
    options: { fin?: boolean; mask?: boolean } = {}
): Uint8Array
{
    const fin = options.fin ?? true;
    const mask = options.mask ?? false;
    const length = payload.byteLength;

    if (opcode >= 0x8 && length > 125)
    {
        throw new RangeError(`A control frame carries at most 125 payload bytes, not ${ length }.`);
    }

    const extended = length > 65_535 ? 8 : length > 125 ? 2 : 0;
    const header = 2 + extended + (mask ? 4 : 0);
    const out = new Uint8Array(header + length);

    out[0] = (fin ? 0x80 : 0) | opcode;
    if (extended === 0)
    {
        out[1] = length;
    }
    else if (extended === 2)
    {
        out[1] = 126;
        out[2] = length >>> 8;
        out[3] = length & 0xff;
    }
    else
    {
        out[1] = 127;
        new DataView(out.buffer).setBigUint64(2, BigInt(length));
    }

    if (mask)
    {
        out[1] |= 0x80;
        const key = out.subarray(2 + extended, 6 + extended);
        crypto.getRandomValues(key);
        for (let i = 0; i < length; i++)
        {
            out[header + i] = (payload[i] ?? 0) ^ (key[i & 3] ?? 0);
        }
    }
    else
    {
        out.set(payload, header);
    }
    return out;
}

/**
 * Close codes RFC 6455 section 7.4.1 and the IANA registry permit on the wire, in either
 * direction: 1004 is reserved, and 1005/1006 name the ABSENCE of a code, so an endpoint
 * that reads or writes them is describing something the protocol cannot carry.
 */
function isWireCloseCode(code: number): boolean
{
    return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
        || (code >= 3000 && code <= 4999);
}

/**
 * Serializes a close frame's payload: a 2-byte code plus an optional UTF-8 reason, truncated
 * on a codepoint boundary to what a control frame can hold. Reasons commonly embed user
 * input, so the length is attacker-influenced and cannot be trusted to fit.
 *
 * 1005/1006 become the empty payload (their meaning, and all the wire can express); any
 * other unsendable code is a RangeError rather than a silent 16-bit truncation - `1000 +
 * 69000` used to reach the peer as 4464.
 */
export function closePayload(code: number, reason = ''): Uint8Array
{
    if (code === 1005 || code === 1006)
    {
        return EMPTY;
    }
    if (!isWireCloseCode(code))
    {
        throw new RangeError(`Close code ${ code } cannot be sent (RFC 6455 section 7.4.1).`);
    }
    const out = new Uint8Array(2 + MAX_CLOSE_REASON);
    out[0] = code >>> 8;
    out[1] = code & 0xff;
    // encodeInto never emits a partial codepoint, so its cut is already character-aligned.
    const { written } = new TextEncoder().encodeInto(reason, out.subarray(2));
    return out.subarray(0, 2 + written);
}

/**
 * Validates a RECEIVED close frame payload and extracts its code + reason.
 * A 1-byte payload, an invalid wire code, or a non-UTF-8 reason are protocol errors.
 */
export function parseClosePayload(payload: Uint8Array): { code: number; reason: string }
{
    if (payload.byteLength === 0)
    {
        return { code: 1005, reason: '' }; // "no status received" - internal only, never sent
    }
    if (payload.byteLength === 1)
    {
        throw new ProtocolError(1002, 'A close payload cannot be a single byte.');
    }
    const code = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
    if (!isWireCloseCode(code))
    {
        throw new ProtocolError(1002, `Invalid close code ${ code } on the wire.`);
    }
    let reason: string;
    try
    {
        reason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
    }
    catch
    {
        throw new ProtocolError(1007, 'Close reason is not valid UTF-8.');
    }
    return { code, reason };
}
