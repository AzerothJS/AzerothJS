/**
 * MODULE: logger - public surface
 *
 * One zero-dependency logger with two faces - colored, iconed developer output on a TTY
 * and byte-clean NDJSON for production - plus the banner every AzerothJS process starts
 * with. The record shape is the whole integration contract: anything that consumes
 * `{ level, message, time, fields }` (including @azerothjs/http's logging seam) accepts
 * this package's loggers structurally.
 */

export { createLogger } from './logger.ts';
export type { LoggerOptions, LoggerFace } from './logger.ts';
export type { Logger, LogRecord, LogSink, LogLevel, LevelThreshold } from './record.ts';
export { prettySink, ndjsonSink, consoleSink } from './sinks.ts';
export type { TerminalSinkOptions, WritableLike } from './sinks.ts';
export { fileStream, fileSink, teeSink } from './file.ts';
export type { FileStreamOptions, FileStream, FileSink } from './file.ts';
export { renderBanner, printBanner, formatReady } from './banner.ts';
export type { BannerOptions } from './banner.ts';
export { select, textInput, intro, outro } from './prompt.ts';
export type { SelectChoice, PromptIo } from './prompt.ts';
export { errorShape, shapeFields, ndjsonLine } from './serialize.ts';
export type { ErrorShape } from './serialize.ts';
export { colorTier, palette, supportsUnicode } from './color.ts';
export type { ColorTier, Palette, Style, TtyLike } from './color.ts';
