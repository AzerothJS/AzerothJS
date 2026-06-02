// @azerothjs/compiler
//
// Compiles `.azeroth` files - JS/TS modules written with AzerothJS markup (a
// JSX-style syntax) - into plain modules that call the runtime's h()
// hyperscript with fine-grained reactive bindings. For example
// `<h1>Count: {count()}</h1>` becomes `h('h1', {}, 'Count: ', () => (count()))`.
//
// The pipeline, in the order it runs (and a good order to read it in):
//   scanner  - finds markup regions inside arbitrary JS, skipping
//              strings/templates/comments/regex and detecting expression
//              position
//   parser   - markup region -> AST
//   codegen  - AST -> h()/component-call source, with reactive wrapping
//   compile  - orchestrates scan -> parse -> codegen -> splice

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
