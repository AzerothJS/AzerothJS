/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Which App serves which api.
 *
 * `register` records the App it installed on, the manifest it projected and the prefix it
 * mounted under; a request root reads that record to decide whether the request it is
 * answering has an api reachable in process. A leaf module on purpose: the App gains no
 * method and the api layer gains no App import at runtime, so a process with two Apps keeps
 * two records and neither can collide with the other.
 *
 * One record per App: a second `register` on the same App replaces the first one here, so mount
 * every group in one call. Both calls' routes still answer over the wire - it is the in-process
 * record that the later call owns.
 */

import type { App } from '../app.ts';
import type { Manifest } from './declare.ts';

/** What one {@link register} call installed. */
export interface ApiRegistration
{
    /** The App the routes were installed on; an in-process call enters at its `handle`. */
    app: App;

    /** The runtime projection a typed client needs: group -> route -> method and path. */
    manifest: Manifest;

    /** The path prefix the features are served under, which is the client's baseUrl. */
    prefix: string;
}

/** Keyed on the App object, so a registration dies with the App that holds it. */
const registrations = new WeakMap<object, ApiRegistration>();

/** @internal Records what `register` installed, so a request root can find it. */
export function recordApiRegistration(registration: ApiRegistration): void
{
    registrations.set(registration.app, registration);
}

/** Pages Apps whose shared renders reach another App's api, keyed on the pages App. */
const lenders = new WeakMap<object, object>();

/**
 * @internal A shared render of pages mounted on `pages` reaches the api `owner` registers. One
 * owner per pages App, so no request can pick which api fills an entry every visitor is served.
 */
export function lendApiRegistration(pages: object, owner: object): void
{
    const lent = lenders.get(pages);
    if (lent !== undefined && lent !== owner)
    {
        throw new Error('@azerothjs/http: lendApiRegistration refused - this pages App already reaches the api of '
            + 'another App. A pages App borrows from one owner, so no request can choose which api fills the '
            + 'entries every visitor is served.');
    }
    if (registrations.has(pages))
    {
        throw new Error('@azerothjs/http: lendApiRegistration refused - this pages App registers its own api, '
            + 'which its shared renders already reach. Lend only to a pages App that serves no api.');
    }
    lenders.set(pages, owner);
}

/** @internal The api a shared render of pages mounted on this App reaches: its own, else its lender's. */
export function sharedApiRegistrationOf(app: object): ApiRegistration | undefined
{
    const owner = lenders.get(app);
    return registrations.get(app) ?? (owner === undefined ? undefined : registrations.get(owner));
}

/** @internal The api registered on this App, or undefined when it serves none. */
export function apiRegistrationOf(app: object): ApiRegistration | undefined
{
    return registrations.get(app);
}
