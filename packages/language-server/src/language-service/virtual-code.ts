/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Thin adapter: the `.azeroth` -> TypeScript projection is owned by @azerothjs/compiler,
// re-exported here under the local path the language-service providers import from.
export { generateVirtualCode, BUILTIN_COMPONENTS, type VirtualCode } from '@azerothjs/compiler';
