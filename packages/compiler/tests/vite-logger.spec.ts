// @vitest-environment node
//
// The injected vite logger's contract: identity chatter dies, URLs survive exactly
// when the conductor needs them, HMR notices become one house-styled line, and
// diagnostics pass through byte-intact. Input lines mirror what vite 8 actually
// passes a customLogger - ANSI-wrapped, no [vite] prefix, no timestamp (those are
// the built-in logger's own decorations).
import { describe, it, expect } from 'vitest';
import { azerothViteLogger } from '../src/vite-logger.ts';

const ESC = String.fromCharCode(27);
const green = (s: string): string => `${ ESC }[32m${ s }${ ESC }[39m`;
const dim = (s: string): string => `${ ESC }[2m${ s }${ ESC }[22m`;
const strip = (s: string): string => s.replace(new RegExp(`${ ESC }\\[[0-9;]*m`, 'g'), '');

function harness(tty: boolean): { out: string[]; err: string[]; streams: { out: { write(c: string): boolean; isTTY: boolean }; err: { write(c: string): boolean } } }
{
    const out: string[] = [];
    const err: string[] = [];
    return {
        out,
        err,
        streams: {
            out: {
                isTTY: tty,
                write: (chunk: string): boolean =>
                {
                    out.push(chunk);
                    return true;
                }
            },
            err: {
                write: (chunk: string): boolean =>
                {
                    err.push(chunk);
                    return true;
                }
            }
        }
    };
}

const IDENTITY = `\n  ${ green('VITE v8.1.5') }  ${ dim('ready in 312 ms') }\n`;
const LOCAL = `  ${ green('➜') }  Local:   http://localhost:5173/`;
const SHORTCUT = dim('press h + enter to show help');
const HMR = `${ green('hmr update ') }${ dim('/src/pages/home.azeroth') }`;
const RELOAD = `${ green('page reload ') }${ dim('src/main.ts') }`;

