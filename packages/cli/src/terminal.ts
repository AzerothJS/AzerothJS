/**
 * MODULE: cli/terminal - the CLI presentation layer
 *
 * Every character the CLI shows a human goes through here: colors, symbols, dim and
 * label styling, TTY and NO_COLOR detection - one module, so formatting never scatters
 * across commands as the surface grows. It writes DIRECTLY to stdout/stderr and stays
 * deliberately tiny; @azerothjs/logger remains the runtime telemetry face (see run.ts).
 *
 * The division of labor: terminal owns HOW text looks (style is stripped automatically
 * when the target is not a color-capable TTY, honoring NO_COLOR), commands own WHAT is
 * said. Machine-facing surfaces (--print plans, the info block) pass through unstyled
 * by contract - piping them must yield byte-stable, copy-pasteable text.
 */

export const colorEnabled: boolean = process.stdout.isTTY
    && process.env['NO_COLOR'] === undefined
    && process.env['TERM'] !== 'dumb';

const RESET = '\u001b[0m';
const CODES =
{
    dim: '\u001b[2m',
    red: '\u001b[31m',
    green: '\u001b[32m',
    yellow: '\u001b[33m'
} as const;

/** The rotating palette for [label] prefixes - one hue per concurrent child. */
const LABEL_CODES = ['\u001b[36m', '\u001b[35m', '\u001b[33m', '\u001b[32m'] as const;

function styled(text: string, code: string): string
{
    return colorEnabled ? `${ code }${ text }${ RESET }` : text;
}

/** De-emphasized text: notes, headings, the machinery the eye should skim. */
export function dim(text: string): string
{
    return styled(text, CODES.dim);
}

/** A colored child label ([web], [api], ...); the index picks a stable hue. */
export function label(text: string, index: number): string
{
    return styled(text, LABEL_CODES[index % LABEL_CODES.length] ?? '');
}

/** The doctor's verdict symbols - ASCII on purpose (Windows consoles, CI logs). */
export function statusMark(status: 'ok' | 'warn' | 'fail' | 'skip'): string
{
    switch (status)
    {
        case 'ok': return styled('+', CODES.green);
        case 'warn': return styled('!', CODES.yellow);
        case 'fail': return styled('x', CODES.red);
        case 'skip': return styled('-', CODES.dim);
    }
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

/** Raw pass-through to stdout for pre-formed chunks (prefixed child output). */
export function write(chunk: string): void
{
    process.stdout.write(chunk);
}
