// @azerothjs/language-server
//
// A Language Server Protocol front-end for `.azeroth` files. The CLI binary
// (`azeroth-language-server`) runs `startServer()` over stdio; this entry point
// re-exports it so the server can also be embedded (e.g. in a web worker host
// or an integration test that drives it through an in-memory connection).

export { startServer } from './server.ts';
export { runTsc, watchTsc, parseArgs, type TscOptions, type TscResult, type TscWatcher } from './tsc.ts';
