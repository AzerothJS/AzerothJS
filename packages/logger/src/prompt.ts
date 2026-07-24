/**
 * MODULE: logger/prompt - the interactive terminal primitives
 *
 * The framework's face when it asks a question: a clack-class select and text input,
 * plus the intro/outro pieces that connect a multi-step flow into one visual column
 * (see DESIGN.md - the glyph set, color roles, and the column are specified there).
 * Zero dependencies: raw readline keypress events over the palette this package
 * already owns.
 *
 * The hard part is not rendering - it is LEAVING THE TERMINAL AS FOUND. Raw mode
 * entered must be raw mode exited and a hidden cursor must be restored on every
 * path out: resolve, cancel (ctrl+C), throw, and process exit while a prompt is
 * live. restore() is idempotent and registered on 'exit' for exactly that reason.
 *
 * The pipe contract: these primitives REFUSE to run on a non-TTY (they throw).
 * Callers guard `isTTY` first and take their non-interactive path - a CI log must
 * never contain half a question.
 */

import { emitKeypressEvents } from 'node:readline';

import { colorTier, palette, supportsUnicode, type Palette } from './color.ts';
import type { WritableLike } from './sinks.ts';

/** One selectable option: the value returned, and a dim hint rendered beside it. */
export interface SelectChoice<T extends string>
{
    value: T;

    /** Short description rendered dim after the value. */
    hint?: string | undefined;
}

/**
 * The structural slice of a TTY input the prompts drive - satisfied by process.stdin
 * and by a plain Readable in tests (concrete ReadStream would demand 30 socket methods
 * no prompt touches).
 */
export type PromptInput = NodeJS.ReadableStream & {
    isTTY?: boolean | undefined;
    isRaw?: boolean | undefined;
    setRawMode(value: boolean): unknown;
};

/** The stream pair a prompt runs on; defaults to process.stdin/stdout. */
export interface PromptIo
{
    input?: PromptInput | undefined;
    output?: WritableLike | undefined;
}

/** @internal The glyph set with its ASCII fallbacks (DESIGN.md table). */
function glyphs(): { ask: string; done: string; on: string; off: string; bar: string; end: string }
{
    return supportsUnicode()
        ? { ask: '◆', done: '◇', on: '●', off: '○', bar: '│', end: '└' }
        : { ask: '*', done: 'o', on: '>', off: ' ', bar: '|', end: '+' };
}

/** @internal Palette for an output stream, honoring the tier rules. */
function paintFor(output: WritableLike | undefined): Palette
{
    return palette(colorTier(output));
}

/** @internal Erases `lines` rendered lines and returns the cursor to their start. */
function eraseLines(output: WritableLike, lines: number): void
{
    output.write(`\u001b[${ String(lines) }A\u001b[0J`);
}

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

/**
 * Arrow-key selection in the interaction column. Returns the chosen value, or null
 * when the user cancels (ctrl+C / escape) - the caller owns the exit code. Keys:
 * up/down (also k/j), a 1-9 shortcut, enter to confirm. On resolve the question
 * collapses to one dim answered line, keeping the column tidy.
 *
 * @throws When the input stream is not a TTY - guard first, take the args path.
 */
export function select<T extends string>(
    message: string,
    choices: ReadonlyArray<SelectChoice<T>>,
    io: PromptIo = {}
): Promise<T | null>
{
    const input: PromptInput = io.input ?? process.stdin;
    const output = io.output ?? process.stdout;
    if (!input.isTTY)
    {
        throw new Error('select() needs an interactive terminal - callers must guard isTTY and take their non-interactive path');
    }
    const paint = paintFor(output);
    const g = glyphs();
    const width = Math.max(...choices.map((choice) => choice.value.length));

    let index = 0;
    let rendered = 0;

    function frame(): string
    {
        let out = `${ paint.brand(g.ask) } ${ paint.bold(message) }\n`;
        for (const [i, choice] of choices.entries())
        {
            const selected = i === index;
            const marker = selected ? paint.brand(g.on) : paint.dim(g.off);
            const label = selected ? paint.bold(choice.value.padEnd(width)) : choice.value.padEnd(width);
            const hint = choice.hint === undefined ? '' : `  ${ paint.dim(choice.hint) }`;
            out += `${ paint.dim(g.bar) } ${ marker } ${ label }${ hint }\n`;
        }
        return out;
    }

    function render(): void
    {
        if (rendered > 0)
        {
            eraseLines(output, rendered);
        }
        const text = frame();
        output.write(text);
        rendered = text.split('\n').length - 1;
    }

    return new Promise<T | null>((resolve) =>
    {
        emitKeypressEvents(input);
        const wasRaw = input.isRaw === true;
        input.setRawMode(true);
        input.resume();
        output.write(HIDE_CURSOR);

        let restored = false;
        const restore = (): void =>
        {
            if (restored)
            {
                return;
            }
            restored = true;
            output.write(SHOW_CURSOR);
            input.setRawMode(wasRaw);
            input.pause();
            input.off('keypress', onKey);
            process.off('exit', restore);
        };
        // A prompt killed mid-flight must not leave the user's terminal raw and cursorless.
        process.on('exit', restore);

        const settle = (value: T | null): void =>
        {
            eraseLines(output, rendered);
            if (value === null)
            {
                output.write(`${ paint.dim(g.done) } ${ paint.dim(message) } ${ paint.red('cancelled') }\n`);
            }
            else
            {
                output.write(`${ paint.dim(g.done) } ${ paint.dim(`${ message } ·`) } ${ paint.bold(value) }\n`);
            }
            restore();
            resolve(value);
        };

        function onKey(char: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void
        {
            const name = key?.name ?? '';
            if ((key?.ctrl === true && name === 'c') || name === 'escape')
            {
                settle(null);
                return;
            }
            if (name === 'return' || name === 'enter')
            {
                settle(choices[index]?.value ?? null);
                return;
            }
            if (name === 'up' || name === 'k')
            {
                index = (index - 1 + choices.length) % choices.length;
                render();
                return;
            }
            if (name === 'down' || name === 'j' || name === 'tab')
            {
                index = (index + 1) % choices.length;
                render();
                return;
            }
            const digit = Number(char);
            if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length)
            {
                index = digit - 1;
                settle(choices[index]?.value ?? null);
            }
        }

        input.on('keypress', onKey);
        render();
    });
}

