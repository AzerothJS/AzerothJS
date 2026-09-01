/**
 * Ports that HTTP CLIENTS refuse to connect to.
 *
 * Binding is not the problem - the OS hands these out for port 0 like any other - but fetch,
 * Deno and every browser enforce a blocked list, so a server that lands on one is unreachable
 * by its own test. That failure reads exactly like a broken contract ("bad port", "Requests to
 * port 6668 are blocked") and invites someone to fix working code, so a test that binds
 * ephemerally rebinds off these instead.
 *
 * The list is the shared unsafe-port set (WHATWG fetch "bad port" list); the entries below the
 * ephemeral range are kept because an OS may be configured to allocate from anywhere.
 */
export const BLOCKED_PORTS: readonly number[] = [
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
    102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
    427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
    989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
    6666, 6667, 6668, 6669, 6679, 6697, 10080
];

const BLOCKED = new Set(BLOCKED_PORTS);

/** Whether a client would refuse to connect to `port`. */
export function isBlockedPort(port: number): boolean
{
    return BLOCKED.has(port);
}

/**
 * Binds through `open` until it lands on a port a client will actually talk to.
 *
 * `close` is called for every rejected attempt, so a discarded server never leaks its handle.
 */
export async function bindReachable<T>(
    open: () => Promise<T>,
    portOf: (bound: T) => number,
    close: (bound: T) => Promise<void>
): Promise<T>
{
    for (let attempt = 0; attempt < 8; attempt++)
    {
        const bound = await open();
        if (!isBlockedPort(portOf(bound)))
        {
            return bound;
        }
        await close(bound);
    }
    throw new Error('could not bind a client-reachable ephemeral port in 8 attempts');
}
