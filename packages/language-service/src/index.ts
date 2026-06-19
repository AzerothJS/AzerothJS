// @azerothjs/language-service
//
// Compiler-aware language intelligence for `.azeroth` files, packaged for any
// editor frontend (the bundled LSP server in @azerothjs/language-server, a
// test harness, or a browser playground).
//
// The pipeline, in the order it runs (and a good order to read it in):
//   virtual-code - reuse the compiler's scanner + parser to compile a
//                  `.azeroth` file into a virtual TypeScript module, recording a
//                  precise offset mapping for every user-authored span
//   ts-project   - run a single ts.LanguageService over those virtual modules
//                  (the engine for type inference, completion, hover, etc.)
//   markup-model - classify the caret (tag name / attribute / expression / ...)
//                  so the providers know which vocabulary to offer
//   providers    - one focused module per editor feature
//   service      - the AzerothLanguageService facade that ties them together
//
// The core depends only on `typescript` and `@azerothjs/compiler`, so it runs
// (and is tested) without an editor in the loop.

export { AzerothLanguageService } from './service.ts';
export {
    registerCompletionSource,
    clearCompletionSources,
    type CompletionOptions,
    type CompletionSource
} from './providers/completion.ts';
export type { InlayHintOptions } from './providers/inlay-hints.ts';

export {
    generateComponentDocs,
    type ComponentDoc,
    type PropDoc
} from './docgen.ts';

export {
    AzerothProject,
    isVirtualFile,
    toVirtualFile,
    toAzerothPath
} from './ts-project.ts';

export {
    generateVirtualCode,
    BUILTIN_COMPONENTS,
    type VirtualCode
} from './virtual-code.ts';

export { CodeMapping, type MappingSegment, type MappingKind } from './mapping.ts';

export { StyleIndex, type ClassDefinition } from './style-index.ts';

export {
    setEnabled as setMetricsEnabled,
    snapshot as getMetrics,
    type Metrics
} from './perf.ts';

export {
    classifyPosition,
    collectMarkupNodes,
    type PositionContext
} from './markup-model.ts';

export {
    BUILTIN_COMPONENT_MAP,
    DOM_EVENTS,
    type BuiltinComponent
} from './language-data.ts';

export { LineIndex } from './text.ts';
export { uriToPath, pathToUri } from './uri.ts';

export {
    CompletionItemKind,
    SymbolKind,
    DiagnosticSeverity,
    SEMANTIC_TOKEN_TYPES,
    SEMANTIC_TOKEN_MODIFIERS,
    type Position,
    type Range,
    type Location,
    type CompletionItem,
    type Hover,
    type SignatureHelp,
    type SignatureInformation,
    type TextEdit,
    type WorkspaceEdit,
    type PrepareRenameResult,
    type DocumentSymbol,
    type DocumentHighlight,
    type DocumentLink,
    type Color,
    type ColorInformation,
    type ColorPresentation,
    type WorkspaceSymbol,
    type CallHierarchyItem,
    type CallHierarchyIncomingCall,
    type CallHierarchyOutgoingCall,
    type Diagnostic,
    type FoldingRange,
    type InlayHint,
    type SelectionRange,
    type CodeAction,
    type Command,
    type CodeLens,
    type SemanticTokens,
    type SemanticTokenType,
    type SemanticTokenModifier
} from './protocol.ts';
