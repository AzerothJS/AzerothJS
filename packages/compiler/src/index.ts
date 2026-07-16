/**
 * MODULE: @azerothjs/compiler - public API
 *
 * Compiles `.azeroth` files - JS/TS modules written with `component` syntax and AzerothJS markup -
 * into plain modules that call the runtime with fine-grained reactive bindings, e.g.
 * `<h1>Count: {count()}</h1>` becomes a mode-dispatched body (clone in the DOM, serialize for SSR,
 * adopt on hydrate) over ONE IR.
 *
 * The component pipeline, in run order (and a good reading order):
 *   parser   - `.azeroth` source -> module AST (opaque regions + component declarations)
 *   analyze  - per component, the reactive sources and each scope's dependency set
 *   lower    - markup AST + analysis -> the target-independent Render Plan IR
 *   optimize - IR -> IR passes (constant folding)
 *   codegen  - IR -> JS via ONE emitter (generateModule), with the R2 reactive rewrite
 * Most apps never call these directly: the supported entry is the Vite plugin {@link azeroth}, which
 * runs the whole pipeline plus lint + diagnostics + source-map chaining.
 *
 * The scanner/markup-parser/lint utilities are the lower-level markup-region building blocks, exported
 * for tooling. `.azeroth` is component-only.
 * Every symbol below is documented at its definition.
 */

export { lintMarkup, lintSource, type LintWarning, type LintFix, type LintOptions } from './lint.ts';
export { CompileError, parseMarkup } from './markup-parser.ts';
export {
    findMarkupStart,
    isWhitespace,
    isIdentStart,
    isIdentPart,
    skipBalanced,
    skipString,
    skipTemplate,
    skipLineComment,
    skipBlockComment,
    skipRegex
} from './scanner.ts';
export { walkComponentTags } from './markup-util.ts';
export { azeroth, type AzerothPluginOptions } from './vite.ts';

// The component pipeline: the parser/analysis/codegen for `component` syntax.
export { parseModule } from './parser.ts';
export type { Module, ModuleItem, OpaqueRegion, ComponentDecl, StateDecl, DerivedDecl } from './ast.ts';
// NOTE: this pipeline (and `diagnoseModule`) pulls the TypeScript-backed analysis
// into this index; the compiler requires `typescript` as a peer dep.
export { diagnoseModule, diagnoseUnusedImports, type AzerothDiagnostic } from './diagnostics.ts';
// The TypeScript-program-backed type checker. The Vite plugin runs it as the build-blocking gate by
// default (a non-function handler or a wrong/missing component prop fails the build); createIncrementalChecker
// is the incremental form that binds the lib once and is reused across every file in a build.
export { typeCheckModuleTS, createIncrementalChecker, type AzerothTypeChecker } from './typecheck-ts.ts';
// The loader/adapter for the NATIVE TypeScript compiler's API (TypeScript 7+). Tooling that only needs
// raw diagnostics (the command-line checker) runs on the native engine when it is installed; everything
// returns null without it and callers keep their classic path.
export {
    loadNativeTs,
    adaptDiagnostics,
    type NativeApi,
    type NativeSnapshot,
    type NativeProject,
    type NativeProgram,
    type NativeDiagnostic,
    type NativeFileSystem,
    type NativeUpdateParams,
    type AdaptedDiagnostic
} from './native-ts.ts';
// Emits a `.d.ts` for an `.azeroth` module so plain TypeScript (`tsc` and editors) can resolve and
// type-check `.azeroth` imports from `.ts` files.
export { emitDeclarations, emitDeclarationsWithMap, type DeclarationOutput } from './declarations.ts';
export { RUNTIME_FN, type ConstructKind } from './keyword-spec.ts';
// THE single Azeroth -> TypeScript projection. Every tool (type checker, language service, TS plugin,
// ESLint processor, declaration emitter) lowers `.azeroth` to TypeScript through this one function.
export { generateVirtualCode, BUILTIN_COMPONENTS, type VirtualCode } from './project.ts';
export { CodeMapping, type MappingSegment, type MappingKind } from './mapping.ts';
export {
    vlqEncode,
    buildLineStarts,
    locationFor,
    encodeMappings,
    decodeMappings,
    type SourceMapV3,
    type RawSegment
} from './sourcemap.ts';

export type {
    Span,
    MarkupElement,
    MarkupFragment,
    MarkupText,
    MarkupExpression,
    MarkupChild,
    MarkupAttribute,
    MarkupAttributeValue
} from './types.ts';
