// @vitest-environment node
//
// The interactive primitives, driven by real keypress byte sequences over fake
// streams: selection movement, digit shortcuts, confirm/cancel, the answered-line
// collapse, the non-TTY refusal, and - the part that matters most - that raw mode
// and the cursor are restored on every path out.

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { select, textInput, intro, outro } from '../src/prompt.ts';

interface FakeTty extends Readable
{
    isTTY: boolean;
    isRaw: boolean;
    rawCalls: boolean[];
    setRawMode(this: FakeTty, value: boolean): FakeTty;
}

function fakeInput(): FakeTty
{
    const stream = new Readable({ read()
    { /* pushed manually */ } }) as FakeTty;
    stream.isTTY = true;
    stream.isRaw = false;
    stream.rawCalls = [];
    stream.setRawMode = function (value: boolean)
    {
        this.rawCalls.push(value);
        this.isRaw = value;
        return this;
    };
    return stream;
}

function fakeOutput(): { stream: { write(chunk: string): boolean }; raw: () => string; plain: () => string }
{
    let buffer = '';
    return {
        stream: { write: (chunk: string) =>
        {
            buffer += chunk; return true;
        } },
        raw: () => buffer,
        plain: () => buffer.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[a-zA-Z]', 'g'), '')
    };
}

const CHOICES = [
    { value: 'frontend', hint: 'a vite app' },
    { value: 'backend', hint: 'an http server' },
    { value: 'fullstack', hint: 'both halves' }
] as const;

describe('select', () =>
{
    it('down arrow + enter picks the second option and collapses to an answered line', async () =>
    {
        const input = fakeInput();
        const out = fakeOutput();
        const picked = select('What are you building?', CHOICES, { input, output: out.stream });
        input.push('\u001b[B'); // down
        input.push('\r');       // enter
        await expect(picked).resolves.toBe('backend');
        expect(out.plain()).toContain('What are you building?');
        expect(out.plain()).toContain('backend');
        expect(input.rawCalls).toEqual([true, false]); // raw entered, raw exited
    });

    it('a digit is a shortcut straight to that option', async () =>
    {
        const input = fakeInput();
        const out = fakeOutput();
        const picked = select('Pick', CHOICES, { input, output: out.stream });
        input.push('3');
        await expect(picked).resolves.toBe('fullstack');
    });

    it('ctrl+C cancels with null and still restores the terminal', async () =>
    {
        const input = fakeInput();
        const out = fakeOutput();
        const picked = select('Pick', CHOICES, { input, output: out.stream });
        input.push('\u0003');
        await expect(picked).resolves.toBeNull();
        expect(out.plain()).toContain('cancelled');
        expect(input.rawCalls).toEqual([true, false]);
        // The hidden cursor came back: the show-cursor sequence is in the output.
        expect(out.raw()).toContain('\u001b[?25h');
    });

    it('refuses a non-TTY input - the args path is the non-interactive contract', () =>
    {
        const input = fakeInput();
        input.isTTY = false;
        expect(() => select('Pick', CHOICES, { input, output: fakeOutput().stream })).toThrow(/interactive terminal/);
    });
});

describe('textInput', () =>
{
    it('typed characters + enter resolve to the trimmed answer', async () =>
    {
        const input = fakeInput();
        const out = fakeOutput();
        const answer = textInput('Project name', { input, output: out.stream });
        input.push('my-app\r');
        await expect(answer).resolves.toBe('my-app');
        expect(out.plain()).toContain('my-app');
        expect(input.rawCalls).toEqual([true, false]);
    });

    it('backspace edits; empty answer resolves to "" for the caller default', async () =>
    {
        const input = fakeInput();
        const out = fakeOutput();
        const answer = textInput('Project name', { input, output: out.stream });
        input.push('x');
        input.push('\u007f'); // backspace
        input.push('\r');
        await expect(answer).resolves.toBe('');
    });

    it('ctrl+C cancels with null', async () =>
    {
        const input = fakeInput();
        const answer = textInput('Project name', { input, output: fakeOutput().stream });
        input.push('\u0003');
        await expect(answer).resolves.toBeNull();
    });
});

describe('intro/outro', () =>
{
    it('render the mark, the headline, and the steps as plain text on a non-TTY output', () =>
    {
        const out = fakeOutput();
        intro('create-azeroth', 'v1.0.0', { output: out.stream });
        outro('Scaffolded my-app', ['cd my-app', 'npm install'], { output: out.stream });
        const text = out.plain();
        expect(text).toContain('create-azeroth');
        expect(text).toContain('Scaffolded my-app');
        expect(text).toContain('cd my-app');
        // Non-TTY output means the none tier: no COLOR codes (cursor codes never render here).
        expect(out.raw()).not.toContain('\u001b[3');
    });
});
