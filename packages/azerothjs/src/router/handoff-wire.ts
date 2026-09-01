/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The handoff wire identity, in a leaf module because BOTH ends read it: `handoff.ts` stamps
 * the payload, `router.ts` refuses to adopt one that is not this build's shape. Held apart
 * from either so neither has to import the other - and so the version cannot be a literal in
 * one of them, which is what it was: bumping the stamp would have made every client silently
 * reject every handoff and refetch.
 */

/** The DOM id of the handoff script tag. */
export const LOADER_HANDOFF_ID = '__azeroth-loader-handoff';

/** The handoff wire-format version; bumped when the payload shape changes. */
export const LOADER_HANDOFF_VERSION = 4;
