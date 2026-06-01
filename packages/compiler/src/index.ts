// ============================================================================
// AZEROTHJS — Compiler (@azerothjs/compiler)
// ============================================================================
//
// Compiles `.azeroth` files — JS/TS modules written with AzerothJS
// markup (a JSX-style syntax) — into plain modules that call the
// runtime's h() hyperscript with fine-grained reactive bindings.
//
//   <h1>Count: {count()}</h1>
//        ↓
//   h('h1', {  }, 'Count: ', () => (count()))
//
// PIPELINE (build it / read it in this order):
//   scanner  — finds markup regions inside arbitrary JS (skips
//              strings/templates/comments/regex; expression-position
//              detection)
//   parser   — markup region → AST
//   codegen  — AST → h()/component-call source (reactive wrapping)
//   compile  — orchestrates scan → parse → codegen → splice
//
// STATUS: Phase 5 — core transform implemented. Scoped CSS, Vite
// plugin, HMR, and source maps build on top of compile().
//
// ============================================================================

export { compile, type CompileResult } from './compile.ts';
export { CompileError, parseMarkup } from './parser.ts';
export { findMarkupStart } from './scanner.ts';
export { generate, type ExpressionCompiler } from './codegen.ts';
export { azeroth, type AzerothPluginOptions } from './vite.ts';
export {
    vlqEncode,
    buildLineStarts,
    locationFor,
    encodeMappings,
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
    MarkupAttributeValue,
    MarkupRegion
} from './types.ts';
