/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `serve` / `serveH2c` for tests, on a port a client will actually dial.
 *
 * An ephemeral bind can land on the WHATWG unsafe-port list, and does often enough that a full
 * suite run hits it: `fetch` then refuses with "bad port" and the failure reads as a broken
 * server contract. The OS hands those ports out for port 0 like any other, so the adapter -
 * which is asked for a port and must return the one it got - is left alone and the retry lives
 * here, at the one door tests bind through. An EXPLICIT port passes straight through: a test
 * naming a port means it.
 */

import { serve as bindServe, serveH2c as bindServeH2c } from '../../src/adapter-node.ts';
import { bindReachable } from './ports.ts';

export type { Served } from '../../src/adapter-node.ts';

/** Whether the caller left the port to the OS - the only case worth retrying. */
function ephemeral(options: { port?: number } | undefined): boolean
{
    return options?.port === undefined || options.port === 0;
}

export async function serve(...args: Parameters<typeof bindServe>): ReturnType<typeof bindServe>
{
    if (!ephemeral(args[1]))
    {
        return bindServe(...args);
    }
    return bindReachable(
        () => bindServe(...args),
        (bound) => bound.port,
        (bound) => bound.shutdown({ gracePeriodMs: 0 }));
}

export async function serveH2c(...args: Parameters<typeof bindServeH2c>): ReturnType<typeof bindServeH2c>
{
    if (!ephemeral(args[1]))
    {
        return bindServeH2c(...args);
    }
    return bindReachable(
        () => bindServeH2c(...args),
        (bound) => bound.port,
        (bound) => bound.shutdown({ gracePeriodMs: 0 }));
}
