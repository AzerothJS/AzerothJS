/**
 * MODULE: logger/banner - the framework's face at startup
 *
 * One block, printed once, recognizable from across the room - the terminal echo of the
 * AzerothJS mark (the A with the dragon): the triangle glyph in the brand ice blue, the
 * name in bold, the version dimmed, then aligned label/value lines and a measured
 * ready-in time. The http server, the Vite dev plugin, and any tool built on the
 * framework print THIS block, so every AzerothJS app starts with the same identity -
 * that repetition is how a mark becomes recognizable.
 *
 * Honesty rules baked in: the ready time is measured by the caller (this module only
 * formats it), the version is whatever the caller read from its real package.json, and
 * on a non-TTY the banner simply does not print (a production log stream carries
 * structured lines, not art).
 */

import type { TtyLike } from './color.ts';
import { colorTier, palette, supportsUnicode } from './color.ts';
import type { WritableLike } from './sinks.ts';

/** Everything the banner renders; every field optional - the empty banner is just the mark. */
export interface BannerOptions
{
    /** Product name; default 'AzerothJS'. */
    name?: string | undefined;

    /** Version string, WITHOUT the leading v (the banner adds it). */
    version?: string | undefined;

    /** One dimmed word after the name - the flavor ('http', 'dev', 'ws'). */
    subtitle?: string | undefined;

    /** Aligned label/value lines (Local/Network URLs, mode, anything). */
    entries?: ReadonlyArray<readonly [string, string]> | undefined;

    /** Measured startup milliseconds; rendered as the ready line when given. */
    readyMs?: number | undefined;

    /** Target stream (printBanner) / capability source (renderBanner); default stdout. */
    stream?: WritableLike | undefined;
}

/** @internal "12 ms", "3.42 s" - sub-10ms keeps one decimal, seconds past 1000. */
export function formatReady(ms: number): string
{
    if (ms >= 1000)
    {
        return (ms / 1000).toFixed(2) + ' s';
    }
    if (ms < 10)
    {
        return (Math.round(ms * 10) / 10).toString() + ' ms';
    }
    return Math.round(ms).toString() + ' ms';
}

/**
 * Renders the banner block as a string (trailing newline included). Color and glyphs
 * follow the stream's detected capability; a NO_COLOR/non-TTY render is plain text.
 */
export function renderBanner(options: BannerOptions = {}): string
{
    const stream: TtyLike | undefined = options.stream ?? (typeof process === 'undefined' ? undefined : process.stdout);
    const paint = palette(colorTier(stream));
    const glyph = supportsUnicode() ? '▲' : 'A';
    const name = options.name ?? 'AzerothJS';

    let head = '  ' + paint.brand(glyph + ' ' + paint.bold(name));
    if (options.version !== undefined)
    {
        head += ' ' + paint.dim('v' + options.version);
    }
    if (options.subtitle !== undefined)
    {
        head += '  ' + paint.dim(options.subtitle);
    }

    let out = '\n' + head + '\n';

    const entries = options.entries ?? [];
    if (entries.length > 0)
    {
        const width = Math.max(...entries.map(([label]) => label.length));
        out += '\n';
        for (const [label, value] of entries)
        {
            out += '    ' + paint.dim(label.padEnd(width)) + '  ' + value + '\n';
        }
    }

    if (options.readyMs !== undefined)
    {
        const check = supportsUnicode() ? '✓' : 'ok';
        out += '\n    ' + paint.green(check) + ' Ready in ' + paint.bold(formatReady(options.readyMs)) + '\n';
    }

    return out;
}

/**
 * Prints the banner to its stream - and ONLY on an interactive terminal outside
 * production; anywhere else it is a silent no-op, because a piped or collected log
 * stream must carry records, not art. Returns whether it printed.
 */
export function printBanner(options: BannerOptions = {}): boolean
{
    if (typeof process === 'undefined')
    {
        return false;
    }
    const stream = options.stream ?? process.stdout;
    if (stream.isTTY !== true || process.env.NODE_ENV === 'production')
    {
        return false;
    }
    stream.write(renderBanner({ ...options, stream }));
    return true;
}
