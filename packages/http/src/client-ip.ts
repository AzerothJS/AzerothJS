/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The real client address, with an explicit trust boundary.
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
 *
 * This module also owns the selection rule every other forwarded-header reader shares, and
 * there are TWO of them because the headers do not accumulate alike: `X-Forwarded-For` is
 * APPENDED per hop, while `X-Forwarded-Proto` and `X-Forwarded-Host` are REPLACED by each
 * proxy that writes them. Reading a replaced header by hop index walks off the end of the
 * single entry a proxy chain actually leaves, so the two shapes get two functions.
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

/** @internal The entries of a comma-joined forwarded header, oldest first; repeated header
 * lines are one chain. Empty entries are dropped so a stray comma cannot shift the indexing. */
function forwardedChain(value: string | string[] | undefined): string[]
{
    if (value === undefined)
    {
        return [];
    }
    return (Array.isArray(value) ? value.join(',') : value)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
}

/**
 * The entry of an APPENDED forwarded header (`X-Forwarded-For`) that `trustedHops` proxies
 * vouch for: that many from the RIGHT end, because each hop appends and the left end is
 * client-supplied fiction. Undefined when the chain is too short to have traversed the
 * proxies claimed.
 */
export function appendedForwardedEntry(value: string | string[] | undefined, trustedHops: number): string | undefined
{
    const chain = forwardedChain(value);
    const index = chain.length - trustedHops;
    return index < 0 || index >= chain.length ? undefined : chain[index];
}

/**
 * The believable value of a REPLACED forwarded header (`X-Forwarded-Proto`,
 * `X-Forwarded-Host`), which nginx, HAProxy, Traefik, ALB and Cloudflare each SET rather
 * than append: a chain of any length leaves ONE entry, so no hop count applies. The entry
 * taken is the last written, which is the whole value in that normal shape. More than one
 * entry means an untrusted client sent a value and a proxy wrote alongside it - the
 * host-poisoning shape - and the proxy can only have written after what it received, so the
 * right-most entry is still the trusted one. Undefined when the header is absent or empty.
 */
export function replacedForwardedValue(value: string | string[] | undefined): string | undefined
{
    const chain = forwardedChain(value);
    return chain.length === 0 ? undefined : chain[chain.length - 1];
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
    return appendedForwardedEntry(raw ?? undefined, options.trustedHops ?? 1) ?? peer;
}

/** The longest key {@link ipBucket} emits; forwarded-header garbage is truncated to this. */
const MAX_BUCKET_KEY = 64;

/** @internal The 8 hextets of an IPv6 address, or null when it does not parse. An embedded
 * dotted-quad tail (`::ffff:1.2.3.4`, `2001:db8::192.0.2.1`) is rewritten to its two
 * hextets first, so every spelling of one address parses to the same eight numbers. */
function ipv6Hextets(bare: string): number[] | null
{
    let address = bare;
    const dotted = /^(.+:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(address);
    if (dotted?.[1] !== undefined && dotted[2] !== undefined)
    {
        const [a, b, c, d] = dotted[2].split('.').map(Number);
        if (a === undefined || b === undefined || c === undefined || d === undefined
            || a > 255 || b > 255 || c > 255 || d > 255)
        {
            return null;
        }
        address = `${ dotted[1] }${ (a * 256 + b).toString(16) }:${ (c * 256 + d).toString(16) }`;
    }
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

/** @internal The bare address inside an authority. A forwarded header may name one host as
 * `1.2.3.4:5678`, `[::1]:443`, `[fe80::1%eth0]` or plain - the port and the zone identify a
 * connection, not a host, and brackets are only IPv6 punctuation, so all of it comes off
 * before bucketing or one host would hold several buckets. */
function bareHost(authority: string): string
{
    let host = authority;
    if (host.startsWith('['))
    {
        const close = host.indexOf(']');
        host = close === -1 ? host.slice(1) : host.slice(1, close);
    }
    else
    {
        const colon = host.indexOf(':');
        // A single colon cannot be IPv6 (which needs at least two), so it separates a port.
        if (colon !== -1 && colon === host.lastIndexOf(':') && /^\d{1,5}$/.test(host.slice(colon + 1)))
        {
            host = host.slice(0, colon);
        }
    }
    const zone = host.indexOf('%');
    return zone === -1 ? host : host.slice(0, zone);
}

/**
 * Normalizes an address into a rate-limit bucket key. IPv4 buckets per host, but IPv6 is
 * truncated to `prefixBits` (default 64): a /64 is the standard single-customer allocation,
 * inside which one host can hop across 2^64 addresses for free - keying on the full /128
 * hands every such host an unlimited supply of fresh buckets. Brackets, port and zone are
 * stripped first, IPv4-mapped IPv6 collapses to its IPv4 form, and anything unparseable
 * becomes its own bucket, length-capped so a forwarded-header key cannot bloat the store.
 */
export function ipBucket(address: string, prefixBits = 64): string
{
    const bare = bareHost(address);
    if (!bare.includes(':'))
    {
        return bare.slice(0, MAX_BUCKET_KEY);
    }
    const hextets = ipv6Hextets(bare);
    if (hextets === null)
    {
        return bare.slice(0, MAX_BUCKET_KEY);
    }
    // Detected on the PARSED hextets, so the compressed, expanded-zero, and hex-pair
    // spellings of one mapped address all land in the same IPv4 bucket.
    const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff
        && h6 !== undefined && h7 !== undefined)
    {
        return `${ h6 >> 8 }.${ h6 & 0xff }.${ h7 >> 8 }.${ h7 & 0xff }`;
    }
    const bits = Math.min(Math.max(Math.trunc(prefixBits), 0), 128);
    const masked = hextets.map((hextet, index) =>
    {
        const keep = Math.min(16, Math.max(0, bits - index * 16));
        return ((hextet >> (16 - keep)) << (16 - keep)) & 0xffff;
    });
    return `${ masked.map((hextet) => hextet.toString(16)).join(':') }/${ bits }`;
}
