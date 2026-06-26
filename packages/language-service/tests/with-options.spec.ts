// @vitest-environment node
//
// The `with { ... }` options clause differs per keyword (state/derived take SignalOptions, effect an
// EffectOptions, deferred a timeout, watch `defer`). Completion inside the clause and hover on its
// keys are both driven by the single KEYWORD_OPTIONS registry in language-data, so these guard that
// each keyword surfaces exactly its own options - and that adding/removing one stays in sync.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

function open(name: string, source: string)
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, name)).href;
    service.didOpen(uri, source);
    return { service, uri };
}

/** Position just after `marker` (used to land the caret inside a `with { | }`). */
function posAfter(source: string, marker: string)
{
    const index = source.indexOf(marker) + marker.length;
    const before = source.slice(0, index);
    return { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 };
}

/** The option-key labels (Field kind) offered at a position, sorted. */
function optionLabels(items: { kind?: number; label: string }[])
{
    return items.filter(item => item.kind === 5).map(item => item.label).sort();
}

describe('completion: `with { … }` options per keyword', () =>
{
    it('state → equals, name', () =>
    {
        const src = 'export default component A\n{\n    state c = 0 with {  };\n    <p>x</p>\n}\n';
        const { service, uri } = open('S.azeroth', src);
        expect(optionLabels(service.getCompletions(uri, posAfter(src, 'with { ')))).toEqual(['equals', 'name']);
    });

    it('derived → equals, name (same options as state, after the value)', () =>
    {
        const src = 'export default component A\n{\n    state c = 0;\n    derived t = c() * 2 with {  };\n    <p>x</p>\n}\n';
        const { service, uri } = open('DV.azeroth', src);
        expect(optionLabels(service.getCompletions(uri, posAfter(src, 'with { ')))).toEqual(['equals', 'name']);
    });

    it('effect → name only (NOT equals - different from state)', () =>
    {
        const src = 'export default component A\n{\n    effect with {  }\n    {\n    }\n    <p>x</p>\n}\n';
        const { service, uri } = open('E.azeroth', src);
        expect(optionLabels(service.getCompletions(uri, posAfter(src, 'effect with { ')))).toEqual(['name']);
    });

    it('deferred → timeout', () =>
    {
        const src = 'export default component A\n{\n    state c = 0;\n    deferred d = c() with {  };\n    <p>x</p>\n}\n';
        const { service, uri } = open('D.azeroth', src);
        expect(optionLabels(service.getCompletions(uri, posAfter(src, 'c() with { ')))).toEqual(['timeout']);
    });

    it('effect (deps) → defer', () =>
    {
        const src = 'export default component A\n{\n    state c = 0;\n    effect (c) with {  }\n    {\n    }\n    <p>x</p>\n}\n';
        const { service, uri } = open('W.azeroth', src);
        expect(optionLabels(service.getCompletions(uri, posAfter(src, 'effect (c) with { ')))).toEqual(['defer']);
    });
});

describe('hover: `with { … }` option keys', () =>
{
    it('documents `equals` inside a state with-clause', () =>
    {
        const src = 'export default component A\n{\n    state c = 0 with { equals: (a, b) => a === b };\n    <p>x</p>\n}\n';
        const { service, uri } = open('H.azeroth', src);
        const hover = service.getHover(uri, posAfter(src, 'equa'));
        expect(hover && typeof hover.contents === 'string' ? hover.contents : '').toContain('Custom equality');
    });

    it('keeps the `effect` keyword hover when a `with` clause follows it', () =>
    {
        // Regression: `effect with { ... }` - the keyword is followed by `with`, not its body `{`.
        const src = 'export default component A\n{\n    effect with { name: \'x\' }\n    {\n    }\n    <p>y</p>\n}\n';
        const { service, uri } = open('EH.azeroth', src);
        const hover = service.getHover(uri, { line: 2, character: 6 });
        expect(hover && typeof hover.contents === 'string' ? hover.contents : '').toContain('reactive side effect');
    });
});

describe('diagnostics: unknown `with` option', () =>
{
    const unknownOption = (uri: string, service: AzerothLanguageService) =>
        service.getDiagnostics(uri).find(d => d.code === 'azeroth/unknown-option');

    it('flags a made-up option key for state, listing the allowed ones', () =>
    {
        const src = 'export default component A\n{\n    state c = 0 with { foo: 1 };\n    <p>{c}</p>\n}\n';
        const { service, uri } = open('J1.azeroth', src);
        const diag = unknownOption(uri, service);
        expect(diag?.message).toContain('Unknown option \'foo\'');
        expect(diag?.message).toContain('equals, name');
    });

    it('accepts a valid option (no unknown-option error)', () =>
    {
        const src = 'export default component A\n{\n    state c = 0 with { name: \'s\' };\n    <p>{c}</p>\n}\n';
        const { service, uri } = open('J2.azeroth', src);
        expect(unknownOption(uri, service)).toBeUndefined();
    });

    it('is per-keyword: `equals` is unknown for effect (valid only for state/derived)', () =>
    {
        const src = 'export default component A\n{\n    state c = 0;\n    effect with { equals: 1 }\n    {\n        c;\n    }\n    <p>{c}</p>\n}\n';
        const { service, uri } = open('J3.azeroth', src);
        expect(unknownOption(uri, service)?.message).toContain('Unknown option \'equals\' for `effect`');
    });
});
