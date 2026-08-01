// @azerothjs/language-server/language-service
//
// Compiler-aware language intelligence for `.azeroth` files, packaged for any editor frontend (the
// bundled LSP server in @azerothjs/language-server, a test harness, or a browser playground).
//
// The pipeline, in the order it runs (and a good order to read it in):
//   virtual-code - reuse the compiler's scanner + parser to compile a `.azeroth` file into a
//                  virtual TypeScript module, recording a precise offset mapping for every
//                  user-authored span
//   ts-project   - run a single ts.LanguageService over those virtual modules
//   markup-model - classify the caret (tag name / attribute / expression / ...) so the providers
//                  know which vocabulary to offer
//   providers    - one focused module per editor feature
//   service      - the AzerothLanguageService facade that ties them together
//
// The core depends only on `typescript` and `@azerothjs/compiler`, so it runs (and is tested)
// without an editor in the loop.
//
// WHAT THIS ENTRY PUBLISHES, and why it is short: the facade, the options its methods take, the
// constants an editor must echo back in its capabilities, and the three helpers other packages
// build on. The pipeline stages above are NOT here - they are how the service is built, not how
// it is used, and publishing them makes a 65-symbol surface for the 17 symbols anything imports.
// A stage that turns out to be genuinely useful outside can be published on that evidence.

export { AzerothLanguageService } from './service.ts';
export type { CompletionOptions } from './providers/completion.ts';
export type { InlayHintOptions } from './providers/inlay-hints.ts';

// Consumed by @azerothjs/eslint-plugin (the parser and its project pool).
export { AzerothProject, toVirtualFile } from './ts-project.ts';

// Consumed by @azerothjs/typescript-plugin, which maps result spans from the virtual module back
// to the `.azeroth` source.
export { generateVirtualCode, type VirtualCode } from './virtual-code.ts';
export { CodeMapping } from '@azerothjs/compiler';
export { containedSibling } from './containment.ts';

// The uri<->path pair the LSP server and the tsc driver both speak.
export { uriToPath, pathToUri } from './uri.ts';

export { generateComponentDocs } from './docgen.ts';

// Echoed back by an editor in its server capabilities, so a client and the service agree on the
// legend; and the severity an editor maps to its own diagnostic levels.
export { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS, DiagnosticSeverity } from './protocol.ts';

// The protocol shapes an editor frontend names when adapting results to its own client types.
export type { CallHierarchyItem, CodeLens, CompletionItem } from './protocol.ts';
