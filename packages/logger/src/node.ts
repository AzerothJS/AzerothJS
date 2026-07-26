/**
 * MODULE: @azerothjs/logger/node - the Node-only surface
 *
 * The main `@azerothjs/logger` entry is browser-safe: `createLogger`, the sinks
 * (`prettySink`/`ndjsonSink`/`consoleSink`/`teeSink`), the banner, serialization, and the
 * color utilities all load in a bundler without touching a Node built-in. The pieces that
 * genuinely need `node:fs`/`node:path`/`node:readline` live here instead, so importing the
 * logger for `createLogger` in a browser never pulls those into client code:
 *
 *   - the file sinks (`fileStream`/`fileSink`) - buffered file/folder writers with rotation;
 *   - the terminal prompts (`select`/`textInput`/`intro`/`outro`) - the scaffolder's CLI.
 *
 * Import these from `@azerothjs/logger/node` in a Node process (a server, the CLI).
 */

export { fileStream, fileSink } from './file.ts';
export type { FileStreamOptions, FileStream, FileSink } from './file.ts';
export { select, textInput, intro, outro } from './prompt.ts';
export type { SelectChoice, PromptIo } from './prompt.ts';
