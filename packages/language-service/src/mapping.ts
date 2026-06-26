// Thin adapter. `CodeMapping` is owned by @azerothjs/compiler, alongside the projection that produces it,
// so the mapping type the providers consume and the one the projection emits are the same class. This
// module re-exports it under the local path the providers already import from.
export { CodeMapping, type MappingSegment, type MappingKind } from '@azerothjs/compiler';
