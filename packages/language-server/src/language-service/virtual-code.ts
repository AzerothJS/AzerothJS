// Thin adapter: the `.azeroth` -> TypeScript projection is owned by @azerothjs/compiler,
// re-exported here under the local path the language-service providers import from.
export { generateVirtualCode, BUILTIN_COMPONENTS, type VirtualCode } from '@azerothjs/compiler';
