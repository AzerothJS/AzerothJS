/**
 * MODULE: logger/color - ANSI styling with honest capability detection
 *
 * Zero-dependency means owning the color layer: a Style is a (text) => text function pair
 * of escape codes, built once per detected capability tier. The rules are the ecosystem's
 * social contract and are non-negotiable:
 *
 *   - NO_COLOR set (any value)      -> no color, period (https://no-color.org).
 *   - FORCE_COLOR set               -> color even when piped (CI log viewers render ANSI).
 *   - stream is not a TTY           -> no color (piped output must be byte-clean).
 *   - dumb terminals                -> no color.
 *
 * The brand accent - the ice blue of the AzerothJS mark - degrades tier by tier:
 * truecolor #5fb3e8, 256-color 74, basic cyan. Icons follow the same honesty: hardware
 * that cannot render Unicode gets ASCII equivalents, decided once, not per call.
 */

/** What a stream can render. @internal */
export type ColorTier = 'none' | 'basic' | '256' | 'truecolor';

/** The subset of a Node writable stream capability detection reads. @internal */
export interface TtyLike
{
    isTTY?: boolean | undefined;
}

/** @internal Environment access hidden behind one seam so tests can inject. */
function env(name: string): string | undefined
{
    return typeof process === 'undefined' ? undefined : process.env[name];
}

/**
 * Detects the color tier for a stream, honoring NO_COLOR/FORCE_COLOR/TTY/TERM.
 * Exported for sinks and the banner; applications rarely need it directly.
 */
export function colorTier(stream: TtyLike | undefined): ColorTier
{
    if (env('NO_COLOR') !== undefined)
    {
        return 'none';
    }
    const forced = env('FORCE_COLOR');
    if (forced !== undefined && forced !== '0')
    {
        return forced === '1' ? 'basic' : forced === '2' ? '256' : 'truecolor';
    }
    if (stream === undefined || stream.isTTY !== true)
    {
        return 'none';
    }
    const term = env('TERM') ?? '';
    if (term === 'dumb')
    {
        return 'none';
    }
    const colorterm = env('COLORTERM') ?? '';
    if (colorterm.includes('truecolor') || colorterm.includes('24bit') || env('WT_SESSION') !== undefined || env('TERM_PROGRAM') === 'vscode')
    {
        return 'truecolor';
    }
    if (term.includes('256'))
    {
        return '256';
    }
    return 'basic';
}

/**
 * Whether the terminal renders non-ASCII glyphs reliably. Windows Terminal, VS Code, and
 * ConEmu do; legacy conhost and TERM=linux consoles do not.
 */
export function supportsUnicode(): boolean
{
    if (typeof process === 'undefined' || process.platform !== 'win32')
    {
        return env('TERM') !== 'linux';
    }
    return env('WT_SESSION') !== undefined
        || env('TERM_PROGRAM') === 'vscode'
        || env('ConEmuTask') !== undefined
        || env('TERM') !== undefined;
}

/** A styling function; identity when the tier renders nothing. */
export type Style = (text: string) => string;

/** The palette a sink or banner paints with - built ONCE per stream. */
export interface Palette
{
    /** The AzerothJS ice-blue accent (the mark's color). */
    brand: Style;
    bold: Style;
    dim: Style;
    red: Style;
    yellow: Style;
    green: Style;
    cyan: Style;
    magenta: Style;
    /** Red background for fatal badges. */
    inverseRed: Style;
}

/** @internal Wraps text in one escape pair. */
function wrap(open: string, close: string): Style
{
    return (text: string): string => `\u001b[${ open }m${ text }\u001b[${ close }m`;
}

const IDENTITY: Style = (text: string): string => text;

/**
 * Builds the palette for a capability tier, once per stream - the `none` tier returns
 * identity functions so callers never branch on "is color on". The brand accent
 * degrades tier by tier: truecolor #5fb3e8, 256-color 74, basic cyan.
 */
export function palette(tier: ColorTier): Palette
{
    if (tier === 'none')
    {
        return {
            brand: IDENTITY, bold: IDENTITY, dim: IDENTITY, red: IDENTITY, yellow: IDENTITY,
            green: IDENTITY, cyan: IDENTITY, magenta: IDENTITY, inverseRed: IDENTITY
        };
    }
    const brand = tier === 'truecolor'
        ? wrap('38;2;95;179;232', '39')
        : tier === '256' ? wrap('38;5;74', '39') : wrap('36', '39');
    return {
        brand,
        bold: wrap('1', '22'),
        dim: wrap('2', '22'),
        red: wrap('31', '39'),
        yellow: wrap('33', '39'),
        green: wrap('32', '39'),
        cyan: wrap('36', '39'),
        magenta: wrap('35', '39'),
        inverseRed: wrap('41;97', '49;39')
    };
}
