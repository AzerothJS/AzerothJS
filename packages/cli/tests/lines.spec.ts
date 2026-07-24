// @vitest-environment node
//
// The dev conductor's line discipline: step classification, the ready-signal
// extractors, and the chatter rewriters. Every input line here was captured from a
// real `azeroth dev` session (tsc 5.7 watch, node --watch, vite 8, @azerothjs/logger
// both faces) - the rewriters are tested against what the tools actually print.

import { describe, it, expect, beforeAll } from 'vitest';
import { palette } from '@azerothjs/logger';
import { classifyStep, serverUrl, stripAnsi, transformLine, tscReport, viteUrl } from '../src/lines.ts';

// Glyph choice reads the environment; pin it so assertions are deterministic.
beforeAll(() =>
{
    process.env.WT_SESSION = 'test';
});

const plain = palette('none');

// Real captures (ANSI written as \u001b escapes, exactly as the tools emitted them).
const TSC_START = '11:32:31 AM - Starting compilation in watch mode...';
const TSC_INCREMENTAL = '11:41:02 AM - File change detected. Starting incremental compilation...';
const TSC_CLEAN = '11:32:32 AM - Found 0 errors. Watching for file changes.';
const TSC_ONE = '11:41:03 AM - Found 1 error. Watching for file changes.';
const TSC_MANY = '11:41:03 AM - Found 3 errors. Watching for file changes.';
const TSC_DIAGNOSTIC = "src/main.ts:23:5 - error TS2322: Type 'string' is not assignable to type 'number'.";
const NODE_RESTART = "Restarting 'dist/main.js'";
// Without --watch-preserve-output node prefixes the notice with a bare RIS reset;
// stripAnsi must see through it (belt to the plan's --watch-preserve-output braces).
const NODE_RESTART_RESET = '\u001bc' + "Restarting 'dist/main.js'";
const NODE_COMPLETED = "Completed running 'dist/main.js'";
const NODE_FAILED = "Failed running 'dist/main.js'";
const VITE_READY = '  \u001b[32m\u001b[1mVITE\u001b[22m v8.1.5\u001b[39m  \u001b[2mready in \u001b[0m\u001b[1m3039\u001b[22m\u001b[2m\u001b[0m ms\u001b[22m';
const VITE_LOCAL = '  \u001b[32m\u279c\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m1420\u001b[22m/\u001b[39m';
const VITE_NETWORK = '\u001b[2m  \u001b[32m\u279c\u001b[39m  \u001b[1mNetwork\u001b[22m\u001b[2m: use \u001b[22m\u001b[1m--host\u001b[22m\u001b[2m to expose\u001b[22m';
const VITE_HELP = '\u001b[2m  \u001b[32m\u279c\u001b[39m\u001b[2m  press \u001b[22m\u001b[1mh + enter\u001b[22m\u001b[2m to show help\u001b[22m';
const VITE_REOPTIMIZE = '11:05:33 AM \u001b[36m\u001b[1m[vite]\u001b[22m\u001b[39m (client) Re-optimizing dependencies because lockfile has changed';
const LISTEN_PRETTY = '11:30:39.635 \u25cf info  listening  service=euphoria-api  url=http://localhost:5200  env=development';
const LISTEN_NDJSON = '{"level":"info","time":1784880087618,"msg":"listening","service":"euphoria-api","url":"http://localhost:5200","env":"development"}';

describe('stripAnsi', () =>
{
    it('removes styling and keeps the bytes that matter', () =>
    {
        expect(stripAnsi(VITE_LOCAL)).toContain('Local:   http://localhost:1420/');
        expect(stripAnsi(TSC_CLEAN)).toBe(TSC_CLEAN);
    });
});

describe('classifyStep', () =>
{
    it('recognizes each dev child by what it invokes', () =>
    {
        expect(classifyStep({ script: null, args: ['--watch', 'dist/main.js'] })).toBe('node-watch');
        expect(classifyStep({ script: 'C:\\p\\node_modules\\typescript\\bin\\tsc', args: ['-w', '--pretty', '-p', 'tsconfig.json'] })).toBe('tsc-watch');
        expect(classifyStep({ script: '/p/node_modules/typescript/bin/tsc', args: ['-p', 'tsconfig.json'] })).toBe('other');
        expect(classifyStep({ script: '/p/node_modules/vite/bin/vite.js', args: [] })).toBe('vite');
        expect(classifyStep({ script: '/p/node_modules/eslint/bin/eslint.js', args: ['.'] })).toBe('other');
    });
});

