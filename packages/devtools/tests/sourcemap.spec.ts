// @vitest-environment node
//
// Creation-line attribution must point at the DECLARATION, not the generated line.
// `Error.stack` frames carry positions in the transformed module Vite serves; pasting
// those onto the `.azeroth` source path landed go-to-file on divider comments and
// neighboring declarations. The fix resolves the frame through the module's served
// source map - these specs weld the devtools decoder to maps the REAL compiler emits
// (not hand-built fixtures), so an encoder change on either side breaks here first.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../../compiler/src/codegen.ts';
import { createPositionResolver, decodeMappedLines, lookupPosition } from '../src/sourcemap.ts';

// Divider comments between declarations - the exact shape that misattributed: the
// state's creation call is EMITTED lines below its declaration, so the raw stack
// line lands on a divider or the next declaration.
const SOURCE = [
    'export default component Dash()',                                       // 1
    '{',                                                                     // 2
    '    // ------------------------------------------------------------',   // 3
    '    // State',                                                          // 4
    '    // ------------------------------------------------------------',   // 5
    '    state count = 0;',                                                  // 6
    '',                                                                      // 7
    '    // ------------------------------------------------------------',   // 8
    '    // Derived',                                                        // 9
    '    // ------------------------------------------------------------',   // 10
    '    derived double = count * 2;',                                       // 11
    '',                                                                      // 12
    '    effect',                                                            // 13
    '    {',                                                                 // 14
    '        console.log(double);',                                          // 15
    '    }',                                                                 // 16
    '',                                                                      // 17
    '    <div>',                                                             // 18
    '        <p>{ count }</p>',                                              // 19
    '    </div>',                                                            // 20
    '}',                                                                     // 21
    ''
].join('\n');

/** The 1-based generated line of the first line containing `needle`, with its column. */
function generatedSite(code: string, needle: string): { line: number; column: number }
{
    const lines = code.split('\n');
    const at = lines.findIndex((l) => l.includes(needle));
    return { line: at + 1, column: (lines[at] ?? '').indexOf(needle) + 1 };
}

/** Serves `compiled` the way Vite does in dev: code + trailing inline base64 map. */
function asServedModule(compiled: { code: string; map: unknown }): string
{
    const b64 = btoa(JSON.stringify(compiled.map));
    return `${ compiled.code }\n//# sourceMappingURL=data:application/json;base64,${ b64 }\n`;
}

describe('creation-line attribution through the served source map', () =>
{
    const compiled = generateModule(SOURCE, 'Dash.azeroth', { ssr: true, dev: true });

    it('pins the symptom: the creation calls are NOT on their declaration lines', () =>
    {
        // What captureOrigin reports raw. If codegen ever becomes line-preserving
        // these move to 6/11/13 and the remap turns into a no-op - fine either way,
        // but this assertion documents why the remap exists.
        expect(generatedSite(compiled.code, 'createSignal(0').line).not.toBe(6);
        expect(generatedSite(compiled.code, 'createMemo(').line).not.toBe(11);
    });

    it('resolves each creation call to its declaration line', async () =>
    {
        const served = asServedModule(compiled);
        const resolve = createPositionResolver(async () => served);
        const url = 'http://localhost:5173/src/Dash.azeroth?t=1';

        const state = generatedSite(compiled.code, 'createSignal(0');
        const memo = generatedSite(compiled.code, 'createMemo(');
        const effect = generatedSite(compiled.code, 'createEffect(');

        expect((await resolve(url, state.line, state.column))?.line).toBe(6);
        expect((await resolve(url, memo.line, memo.column))?.line).toBe(11);
        expect((await resolve(url, effect.line, effect.column))?.line).toBe(13);
    });

    it('fetches and decodes a module once per URL across a creation burst', async () =>
    {
        const served = asServedModule(compiled);
        let fetches = 0;
        const resolve = createPositionResolver(async () =>
        {
            fetches++;
            return served;
        });
        const url = 'http://localhost:5173/src/Dash.azeroth?t=2';
        await Promise.all(Array.from({ length: 40 }, (_v, i) => resolve(url, 1 + (i % 5), 1)));
        expect(fetches).toBe(1);
    });

    it('keeps the raw position when there is no map, the fetch fails, or the URL is not http', async () =>
    {
        const bare = createPositionResolver(async () => compiled.code);
        expect(await bare('http://localhost/src/Dash.azeroth', 9, 1)).toBeNull();

        const failing = createPositionResolver(async () =>
        {
            throw new Error('offline');
        });
        expect(await failing('http://localhost/src/Dash.azeroth', 9, 1)).toBeNull();

        const untouched = createPositionResolver(async () => asServedModule(compiled));
        expect(await untouched('C:\\app\\src\\Dash.azeroth', 9, 1)).toBeNull();
    });

    it('follows a relative sourceMappingURL against the module URL', async () =>
    {
        const requested: string[] = [];
        const resolve = createPositionResolver(async (url) =>
        {
            requested.push(url);
            return url.endsWith('.map')
                ? JSON.stringify(compiled.map)
                : `${ compiled.code }\n//# sourceMappingURL=Dash.azeroth.js.map\n`;
        });
        const state = generatedSite(compiled.code, 'createSignal(0');
        const pos = await resolve('http://localhost:5173/src/Dash.azeroth', state.line, state.column);

        expect(pos?.line).toBe(6);
        expect(requested).toContain('http://localhost:5173/src/Dash.azeroth.js.map');
    });
});

describe('decodeMappedLines', () =>
{
    it('handles 1-field segments and cross-line source-state carry', () =>
    {
        // Line 1: [0,0,0,0] then a 1-field segment (advance genCol only) then [+4,0,+1,0];
        // line 2 carries source state forward: [0,0,+1,0].
        // AAAA = [0,0,0,0]; E = [2]; IACA = [4,0,1,0]; AACA = [0,0,1,0].
        const lines = decodeMappedLines('AAAA,E,IACA;AACA');
        expect(lines[0]).toEqual([[0, 0, 0], [6, 1, 0]]);
        expect(lines[1]).toEqual([[0, 2, 0]]);
    });

    it('lookup takes the greatest segment at-or-before the column and falls back to the first', () =>
    {
        const lines = decodeMappedLines('AAAA,IACA');
        expect(lookupPosition(lines, 1, 1)).toEqual({ line: 1, column: 1 });
        expect(lookupPosition(lines, 1, 9)).toEqual({ line: 2, column: 1 });
        expect(lookupPosition(lines, 2, 1)).toBeNull();
    });
});
