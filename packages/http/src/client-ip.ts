/**
 * MODULE: http/client-ip - the real client address, with an explicit trust boundary
 *
 * `X-Forwarded-For` is client-controlled: a request that reaches the server directly can put
 * anything in it. Trusting it blindly (the Express `req.ip` footgun) lets a caller spoof its
 * own address and slip rate limits or audit logs. So the default here is the TCP peer only -
 * the one address a client cannot forge. You opt into the header by declaring how many proxies
 * you actually run in front of the server, and only that many entries are believed.
 *
 * `trustedHops` counts the proxies between the client and this process, the direct peer
 * included. Each appends the address it received from, so with N trusted proxies the real
 * client sits N entries from the right of the header. Fewer entries than that means the chain
 * did not traverse the proxies you claimed - the header is not trusted and the peer is returned.
 */

import { socketAddress, type FastCapabilities } from './body.ts';

/**
 * Options for {@link clientIp}: whether to read forwarding headers at all (`trustProxy`) and
 * how many proxy hops are YOURS (`trustedHops`) - the address is picked from the right end of
 * `X-Forwarded-For`, because the left end is client-supplied fiction.
 */
export interface ClientIpOptions
{
    /** Believe the forwarded-for header (default false - peer address only). */
    trustProxy?: boolean;

    /** How many proxies you run in front of this server, the direct peer included (default 1). */
    trustedHops?: number;

    /** The forwarding header to read (default `x-forwarded-for`). */
    header?: string;
}

/** @internal The TCP peer address from the adapter capability, or undefined off-socket. */
function peerAddress(request: Request): string | undefined
{
    const capability = (request as FastCapabilities)[socketAddress];
    if (typeof capability !== 'function')
    {
        return undefined;
    }
    return capability.call(request) ?? undefined;
}

/**
 * The client's IP address. Without `trustProxy` this is the unspoofable TCP peer; with it, the
 * correct entry from the forwarding header per the declared `trustedHops`, falling back to the
 * peer when the header is absent or too short to trust. May be undefined when no socket backs
 * the request (an in-process `app.handle` test) and no trusted header is present.
 */
export function clientIp(request: Request, options: ClientIpOptions = {}): string | undefined
{
    const peer = peerAddress(request);
    if (options.trustProxy !== true)
    {
        return peer;
    }

    const raw = request.headers.get(options.header ?? 'x-forwarded-for');
    if (raw === null)
    {
        return peer;
    }
    const chain = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
    const index = chain.length - (options.trustedHops ?? 1);
    if (index < 0 || index >= chain.length)
    {
        return peer; // the chain is shorter than the trusted-proxy count - do not trust it
    }
    return chain[index];
}

/** The longest key {@link ipBucket} emits; forwarded-header garbage is truncated to this. */
const MAX_BUCKET_KEY = 64;

/** @internal The 8 hextets of an IPv6 address, or null when it does not parse. */
function ipv6Hextets(address: string): number[] | null
{
    const doubleColon = address.indexOf('::');
    if (doubleColon !== address.lastIndexOf('::'))
    {
        return null;
    }
    const parse = (part: string): number[] | null =>
    {
        if (part === '')
        {
            return [];
        }
        const hextets: number[] = [];
        for (const piece of part.split(':'))
        {
            if (!/^[0-9A-Fa-f]{1,4}$/.test(piece))
            {
                return null;
            }
            hextets.push(parseInt(piece, 16));
        }
        return hextets;
    };
    if (doubleColon === -1)
    {
        const hextets = parse(address);
        return hextets !== null && hextets.length === 8 ? hextets : null;
    }
    const head = parse(address.slice(0, doubleColon));
    const tail = parse(address.slice(doubleColon + 2));
    if (head === null || tail === null || head.length + tail.length > 7)
    {
        return null;
    }
    return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * Normalizes an address into a rate-limit bucket key. IPv4 buckets per host, but IPv6 is
 * truncated to `prefixBits` (default 64): a /64 is the standard single-customer allocation,
 * inside which one host can hop across 2^64 addresses for free - keying on the full /128
 * hands every such host an unlimited supply of fresh buckets. IPv4-mapped IPv6 collapses to
 * its IPv4 form, and anything unparseable becomes its own bucket, length-capped so a
 * forwarded-header key cannot bloat the store.
 */
export function ipBucket(address: string, prefixBits = 64): string
{
    const zone = address.indexOf('%');
    const bare = zone === -1 ? address : address.slice(0, zone);
    if (!bare.includes(':'))
    {
        return bare.slice(0, MAX_BUCKET_KEY);
    }
    const mapped = /^::[Ff]{4}:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
    if (mapped?.[1] !== undefined)
    {
        return mapped[1];
    }
    const hextets = ipv6Hextets(bare);
    if (hextets === null)
    {
        return bare.slice(0, MAX_BUCKET_KEY);
    }
    const bits = Math.min(Math.max(Math.trunc(prefixBits), 0), 128);
    const masked = hextets.map((hextet, index) =>
    {
        const keep = Math.min(16, Math.max(0, bits - index * 16));
        return ((hextet >> (16 - keep)) << (16 - keep)) & 0xffff;
    });
    return `${ masked.map((hextet) => hextet.toString(16)).join(':') }/${ bits }`;
}
