// @azerothjs/typescript-plugin makes tsserver resolve `.azeroth` imports from
// `.ts` files with REAL types - the @vue/typescript-plugin equivalent. These
// tests drive the plugin's host decoration through a constructed
// ts.LanguageService (exactly what tsserver builds) over a fixture that has NO
// `declare module '*.azeroth'` shim, and assert that default, named, and type
// exports all resolve - and that a genuine type error still surfaces.

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { decorateLanguageServiceHost } from '../../packages/typescript-plugin/src/decorate.ts';

// Forward-slash paths: the TypeScript language service normalizes file names to
// forward slashes internally, so the in-memory overlay keys must match.
const APP = path.join(process.cwd(), 'test', 'typescript-plugin', 'fixtures', 'app').replace(/\\/g, '/');
const CONSUMER = `${ APP }/consumer.ts`;

/** Builds a language service over the fixture with `consumer.ts` held in memory. */
function serviceWith(consumerSource: string): ts.LanguageService
{
    const overlay = new Map<string, string>([[CONSUMER, consumerSource]]);

    const host: ts.LanguageServiceHost =
    {
        getScriptFileNames: () => [...overlay.keys()],
        getScriptVersion: (fileName) =>
            overlay.has(fileName) ? '1' : String(ts.sys.getModifiedTime?.(fileName)?.getTime() ?? 0),
        getScriptSnapshot: (fileName) =>
        {
            if (overlay.has(fileName))
            {
                return ts.ScriptSnapshot.fromString(overlay.get(fileName)!);
            }
            const contents = ts.sys.readFile(fileName);
            return contents === undefined ? undefined : ts.ScriptSnapshot.fromString(contents);
        },
        getCurrentDirectory: () => APP,
        getCompilationSettings: () => ({
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            strict: true,
            noEmit: true,
            jsx: ts.JsxEmit.Preserve,
            skipLibCheck: true,
            allowImportingTsExtensions: true,
            lib: ['lib.esnext.d.ts', 'lib.dom.d.ts']
        }),
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        fileExists: (fileName) => overlay.has(fileName) || ts.sys.fileExists(fileName),
        readFile: (fileName, encoding) => overlay.has(fileName) ? overlay.get(fileName) : ts.sys.readFile(fileName, encoding),
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories
    };

    decorateLanguageServiceHost(ts, host);
    return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function messages(service: ts.LanguageService): string[]
{
    return service.getSemanticDiagnostics(CONSUMER)
        .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const CLEAN = [
    "import Breadcrumb, { SEP } from './bc.component.azeroth';",
    "import type { BreadcrumbCrumb } from './bc.component.azeroth';",
    "const crumb: BreadcrumbCrumb = { label: 'Home', href: '/' };",
    'const sep: string = SEP;',
    'const el = Breadcrumb({ crumbs: [crumb] });',
    'export { Breadcrumb, SEP, el, sep };',
    'export type { BreadcrumbCrumb };'
].join('\n');

describe('@azerothjs/typescript-plugin resolves .azeroth imports with real types', () =>
{
    it('has no hand-written *.azeroth shim in the fixture', () =>
    {
        // The whole point: the consuming app deletes its shim and still checks.
        const dts = readdirSync(APP).filter(f => f.endsWith('.d.ts'));
        expect(dts).toEqual([]);
        expect(existsSync(path.join(APP, 'shims-azeroth.d.ts'))).toBe(false);
    });

    it('type-checks a .ts barrel using default, named, and type exports (no shim)', () =>
    {
        expect(messages(serviceWith(CLEAN))).toEqual([]);
    });

    it('resolves the default export to its real function type, not any', () =>
    {
        const service = serviceWith(CLEAN);
        const offset = CLEAN.indexOf('Breadcrumb({ crumbs');
        const info = service.getQuickInfoAtPosition(CONSUMER, offset);
        const text = (info?.displayParts ?? []).map(p => p.text).join('');
        expect(text).toContain('crumbs');
        expect(text).toContain('BreadcrumbCrumb');
        expect(text).not.toMatch(/:\s*any/);
    });

    it('surfaces a genuine type error against the real named-import type', () =>
    {
        const bad = [
            "import type { BreadcrumbCrumb } from './bc.component.azeroth';",
            "const crumb: BreadcrumbCrumb = { label: 'Home', href: '/' };",
            'const oops: number = crumb.label;'
        ].join('\n');
        expect(messages(serviceWith(bad)).join('\n')).toContain('not assignable to type \'number\'');
    });

    it('surfaces a missing-property error against the real interface', () =>
    {
        const bad = [
            "import type { BreadcrumbCrumb } from './bc.component.azeroth';",
            "const crumb: BreadcrumbCrumb = { label: 'Home' };"
        ].join('\n');
        expect(messages(serviceWith(bad)).join('\n')).toMatch(/href|missing/i);
    });
});
