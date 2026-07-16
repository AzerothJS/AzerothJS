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
