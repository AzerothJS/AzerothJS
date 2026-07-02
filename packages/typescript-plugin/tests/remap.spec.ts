// @vitest-environment node
//
// The tsserver plugin serves each `.azeroth` file's COMPILED virtual TypeScript as its content, so
// navigation results computed inside those files carry VIRTUAL offsets. VS Code renders spans
// against the on-disk `.azeroth` source, so without remapping Find References shows garbage ranges,
// Go To Definition lands mid-identifier, and a cross-file Rename would edit the wrong ranges. These
// tests drive a REAL ts.LanguageService through the exact plugin path (host decoration + service
// proxy) from the `.ts` side - the direction VS Code's built-in TypeScript uses - and assert every
// span extracts the exact identifier text from the real `.azeroth` source.

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decorateLanguageServiceHost } from '../src/decorate.ts';
import { remapLanguageService } from '../src/remap.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures').replace(/\\/g, '/');
const norm = (p: string): string => p.replace(/\\/g, '/');
const fixture = (name: string): string => norm(path.join(dir, name));

const files = ['util.ts', 'main.ts', 'Widget.azeroth', 'Consumer.azeroth'].map(fixture);
const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true
};

/** A language service wired exactly like the plugin wires tsserver's: decorated host + remap proxy. */
function createPluginService(): ts.LanguageService
{
    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => files,
        getScriptVersion: () => '1',
        getScriptSnapshot: (f) =>
        {
            const text = ts.sys.readFile(f);
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => dir,
        getCompilationSettings: () => options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories
    };
    const virtual = decorateLanguageServiceHost(ts, host);
    return remapLanguageService(ts.createLanguageService(host, ts.createDocumentRegistry()), virtual);
}

/** The exact text a span selects in the REAL on-disk file - the editor's view of the result. */
function spanText(fileName: string, span: ts.TextSpan): string
{
    return fs.readFileSync(fileName, 'utf8').slice(span.start, span.start + span.length);
}

const utilPath = fixture('util.ts');
const mainPath = fixture('main.ts');
const utilSrc = fs.readFileSync(utilPath, 'utf8');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

describe('tsserver plugin - result spans land on .azeroth SOURCE text (queries from .ts)', () =>
{
    const service = createPluginService();
    const declPos = utilSrc.indexOf('formatGold');

    it('findReferences: every .azeroth entry selects the exact identifier', () =>
    {
        const refs = (service.findReferences(utilPath, declPos) ?? []).flatMap(s => s.references);
        const azeroth = refs.filter(r => r.fileName.endsWith('.azeroth'));
        // import + two markup usages inside Widget.azeroth
        expect(azeroth.length).toBe(3);
        for (const ref of azeroth)
        {
            expect(spanText(ref.fileName, ref.textSpan)).toBe('formatGold');
        }
        // and the plain .ts usages are still present
        expect(refs.some(r => r.fileName.endsWith('main.ts'))).toBe(true);
    });

    it('getDefinitionAndBoundSpan: the component import resolves onto the `component` name', () =>
    {
        const wPos = mainSrc.indexOf('Widget');
        const defs = service.getDefinitionAndBoundSpan(mainPath, wPos)?.definitions ?? [];
        expect(defs.length).toBeGreaterThan(0);
        const target = defs[0];
        expect(target.fileName.endsWith('Widget.azeroth')).toBe(true);
        expect(spanText(target.fileName, target.textSpan)).toBe('Widget');
    });

    it('findRenameLocations: renaming from the .ts side edits exact ranges in .azeroth', () =>
    {
        const locations = service.findRenameLocations(utilPath, declPos, false, false, {}) ?? [];
        const azeroth = locations.filter(l => l.fileName.endsWith('.azeroth'));
        expect(azeroth.length).toBe(3);
        for (const loc of azeroth)
        {
            expect(spanText(loc.fileName, loc.textSpan)).toBe('formatGold');
        }
    });

    it('getReferencesAtPosition mirrors findReferences remapping', () =>
    {
        const refs = service.getReferencesAtPosition(utilPath, declPos) ?? [];
        for (const ref of refs.filter(r => r.fileName.endsWith('.azeroth')))
        {
            expect(spanText(ref.fileName, ref.textSpan)).toBe('formatGold');
        }
    });
});
