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
 *   - payloads above the configured cap                             -> 1009
 *
 * The parser retains at most one partial frame of buffered bytes; masked payloads are
 * unmasked in place on a copy, never mutating caller memory.
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

    constructor(code: number, message: string)
    {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
    }
}

/** One parsed frame (payload already unmasked). */
export interface Frame
{
    fin: boolean;
    opcode: number;
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

/**
 * Incremental frame parser: feed it the TCP stream in whatever chunks arrive; it yields
 * complete frames and buffers the remainder. Throws {@link ProtocolError} - after which the
 * parser must be discarded along with the connection.
 */
export class FrameParser
{
    readonly #requireMask: boolean;

    readonly #maxPayload: number;

    #buffer: Uint8Array = new Uint8Array(0);

    constructor(options: ParserOptions = {})
    {
        this.#requireMask = (options.role ?? 'server') === 'server';
        this.#maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    }

    /** Feeds bytes; returns every frame completed by them. */
    public push(chunk: Uint8Array): Frame[]
    {
        // One concatenation per push keeps the hot path simple; a parser holding a partial
        // frame holds only that frame's bytes.
        if (this.#buffer.byteLength === 0)
        {
            this.#buffer = chunk;
        }
        else
        {
            const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
            merged.set(this.#buffer, 0);
            merged.set(chunk, this.#buffer.byteLength);
            this.#buffer = merged;
        }

        const frames: Frame[] = [];
        for (;;)
        {
            const frame = this.#tryParseOne();
            if (frame === null)
            {
                return frames;
            }
            frames.push(frame);
        }
    }

    /** @internal One frame off the front of the buffer, or null while incomplete. */
    #tryParseOne(): Frame | null
    {
        const buffer = this.#buffer;
        if (buffer.byteLength < 2)
        {
            return null;
        }

        // ?? 0 arms are unreachable (byteLength >= 2 was just checked); they satisfy the
        // indexed-access check without a branch in the parser hot path.
        const first = buffer[0] ?? 0;
        const second = buffer[1] ?? 0;
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
            if (buffer.byteLength < offset + 2)
            {
                return null;
            }
            payloadLength = ((buffer[offset] ?? 0) << 8) | (buffer[offset + 1] ?? 0);
            if (payloadLength < 126)
            {
                throw new ProtocolError(1002, 'Length not minimally encoded.');
            }
            offset += 2;
        }
        else if (lengthField === 127)
        {
            if (buffer.byteLength < offset + 8)
            {
                return null;
            }
            const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
            const big = view.getBigUint64(0);
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
            if (buffer.byteLength < offset + 4)
            {
                return null;
            }
            maskKey = buffer.subarray(offset, offset + 4);
            offset += 4;
        }

        if (buffer.byteLength < offset + payloadLength)
        {
            return null;
        }

        // Copy the payload out (unmasking into the copy), then release the consumed bytes.
        const payload = new Uint8Array(payloadLength);
        payload.set(buffer.subarray(offset, offset + payloadLength));
        if (maskKey !== null)
        {
            for (let i = 0; i < payloadLength; i++)
            {
                payload[i] = (payload[i] ?? 0) ^ (maskKey[i & 3] ?? 0);
            }
        }
        this.#buffer = buffer.byteLength === offset + payloadLength
            ? new Uint8Array(0)
            : buffer.slice(offset + payloadLength);

        return { fin, opcode, payload };
    }
}

/**
 * Serializes one frame. Servers never mask (the RFC forbids it); `mask: true` is the client
 * role, used by tests to speak valid client frames at the parser.
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

/** Serializes a close frame's payload: a 2-byte code plus an optional UTF-8 reason. */
export function closePayload(code: number, reason = ''): Uint8Array
{
    const reasonBytes = new TextEncoder().encode(reason);
    const out = new Uint8Array(2 + reasonBytes.byteLength);
    out[0] = code >>> 8;
    out[1] = code & 0xff;
    out.set(reasonBytes, 2);
    return out;
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
    const valid = (code >= 1000 && code <= 1003)
        || (code >= 1007 && code <= 1011)
        || (code >= 3000 && code <= 4999);
    if (!valid)
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