/**
 * A styled one-line text question in the column. Returns the trimmed answer
 * (possibly empty - the caller applies its default), or null when cancelled.
 *
 * @throws When the input stream is not a TTY - guard first.
 */
export function textInput(message: string, io: PromptIo = {}): Promise<string | null>
{
    const input: PromptInput = io.input ?? process.stdin;
    const output = io.output ?? process.stdout;
    if (!input.isTTY)
    {
        throw new Error('textInput() needs an interactive terminal - callers must guard isTTY and take their non-interactive path');
    }
    const paint = paintFor(output);
    const g = glyphs();
    output.write(`${ paint.brand(g.ask) } ${ paint.bold(message) }\n`);

    return new Promise<string | null>((resolve) =>
    {
        emitKeypressEvents(input);
        const wasRaw = input.isRaw === true;
        input.setRawMode(true);
        input.resume();

        let buffer = '';
        let restored = false;
        const restore = (): void =>
        {
            if (restored)
            {
                return;
            }
            restored = true;
            input.setRawMode(wasRaw);
            input.pause();
            input.off('keypress', onKey);
            process.off('exit', restore);
        };
        process.on('exit', restore);

        const prompt = (): void =>
        {
            output.write(`\r\u001b[2K${ paint.dim(g.bar) } ${ buffer }`);
        };

        function onKey(char: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void
        {
            const name = key?.name ?? '';
            if (key?.ctrl === true && name === 'c')
            {
                output.write(`\r\u001b[2K\u001b[1A\u001b[2K${ paint.dim(g.done) } ${ paint.dim(message) } ${ paint.red('cancelled') }\n`);
                restore();
                resolve(null);
                return;
            }
            if (name === 'return' || name === 'enter')
            {
                const answer = buffer.trim();
                output.write(`\r\u001b[2K\u001b[1A\u001b[2K${ paint.dim(g.done) } ${ paint.dim(`${ message } ·`) } ${ paint.bold(answer === '' ? '(default)' : answer) }\n`);
                restore();
                resolve(answer);
                return;
            }
            if (name === 'backspace')
            {
                buffer = buffer.slice(0, -1);
                prompt();
                return;
            }
            if (typeof char === 'string' && char >= ' ')
            {
                buffer += char;
                prompt();
            }
        }

        input.on('keypress', onKey);
        prompt();
    });
}

/** The flow's opening line: the mark, a bold title, an optional dim subtitle. */
export function intro(title: string, subtitle?: string, io: PromptIo = {}): void
{
    const output = io.output ?? process.stdout;
    const paint = paintFor(output);
    const mark = supportsUnicode() ? '▲' : 'A';
    output.write(`\n${ paint.brand(`${ mark } ${ paint.bold(title) }`) }${ subtitle === undefined ? '' : `  ${ paint.dim(subtitle) }` }\n\n`);
}

/** The flow's closing block: the end glyph, a bold headline, then indented dim-free steps. */
export function outro(headline: string, steps: readonly string[] = [], io: PromptIo = {}): void
{
    const output = io.output ?? process.stdout;
    const paint = paintFor(output);
    const g = glyphs();
    output.write(`\n${ paint.brand(g.end) } ${ paint.bold(headline) }\n`);
    if (steps.length > 0)
    {
        output.write('\n');
        for (const step of steps)
        {
            output.write(`  ${ paint.brand('$') } ${ step }\n`);
        }
        output.write('\n');
    }
}
