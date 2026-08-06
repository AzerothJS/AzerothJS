/**
 * MODULE: compiler/vite-logger - the framework's face on vite's own output
 *
 * Vite's dev chatter is three different things at once: an identity block (the
 * `VITE vX ready` line, the URL list, the shortcuts hint), per-change HMR notices,
 * and real diagnostics (plugin warnings, transform errors). The azeroth banner owns
 * identity, so the block is dropped; HMR notices are restyled to one dim line in the
 * house voice; diagnostics pass through BYTE-INTACT - rewriting a codeframe is how
 * wrappers start lying.
 *
 * One deliberate exception: when stdout is piped (the `azeroth dev` conductor), the
 * `Local:`/`Network:` URL lines pass through instead of being swallowed - the
 * conductor's ready frame harvests the URL from them and hides them from display.
 * On a TTY the banner prints the same URLs, so there they are pure duplication.
 */

import type { Logger as ViteLogger, LogErrorOptions, LogLevel as ViteLogLevel, LogType } from 'vite';
import { colorTier, palette, supportsUnicode } from '@azerothjs/logger';
import { createLogBucket, detectClientLine, renderClientLine } from './client-log.ts';

/** @internal Minimal writable surface, injectable for specs. */
export interface LoggerStreams
{
    out?: { write(chunk: string): unknown; isTTY?: boolean | undefined };
    err?: { write(chunk: string): unknown; isTTY?: boolean | undefined };
}

const ANSI = new RegExp(`${ String.fromCharCode(27) }\\[[0-9;]*m`, 'g');

/** @internal */
function stripAnsi(text: string): string
{
    return text.replace(ANSI, '');
}

const RANK: Record<ViteLogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3 };

/**
 * Builds the vite `Logger` the azeroth plugin injects for dev serves. `level` is the
 * user's `logLevel` config, enforced here because a custom logger takes precedence
 * over vite's own threshold handling.
 *
 * @param level - Vite log level; default `info`.
 * @param streams - Output streams; default process stdio.
 * @returns A vite-compatible logger.
 */
export function azerothViteLogger(level: ViteLogLevel | undefined, streams: LoggerStreams = {}): ViteLogger
{
    const out = streams.out ?? (typeof process === 'undefined' ? undefined : process.stdout);
    const err = streams.err ?? (typeof process === 'undefined' ? undefined : process.stderr);
    const threshold = RANK[level ?? 'info'];
    const seen = new Set<string>();
    const logged = new WeakSet<object>();
    let warned = false;

    const paint = palette(colorTier(out));
    const glyph = supportsUnicode() ? '↻' : '~';
    const bucket = createLogBucket(20, 20);

    // Vite's forwarded browser-console lines arrive at their originating level;
    // restyle them into the `client` lane wherever they surface. Returns whether
    // the message was one.
    function clientLane(message: string, write: (chunk: string) => void): boolean
    {
        const line = detectClientLine(stripAnsi(message).trim());
        if (line === null)
        {
            return false;
        }
        if (bucket.take())
        {
            const missed = bucket.drain();
            if (missed > 0)
            {
                write(paint.dim(`client logs dropped (${ missed })`) + '\n');
            }
            write(renderClientLine(line, paint, supportsUnicode()) + '\n');
        }
        return true;
    }

    function info(message: string): void
    {
        if (threshold < 3)
        {
            return;
        }
        if (clientLane(message, (chunk) => out?.write(chunk)))
        {
            return;
        }
        const plain = stripAnsi(message).trim();
        if (/^VITE v[\d.]/.test(plain) || /press h \+ enter/.test(plain))
        {
            return;
        }
        if (/^(?:➜\s*)?(?:Local|Network):/.test(plain))
        {
            // TTY: the banner owns the URLs. Piped: the conductor harvests them.
            if (out?.isTTY !== true)
            {
                out?.write(`${ message }\n`);
            }
            return;
        }
        const change = /^(hmr update|page reload)\s+(.*)$/s.exec(plain);
        if (change !== null)
        {
            const verb = change[1] === 'page reload' ? 'reload' : 'hmr';
            out?.write(paint.dim(`${ glyph } ${ verb } ${ change[2] ?? '' }`) + '\n');
        }
        // Remaining info-level chatter (optimize notices, restart rituals) stays quiet.
    }

    return {
        info,
        warn(message: string): void
        {
            if (threshold >= 2 && !clientLane(message, (chunk) => err?.write(chunk)))
            {
                warned = true;
                err?.write(`${ message }\n`);
            }
        },
        warnOnce(message: string): void
        {
            if (threshold >= 2 && !seen.has(message))
            {
                seen.add(message);
                warned = true;
                err?.write(`${ message }\n`);
            }
        },
        error(message: string, options?: LogErrorOptions): void
        {
            if (threshold >= 1)
            {
                if (options?.error !== null && typeof options?.error === 'object')
                {
                    logged.add(options.error);
                }
                if (!clientLane(message, (chunk) => err?.write(chunk)))
                {
                    err?.write(`${ message }\n`);
                }
            }
        },
        // A clear would erase the other lane's history under the conductor; standalone,
        // the banner replaces the cleared-screen ritual.
        clearScreen(_type: LogType): void
        {
            return undefined;
        },
        hasErrorLogged: (error) => logged.has(error),
        get hasWarned()
        {
            return warned;
        }
    };
}
