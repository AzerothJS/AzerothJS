// @vitest-environment node
//
// `prettySink` and `ndjsonSink` take an OPTIONS OBJECT (`{ stream }`), not a stream. Handing them
// a stream directly made the stream the options bag: `options.stream` was undefined, the sink fell
// back to stdout, and the configured file stayed empty. Silently.
//
// TypeScript rejects it - a writable has no properties in common with the options type - so a TS
// caller is safe. A JavaScript caller was not, and the failure reads as "logging is broken" with
// nothing pointing at the cause: no error, an empty log file, and every line on stdout instead.
// A logger that quietly writes somewhere other than where it was told is worse than one that
// throws, because the first thing it loses is the evidence of its own misconfiguration.
import { describe, expect, it } from 'vitest';

import { ndjsonSink, prettySink } from '../src/sinks.ts';

/** A minimal writable - what a caller means when they pass "the stream". */
function collector(): { write(chunk: string): void; lines: string[] }
{
    const lines: string[] = [];
    return { write: (chunk: string) => void lines.push(chunk), lines };
}

describe('a sink refuses a stream handed in place of its options', () =>
{
    it('throws for prettySink rather than falling back to stdout', () =>
    {
        const stream = collector();

        expect(() => prettySink(stream as never)).toThrow(/options object|\{ stream/i);
    });

    it('throws for ndjsonSink rather than falling back to stdout', () =>
    {
        const stream = collector();

        expect(() => ndjsonSink(stream as never)).toThrow(/options object|\{ stream/i);
    });

    it('still accepts the correct call, and writes where it was told', () =>
    {
        const pretty = collector();
        const json = collector();

        prettySink({ stream: pretty })({ level: 'info', time: 0, message: 'hello', fields: {} });
        ndjsonSink({ stream: json })({ level: 'info', time: 0, message: 'hello', fields: {} });

        expect(pretty.lines.join('')).toContain('hello');
        expect(json.lines.join('')).toContain('"msg":"hello"');
    });

    it('still accepts no argument at all, which means stdout', () =>
    {
        expect(() => prettySink()).not.toThrow();
        expect(() => ndjsonSink()).not.toThrow();
        expect(() => prettySink({})).not.toThrow();
        expect(() => ndjsonSink({})).not.toThrow();
    });
});
