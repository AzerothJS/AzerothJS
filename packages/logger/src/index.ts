/**
 * MODULE: logger - public surface (browser-safe)
 *
 * One zero-dependency logger with two faces - colored, iconed developer output on a TTY
 * and byte-clean NDJSON for production - plus the banner every AzerothJS process starts
 * with. The record shape is the whole integration contract: anything that consumes
 * `{ level, message, time, fields }` (including @azerothjs/http's logging seam) accepts
 * this package's loggers structurally.
 *
 * This entry loads in a browser bundle without touching a Node built-in, so a frontend can
 * `createLogger()` for structured console output. The Node-only pieces - the file sinks and
 * the terminal prompts, which need `node:fs`/`node:path`/`node:readline` - live at the
 * {@link node} subpath (`@azerothjs/logger/node`) so they never reach client code.
 */

export { createLogger, terminalSink } from './logger.ts';
export type { LoggerOptions, LoggerFace } from './logger.ts';
export type { Logger, LogRecord, LogSink, LogLevel, LevelThreshold } from './record.ts';
export { prettySink, ndjsonSink, consoleSink, teeSink } from './sinks.ts';
export type { TerminalSinkOptions, WritableLike } from './sinks.ts';
export { renderBanner, printBanner, formatReady } from './banner.ts';
export type { BannerOptions } from './banner.ts';
export { errorShape, shapeFields, createRedactor, ndjsonLine } from './serialize.ts';
export type { ErrorShape, Redactor } from './serialize.ts';
export { colorTier, palette, supportsUnicode } from './color.ts';
export type { ColorTier, Palette, Style, TtyLike } from './color.ts';
