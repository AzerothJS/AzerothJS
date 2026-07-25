// Thin adapter. The Azeroth -> TypeScript projection is owned by @azerothjs/compiler - a single source
// of truth shared by the type checker, this language service, the TypeScript plugin, and the ESLint
// processor - so there is never more than one implementation of `.azeroth` lowering. This module
// re-exports it under the local path the language-service providers already import from, so a new
// language feature taught to the compiler's projection works here with no change.
export { generateVirtualCode, BUILTIN_COMPONENTS, type VirtualCode } from '@azerothjs/compiler';
