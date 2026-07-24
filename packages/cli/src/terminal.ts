/**
 * MODULE: cli/terminal - the CLI presentation layer
 *
 * Every character the CLI shows a human goes through here - and every color comes
 * from @azerothjs/logger's palette, the framework's ONE source of ANSI codes and
 * capability detection (NO_COLOR/FORCE_COLOR/TTY/dumb-terminal rules live there,
 * see the logger's DESIGN.md). This module owns only the CLI's vocabulary: dim
 * machinery text, rotating child labels, verdict marks, the brand accents.
 *
 * The division of labor: terminal owns HOW text looks, commands own WHAT is said.
 * Machine-facing surfaces (--print plans, the info block) pass through unstyled by
 * contract - piping them must yield byte-stable, copy-pasteable text. Output goes
 * to stdout/stderr directly, NOT through the logger's record pipeline: this text
 * is the CLI's user interface, not telemetry.
 */

import { colorTier, palette, supportsUnicode } from '@azerothjs/logger';

const paint = palette(colorTier(process.stdout));
const errorPaint = palette(colorTier(process.stderr));

/** De-emphasized text: notes, headings, the machinery the eye should skim. */
export function dim(text: string): string
{
    return paint.dim(text);
}

/** Brand-accent text: command names, the mark - the ice blue of the AzerothJS logo. */
export function brand(text: string): string
{
    return paint.brand(text);
}

/** Emphasis for headings and answers. */
export function bold(text: string): string
{
    return paint.bold(text);
}

const LABEL_STYLES = [
    (text: string): string => paint.cyan(text),
    (text: string): string => paint.magenta(text),
    (text: string): string => paint.yellow(text),
    (text: string): string => paint.green(text)
] as const;

/** A colored child label ([web], [api], ...); the index picks a stable hue. */
export function label(text: string, index: number): string
{
    return (LABEL_STYLES[index % LABEL_STYLES.length] ?? LABEL_STYLES[0])(text);
}

/** The doctor's verdict symbols - ASCII on purpose (Windows consoles, CI logs). */
export function statusMark(status: 'ok' | 'warn' | 'fail' | 'skip'): string
{
    switch (status)
    {
        case 'ok': return paint.green('+');
        case 'warn': return paint.yellow('!');
        case 'fail': return paint.red('x');
        case 'skip': return paint.dim('-');
    }
}

/** The flow-end glyph for summary verdict lines (ASCII fallback via the shared rules). */
export function verdictGlyph(): string
{
    return supportsUnicode() ? '└' : '+';
}

/** The AzerothJS mark with its ASCII fallback. */
export function mark(): string
{
    return supportsUnicode() ? '▲' : 'A';
}

/** One line to stdout - the CLI's user interface channel. */
export function print(line = ''): void
{
    process.stdout.write(`${ line }\n`);
}

/** One line to stderr - diagnostics, so stdout stays machine-consumable. */
export function printError(line: string): void
{
    process.stderr.write(`${ line }\n`);
}

/**
 * An error in the house voice: a red mark, the tool's name, then what happened.
 * Usage mistakes and environment failures both come through here; the MESSAGE
 * carries the what-was-expected and what-to-do-next (DESIGN.md voice rules).
 */
export function fail(message: string): void
{
    printError(`${ errorPaint.red('x') } azeroth: ${ message }`);
}

/** Raw pass-through to stdout for pre-formed chunks (prefixed child output). */
export function write(chunk: string): void
{
    process.stdout.write(chunk);
}
