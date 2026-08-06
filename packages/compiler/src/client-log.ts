/**
 * MODULE: compiler/client-log - the `client` lane over vite's console forwarding
 *
 * The missing half of a fullstack dev session: the server's request lines reach the
 * terminal, but a browser-side crash lives only in the devtools console. Vite 8
 * ships the transport - `server.forwardConsole` hooks the page's console and error
 * events and relays each occurrence over the HMR socket, source-mapping error
 * stacks on the way - but leaves it off for human terminals (it defaults on only
 * under an AI agent) and renders raw `[console.error]` prefixes. The azeroth plugin
 * turns the transport ON (see the `clientLogs` option) and this module restyles the
 * relayed lines into the house voice: a `client` lane word as the visual
 * discriminator, level glyphs from the logger palette, and a token bucket so a
 * render-loop console storm degrades to one drop notice instead of drowning the
 * terminal.
 */

import type { Palette } from '@azerothjs/logger';

/** One recognized forwarded line, split for rendering. */
export interface ClientLine
{
    level: 'log' | 'info' | 'warn' | 'error' | 'debug';
    /** The first line's text after vite's prefix. */
    message: string;
    /** Remaining lines (source-mapped frames, codeframe), verbatim. */
    tail: string;
}

const CONSOLE_PREFIX = /^\[console\.(log|info|warn|error|debug)\]\s?/;
const UNHANDLED_PREFIX = /^\[Unhandled (?:error|rejection)\]\s?/;

/**
 * Recognizes one of vite's forwarded-console messages by its first line. Operates
 * on ANSI-STRIPPED text - the prefixes are colored on the wire.
 *
 * @param plain - The stripped message (may be multi-line for unhandled errors).
 * @returns The split line, or `null` for anything that is not forwarded console.
 */
export function detectClientLine(plain: string): ClientLine | null
{
    const newline = plain.indexOf('\n');
    const head = newline === -1 ? plain : plain.slice(0, newline);
    const tail = newline === -1 ? '' : plain.slice(newline + 1).replace(/\n+$/, '');

    const consoleMatch = CONSOLE_PREFIX.exec(head);
    if (consoleMatch !== null)
    {
        return {
            level: consoleMatch[1] as ClientLine['level'],
            message: head.slice(consoleMatch[0].length),
            tail
        };
    }
    if (UNHANDLED_PREFIX.test(head))
    {
        return { level: 'error', message: head.replace(UNHANDLED_PREFIX, ''), tail };
    }
    return null;
}

/**
 * Renders a recognized line as the `client` lane block: styled lead line, then the
 * tail (vite's source-mapped frames) dimmed, without a trailing newline.
 *
 * @param line - From {@link detectClientLine}.
 * @param paint - The logger palette for the target stream.
 * @param unicode - Whether the glyph set may use non-ASCII.
 * @returns The rendered block.
 */
export function renderClientLine(line: ClientLine, paint: Palette, unicode: boolean): string
{
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const glyph = line.level === 'error' ? paint.red(unicode ? '✖' : 'x')
        : line.level === 'warn' ? paint.yellow('!')
            : paint.dim('·');
    const lead = `${ paint.dim(time) } ${ glyph } ${ paint.magenta('client') }  ${ line.message }`;
    if (line.tail === '')
    {
        return lead;
    }
    const tail = line.tail.split('\n').map((frame) => paint.dim(frame)).join('\n');
    return `${ lead }\n${ tail }`;
}

/** A token bucket; `take()` answers whether this occurrence may print. */
export interface LogBucket
{
    take(): boolean;
    /** Returns and resets the refusal count - the caller prints one drop notice on resume. */
    drain(): number;
}

/**
 * A small token bucket for the lane: sustained storms (a render-loop
 * console.error) degrade to a drop notice instead of drowning the terminal.
 *
 * @param capacity - Burst size; also the refill ceiling.
 * @param perSecond - Refill rate.
 * @param now - Clock, injectable for specs; default `Date.now`.
 * @returns The bucket.
 */
export function createLogBucket(capacity: number, perSecond: number, now: () => number = Date.now): LogBucket
{
    let tokens = capacity;
    let dropped = 0;
    let last = now();
    return {
        take(): boolean
        {
            const at = now();
            tokens = Math.min(capacity, tokens + ((at - last) / 1000) * perSecond);
            last = at;
            if (tokens >= 1)
            {
                tokens -= 1;
                return true;
            }
            dropped += 1;
            return false;
        },
        drain(): number
        {
            const count = dropped;
            dropped = 0;
            return count;
        }
    };
}