describe('ready signals', () =>
{
    it('reads the compile report error count', () =>
    {
        expect(tscReport(TSC_CLEAN)).toBe(0);
        expect(tscReport(TSC_ONE)).toBe(1);
        expect(tscReport(TSC_MANY)).toBe(3);
        expect(tscReport(TSC_START)).toBeNull();
        expect(tscReport(TSC_DIAGNOSTIC)).toBeNull();
    });

    it('extracts the server URL from either logger face', () =>
    {
        expect(serverUrl(LISTEN_PRETTY)).toBe('http://localhost:5200');
        expect(serverUrl(LISTEN_NDJSON)).toBe('http://localhost:5200');
        expect(serverUrl(NODE_RESTART)).toBeNull();
    });

    it('survives the pretty face dropping url= and any message casing', () =>
    {
        // The current pretty face: bare brand URL, no url= label (the tautology drop).
        expect(serverUrl('12:59:56 ● Listening · http://localhost:5200 · env=development')).toBe('http://localhost:5200');
        expect(serverUrl('LISTENING http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
        // A URL with no listening word is NOT a signal (request lines carry paths).
        expect(serverUrl('GET /x → 200 · 1ms http://example.com')).toBeNull();
    });

    it('extracts the vite Local URL through its inline styling', () =>
    {
        expect(viteUrl(VITE_LOCAL)).toBe('http://localhost:1420/');
        expect(viteUrl(VITE_READY)).toBeNull();
    });
});

describe('transformLine', () =>
{
    it('swallows blank lines for every kind', () =>
    {
        for (const kind of ['tsc-watch', 'node-watch', 'vite', 'other'] as const)
        {
            expect(transformLine(kind, '', plain)).toBeNull();
            expect(transformLine(kind, '   ', plain)).toBeNull();
        }
    });

    it('rewrites tsc session chatter and keeps the error count honest', () =>
    {
        expect(transformLine('tsc-watch', TSC_START, plain)).toBe('compiling...');
        expect(transformLine('tsc-watch', TSC_INCREMENTAL, plain)).toBe('recompiling...');
        expect(transformLine('tsc-watch', TSC_CLEAN, plain)).toBe('\u2713 compiled clean');
        expect(transformLine('tsc-watch', TSC_ONE, plain)).toBe('\u2716 1 error - watching');
        expect(transformLine('tsc-watch', TSC_MANY, plain)).toBe('\u2716 3 errors - watching');
    });

    it('passes tsc diagnostics through byte-intact', () =>
    {
        expect(transformLine('tsc-watch', TSC_DIAGNOSTIC, plain)).toBe(TSC_DIAGNOSTIC);
    });

    it('rewrites node --watch lifecycle lines', () =>
    {
        expect(transformLine('node-watch', NODE_RESTART, plain)).toBe('\u21bb restarting');
        expect(transformLine('node-watch', NODE_RESTART_RESET, plain)).toBe('\u21bb restarting');
        expect(transformLine('node-watch', NODE_COMPLETED, plain)).toBe('process exited - waiting for changes');
        expect(transformLine('node-watch', NODE_FAILED, plain)).toBe('\u2716 crashed - waiting for changes');
    });

    it('passes app log lines through the node-watch child untouched', () =>
    {
        expect(transformLine('node-watch', LISTEN_PRETTY, plain)).toBe(LISTEN_PRETTY);
    });

    it('suppresses the vite identity block (the ready frame owns those facts)', () =>
    {
        expect(transformLine('vite', VITE_READY, plain)).toBeNull();
        expect(transformLine('vite', VITE_LOCAL, plain)).toBeNull();
        expect(transformLine('vite', VITE_NETWORK, plain)).toBeNull();
        expect(transformLine('vite', VITE_HELP, plain)).toBeNull();
    });

    it('keeps every other vite line (re-optimizing, HMR, errors)', () =>
    {
        expect(transformLine('vite', VITE_REOPTIMIZE, plain)).toBe(VITE_REOPTIMIZE);
    });

    it('styles rewritten lines when the palette has color', () =>
    {
        const colored = transformLine('tsc-watch', TSC_CLEAN, palette('basic'));
        expect(colored).toContain('\u001b[32m');
        expect(stripAnsi(colored ?? '')).toBe('\u2713 compiled clean');
    });
});
