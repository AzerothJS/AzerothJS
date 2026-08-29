/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The redirect boundary: what a guard or loader redirect target is allowed to be.
 *
 * A guard/loader redirect is an AUTOMATIC navigation whose target the app derives - from a
 * route, a session, a `?next=` parameter. An off-origin target there is either a mistake or
 * an attacker's `?next=` reaching the wire, which is the open-redirect shape. So the target
 * is judged by the router's OWN notion of external (`isExternalUrl`) at the boundaries that
 * consume it, rather than in `redirect()`: a guard may return a bare `NavigateTarget` and
 * never call `redirect()` at all, so a check in the sentinel factory would miss half the
 * producers.
 *
 * This is deliberately NOT applied to `<Link>` (user-initiated, and an absolute href is
 * universal) or to the HTTP `redirect()` helper (a raw `Location` header value, whose whole
 * job includes off-origin flows). The asymmetry is the difference between a navigation the
 * user chose and one the app performs on their behalf.
 */

import { isExternalUrl } from '../semantics.ts';
import { unbrandUrl } from '../renderer/ssr.ts';
import type { NavigateTarget } from './types.ts';

/** A target that passed the boundary, with any author-vetted marker already unwrapped. */
export interface AcceptedTarget
{
    accepted: true;
    to: NavigateTarget;
}

/** A target that leaves the origin and was refused; `target` is what the app asked for. */
export interface RefusedTarget
{
    accepted: false;
    target: string;
}

/**
 * Judges one redirect target. An author-vetted marker ({@link unsafeUrl}) passes and is
 * UNWRAPPED here, so no writer downstream stringifies the marker object into a header or a
 * history entry. Both target forms are judged: `{ pathname }` is an unconstrained string, so
 * `{ pathname: '//evil.example' }` is external exactly as the bare string is.
 *
 * @internal
 */
export function acceptRedirectTarget(to: NavigateTarget): AcceptedTarget | RefusedTarget
{
    // The brand is read FIRST, before any shape dispatch: `unsafeUrl` returns an OBJECT
    // typed as a string, so a `typeof to === 'string'` test sends a vetted target down the
    // object branch and reads a `pathname` that does not exist.
    const vettedTarget = unbrandUrl(to);
    if (vettedTarget !== null)
    {
        return { accepted: true, to: vettedTarget };
    }

    if (typeof to === 'string')
    {
        return isExternalUrl(to) ? { accepted: false, target: to } : { accepted: true, to };
    }

    const vetted = unbrandUrl(to.pathname);
    if (vetted !== null)
    {
        return { accepted: true, to: { ...to, pathname: vetted } };
    }
    return isExternalUrl(to.pathname)
        ? { accepted: false, target: to.pathname }
        : { accepted: true, to };
}