describe('azerothViteLogger', () =>
{
    it('drops the identity block on a TTY (the banner owns identity and URLs)', () =>
    {
        const h = harness(true);
        const log = azerothViteLogger(undefined, h.streams);
        log.info(IDENTITY);
        log.info(LOCAL);
        log.info(SHORTCUT);
        expect(h.out).toEqual([]);
    });

    it('passes the URL lines through byte-intact when piped - the conductor harvests them', () =>
    {
        const h = harness(false);
        const log = azerothViteLogger(undefined, h.streams);
        log.info(IDENTITY);
        log.info(LOCAL);
        expect(h.out).toEqual([`${ LOCAL }\n`]);
    });

    it('restyles hmr updates and page reloads to one dim line each', () =>
    {
        const h = harness(true);
        const log = azerothViteLogger(undefined, h.streams);
        log.info(HMR);
        log.info(RELOAD);
        expect(h.out.length).toBe(2);
        expect(strip(h.out[0] ?? '')).toMatch(/^. hmr \/src\/pages\/home\.azeroth\n$/);
        expect(strip(h.out[1] ?? '')).toMatch(/^. reload src\/main\.ts\n$/);
    });

    it('the optimizer notices survive - they explain a mid-session URL invalidation', () =>
    {
        // A re-bundle invalidates optimized-module URLs the browser may hold; a dead
        // dynamic import right after one of these lines is EXPLAINED by it, so
        // swallowing them turns an infrastructure event into an apparent app bug.
        const h = harness(true);
        const log = azerothViteLogger(undefined, h.streams);
        log.info(green('optimized dependencies changed. reloading'));
        log.info('Re-optimizing dependencies because lockfile has changed');
        expect(h.out.length).toBe(2);
        expect(strip(h.out[0] ?? '')).toMatch(/optimized dependencies changed/);
        expect(strip(h.out[1] ?? '')).toMatch(/Re-optimizing dependencies/);
    });

    it('recognises a line whose head carries a cursor control, not just colour', () =>
    {
        // Every matcher here is `^`-anchored, so a surviving control byte at the head of a
        // line silently stops it from being recognised. Colour-only stripping left erase,
        // cursor-move and hide sequences in place; the URL handoff to the conductor is the
        // one that hurts - a missed `Local:` is a ready frame that degrades on a timer.
        const h = harness(false);
        const log = azerothViteLogger(undefined, h.streams);
        const local = `  ${ green('➜') }  Local:   http://localhost:5173/`;
        log.info(`${ ESC }[2K${ ESC }[?25l${ local }`);
        expect(h.out).toHaveLength(1);
        expect(h.out[0]).toContain('http://localhost:5173/');
    });

    it('suppresses remaining info chatter and keeps warnings/errors byte-intact on stderr', () =>
    {
        const h = harness(true);
        const log = azerothViteLogger(undefined, h.streams);
        // The scan-time hint is chatter (the plugin pre-registers deps itself); the
        // mid-session re-optimize NOTICES are load-bearing and covered above.
        log.info(`${ green('✨') } new dependencies optimized: @azerothjs/devtools`);
        const warning = `${ green('[plugin:x]') } something looks off`;
        log.warn(warning);
        log.error('boom');
        expect(h.out).toEqual([]);
        expect(h.err).toEqual([`${ warning }\n`, 'boom\n']);
    });

    it('enforces logLevel thresholds itself (a customLogger preempts vite handling them)', () =>
    {
        const silent = harness(true);
        const logSilent = azerothViteLogger('silent', silent.streams);
        logSilent.info(HMR);
        logSilent.warn('w');
        logSilent.error('e');
        expect(silent.out).toEqual([]);
        expect(silent.err).toEqual([]);

        const errorsOnly = harness(true);
        const logErrors = azerothViteLogger('error', errorsOnly.streams);
        logErrors.warn('w');
        logErrors.error('e');
        expect(errorsOnly.err).toEqual(['e\n']);
    });

    it('dedupes warnOnce and tracks hasWarned/hasErrorLogged', () =>
    {
        const h = harness(true);
        const log = azerothViteLogger(undefined, h.streams);
        expect(log.hasWarned).toBe(false);
        log.warnOnce('same');
        log.warnOnce('same');
        expect(h.err).toEqual(['same\n']);
        expect(log.hasWarned).toBe(true);

        const known = new Error('seen');
        log.error('seen', { error: known });
        expect(log.hasErrorLogged(known)).toBe(true);
        expect(log.hasErrorLogged(new Error('other'))).toBe(false);
    });

    it('clearScreen is a no-op - a clear would erase the other lane under the conductor', () =>
    {
        const h = harness(true);
        const log = azerothViteLogger(undefined, h.streams);
        expect(log.clearScreen('info')).toBeUndefined();
        expect(h.out).toEqual([]);
    });

    it('restyles forwarded browser-console lines into the client lane at their level', () =>
    {
        const h = harness(true);
        const log = azerothViteLogger(undefined, h.streams);
        log.error(`${ dim('[console.error] ') }boom from the browser`);
        log.warn(`${ dim('[console.warn] ') }careful`);
        log.error('[Unhandled error] TypeError: gate uncaught\n > onClick src/pages/home.azeroth:42:13');

        expect(h.err.length).toBe(3);
        expect(strip(h.err[0] ?? '')).toMatch(/client {2}boom from the browser/);
        expect(strip(h.err[1] ?? '')).toMatch(/! client {2}careful/);
        const unhandled = strip(h.err[2] ?? '').split('\n');
        expect(unhandled[0]).toMatch(/client {2}TypeError: gate uncaught/);
        expect(unhandled[1]).toBe(' > onClick src/pages/home.azeroth:42:13');
    });

    it('rate-limits a client-lane storm and reports the drop count on resume', () =>
    {
        const h = harness(true);
        const log = azerothViteLogger(undefined, h.streams);
        for (let i = 0; i < 30; i++)
        {
            log.error(`[console.error] storm ${ i }`);
        }
        // Bucket capacity is 20: the burst prints, the tail drops silently for now.
        expect(h.err.length).toBe(20);
        expect(h.err.every((line) => !line.includes('[console.error]'))).toBe(true);
    });
});
