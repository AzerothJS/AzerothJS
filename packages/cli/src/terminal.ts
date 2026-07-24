/**
 * MODULE: cli/terminal - the CLI presentation layer
 *
 * Every character the CLI shows a human goes through here - and every color comes
 * from @azerothjs/logger's palette, the framework's ONE source of ANSI codes and
 * capability detection (NO_COLOR/FORCE_COLOR/TTY/dumb-terminal rules live there,
 * the framework's ONE source of ANSI codes). This module owns only the CLI's vocabulary: dim
 * machinery text, rotating child labels, verdict marks, the brand accents.
 *
 * The division of labor: terminal owns HOW text looks, commands own WHAT is said.
 * Machine-facing surfaces (--print plans, the info block) pass through unstyled by
 * contract - piping them must yield byte-stable, copy-pasteable text. Output goes
 * to stdout/stderr directly, NOT through the logger's record pipeline: this text
 * is the CLI's user interface, not telemetry.
 */

import { colorTier, palette, supportsUnicode, formatReady, type Palette } from '@azerothjs/logger';

const tier = colorTier(process.stdout);
const paint = palette(tier);
const errorPaint = palette(colorTier(process.stderr));

/** The stdout palette, for modules that render lines themselves (the dev conductor). */
export function stdoutPaint(): Palette
{
    return paint;
}

/**
 * Environment additions that carry THIS terminal's capabilities into piped children,
 * so their output keeps its colors and faces under the conductor instead of degrading
 * to the piped-output defaults. Explicit user choices always win: NO_COLOR, an existing
 * FORCE_COLOR, or an existing AZEROTH_LOG are never overridden - and a non-TTY
 * conductor (CI) propagates nothing, so piped runs stay byte-clean end to end.
 */
export function childPresentationEnv(): Record<string, string>
{
    if (tier === 'none')
    {
        return {};
    }
    const additions: Record<string, string> = {};
    if (process.env.FORCE_COLOR === undefined)
    {
        additions.FORCE_COLOR = tier === 'basic' ? '1' : tier === '256' ? '2' : '3';
    }
    if (process.env.AZEROTH_LOG === undefined)
    {
        // A piped @azerothjs/logger falls back to its NDJSON face; under a dev
        // conductor the developer is watching, so ask for the pretty face.
        additions.AZEROTH_LOG = 'pretty';
    }
    return additions;
}

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

/**
 * A fixed-width stream badge: `api build │`. The label's first word (the app half)
 * carries the family hue; any suffix ('build') is dimmed so tooling streams recede
 * behind their app's. Padding happens BEFORE styling (escape codes would defeat
 * padEnd), so every child's output starts in the same column and the eye can scan
 * a stream by color alone. The dim gutter separates frame from content.
 */
export function badge(text: string, familyIndex: number, width: number): string
{
    const padded = text.padEnd(width);
    const family = text.split(' ')[0] ?? text;
    const head = padded.slice(0, family.length);
    const tail = padded.slice(family.length);
    return `  ${ label(head, familyIndex) }${ paint.dim(tail) } ${ paint.dim('│') }`;
}

/**
 * The composed ready moment: one measured line, then the running URLs aligned - the
 * conductor's answer to vite's ready block, covering every half of the app at once.
 */
export function readyFrame(entries: ReadonlyArray<readonly [string, string]>, ms: number): string
{
    const check = supportsUnicode() ? '✓' : '+';
    let out = `\n  ${ paint.green(check) } ${ bold(`Ready in ${ formatReady(ms) }`) }\n`;
    const width = Math.max(0, ...entries.map(([name]) => name.length));
    for (const [name, url] of entries)
    {
        out += `    ${ paint.dim(name.padEnd(width)) }  ${ paint.brand(url) }\n`;
    }
    return out + '\n';
}

/** The doctor's verdict symbols - the shared glyph vocabulary with ASCII fallbacks. */
export function statusMark(status: 'ok' | 'warn' | 'fail' | 'skip'): string
{
    const glyphs = supportsUnicode();
    switch (status)
    {
        case 'ok': return paint.green(glyphs ? '✓' : '+');
        case 'warn': return paint.yellow('!');
        case 'fail': return paint.red(glyphs ? '✖' : 'x');
        case 'skip': return paint.dim(glyphs ? '−' : '-');
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

/** The stream-failure glyph (matches the line discipline's vocabulary). */
export function cross(): string
{
    return supportsUnicode() ? '✖' : 'x';
}

/** A step heading for check/build: dim, on the grid - the full command lives in --print. */
export function stepHeading(label: string): string
{
    return paint.dim(`  ${ supportsUnicode() ? '▸' : '>' } ${ label }`);
}

/** The green verdict moment that closes a successful check/build. */
export function success(message: string): string
{
    return `\n  ${ paint.green(supportsUnicode() ? '✓' : '+') } ${ paint.bold(message) }`;
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
 * carries the what-was-expected and what-to-do-next.
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
