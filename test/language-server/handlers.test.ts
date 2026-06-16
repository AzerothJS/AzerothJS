// The language server (startServer) is the thin LSP translation layer over the
// AzerothLanguageService. parseSettings is unit-tested elsewhere; what is NOT
// covered is the wiring inside startServer - that every handler honours the
// per-feature toggles, guards non-.azeroth URIs, and maps the service's results
// back. These tests drive startServer through a mock Connection that captures
// every registered handler, then fire each one against a real .azeroth document
// resolved at a fixture root (so the TypeScript bridge actually loads).

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToUri } from '@azerothjs/language-service';
// Import the server source directly (mirroring combined-checker.test.ts): there
// is no vitest alias for @azerothjs/language-server, so the package specifier
// would resolve to its built dist, which may be stale during a source change.
import { startServer } from '../../packages/language-server/src/server.ts';
import { makeMockConnection, at, type Captured } from './_mock-connection.ts';

const FIX = path.join(process.cwd(), 'test', 'language-server', 'fixtures', 'combined');
const ROOT_URI = pathToUri(FIX);
const DOC_PATH = path.join(FIX, 'uses.azeroth');
const DOC_URI = pathToUri(DOC_PATH);
const DOC_TEXT = readFileSync(DOC_PATH, 'utf8');

/** Boots a server, initializes it at the fixture root, and opens uses.azeroth. */
async function boot(): Promise<{ captured: Captured; getConfig: { value: Record<string, unknown> } }>
{
    const { connection, captured, getConfig } = makeMockConnection();
    startServer(connection as never);

    // `workspace.configuration: true` is what flips hasConfigurationCapability on,
    // so the later onDidChangeConfiguration actually re-pulls settings.
    captured.onInitialize?.({
        capabilities: { workspace: { configuration: true } },
        workspaceFolders: [{ uri: ROOT_URI, name: 'fix' }]
    });
    captured.onInitialized?.({});

    // Simulate the client opening the document; TextDocuments fires onDidOpen,
    // which syncs the text into the service.
    captured.onDidOpenTextDocument?.({
        textDocument: { uri: DOC_URI, languageId: 'azeroth', version: 1, text: DOC_TEXT }
    });

    return { captured, getConfig };
}

/** Re-pushes config and fires onDidChangeConfiguration so settings refresh. */
async function setConfig(captured: Captured, getConfig: { value: Record<string, unknown> }, cfg: Record<string, unknown>): Promise<void>
{
    getConfig.value = cfg;
    await captured.onDidChangeConfiguration?.({ settings: {} });
}

const td = { textDocument: { uri: DOC_URI } };
const otherTd = { textDocument: { uri: pathToUri(path.join(FIX, 'index.ts')) } };
const titlePos = at(DOC_TEXT, 'title=', 0);

describe('startServer - handler registration and feature gating', () =>
{
    let captured: Captured;
    let getConfig: { value: Record<string, unknown> };

    beforeAll(async () =>
    {
        ({ captured, getConfig } = await boot());
    });

    it('registers every handler server.ts advertises', () =>
    {
        const keys: (keyof Captured)[] = [
            'onInitialize', 'onInitialized', 'onDidChangeConfiguration', 'onCompletion',
            'onCompletionResolve', 'onHover', 'onDefinition', 'onTypeDefinition',
            'onReferences', 'onDocumentHighlight', 'onRenameRequest', 'onDocumentSymbol',
            'onWorkspaceSymbol', 'onSignatureHelp', 'onFoldingRanges', 'onCodeAction',
            'onDocumentFormatting', 'onSelectionRanges', 'onDocumentOnTypeFormatting',
            'onLinkedEditingRange', 'inlayHint', 'semanticTokens'
        ];
        for (const key of keys)
        {
            expect(captured[key], `${ key } should be registered`).toBeTypeOf('function');
        }
        expect(captured.requests.has('azeroth/autoInsert')).toBe(true);
    });

    it('onInitialize advertises the full capability set', () =>
    {
        const result = captured.onInitialize?.({
            capabilities: { workspace: { configuration: true } },
            workspaceFolders: [{ uri: ROOT_URI, name: 'fix' }]
        }) as { capabilities: Record<string, unknown> };
        const caps = result.capabilities;
        expect(caps.completionProvider).toBeTruthy();
        expect(caps.hoverProvider).toBe(true);
        expect(caps.definitionProvider).toBe(true);
        expect(caps.documentSymbolProvider).toBe(true);
        expect(caps.semanticTokensProvider).toBeTruthy();
    });

    describe('happy path - non-empty mapped results', () =>
    {
        it('completion returns items', () =>
        {
            const items = captured.onCompletion?.({ ...td, position: titlePos }) as unknown[];
            expect(Array.isArray(items)).toBe(true);
            expect(items.length).toBeGreaterThan(0);
        });

        it('hover returns markdown contents', () =>
        {
            // Hover over the imported `Modal` tag name resolves the component type.
            const hover = captured.onHover?.({ ...td, position: at(DOC_TEXT, '<Modal', 1) }) as { contents: { kind: string } } | null;
            expect(hover).not.toBeNull();
            expect(hover!.contents.kind).toBe('markdown');
        });

        it('definition returns at least one location', () =>
        {
            const defs = captured.onDefinition?.({ ...td, position: at(DOC_TEXT, '<Modal', 1) }) as unknown[];
            expect(Array.isArray(defs)).toBe(true);
            expect(defs.length).toBeGreaterThan(0);
        });

        it('documentSymbol returns symbols', () =>
        {
            const symbols = captured.onDocumentSymbol?.(td) as unknown[];
            expect(Array.isArray(symbols)).toBe(true);
            expect(symbols.length).toBeGreaterThan(0);
        });

        it('semanticTokens returns a non-empty data array', () =>
        {
            const tokens = captured.semanticTokens?.(td) as { data: number[] };
            expect(Array.isArray(tokens.data)).toBe(true);
            expect(tokens.data.length).toBeGreaterThan(0);
        });
    });

    describe('non-.azeroth URI returns the safe default', () =>
    {
        it('completion -> []', () =>
        {
            expect(captured.onCompletion?.({ ...otherTd, position: { line: 0, character: 0 } })).toEqual([]);
        });

        it('hover -> null', () =>
        {
            expect(captured.onHover?.({ ...otherTd, position: { line: 0, character: 0 } })).toBeNull();
        });

        it('definition -> []', () =>
        {
            expect(captured.onDefinition?.({ ...otherTd, position: { line: 0, character: 0 } })).toEqual([]);
        });

        it('rename -> null', () =>
        {
            expect(captured.onRenameRequest?.({ ...otherTd, position: { line: 0, character: 0 }, newName: 'x' })).toBeNull();
        });

        it('documentSymbol -> []', () =>
        {
            expect(captured.onDocumentSymbol?.(otherTd)).toEqual([]);
        });

        it('semanticTokens -> empty data', () =>
        {
            expect(captured.semanticTokens?.(otherTd)).toEqual({ data: [] });
        });

        it('selectionRanges -> identity (start === end at each position)', () =>
        {
            const pos = { line: 0, character: 0 };
            const ranges = captured.onSelectionRanges?.({ ...otherTd, positions: [pos] });
            expect(ranges).toEqual([{ range: { start: pos, end: pos } }]);
        });
    });

    describe('feature toggle OFF returns the safe default, then ON restores it', () =>
    {
        it('completion gates on features.completion', async () =>
        {
            await setConfig(captured, getConfig, { completion: { enable: false } });
            expect(captured.onCompletion?.({ ...td, position: titlePos })).toEqual([]);

            await setConfig(captured, getConfig, {});
            expect((captured.onCompletion?.({ ...td, position: titlePos }) as unknown[]).length).toBeGreaterThan(0);
        });

        it('hover gates on features.hover', async () =>
        {
            await setConfig(captured, getConfig, { hover: { enable: false } });
            expect(captured.onHover?.({ ...td, position: at(DOC_TEXT, '<Modal', 1) })).toBeNull();
            await setConfig(captured, getConfig, {});
        });

        it('definition gates on features.definition', async () =>
        {
            await setConfig(captured, getConfig, { definition: { enable: false } });
            expect(captured.onDefinition?.({ ...td, position: at(DOC_TEXT, '<Modal', 1) })).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('typeDefinition gates on features.typeDefinition', async () =>
        {
            await setConfig(captured, getConfig, { typeDefinition: { enable: false } });
            expect(captured.onTypeDefinition?.({ ...td, position: titlePos })).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('references gates on features.references', async () =>
        {
            await setConfig(captured, getConfig, { references: { enable: false } });
            expect(captured.onReferences?.({ ...td, position: titlePos, context: { includeDeclaration: true } })).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('documentHighlight gates on features.documentHighlight', async () =>
        {
            await setConfig(captured, getConfig, { documentHighlight: { enable: false } });
            expect(captured.onDocumentHighlight?.({ ...td, position: titlePos })).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('rename gates on features.rename', async () =>
        {
            await setConfig(captured, getConfig, { rename: { enable: false } });
            expect(captured.onRenameRequest?.({ ...td, position: titlePos, newName: 'x' })).toBeNull();
            await setConfig(captured, getConfig, {});
        });

        it('documentSymbol gates on features.documentSymbol', async () =>
        {
            await setConfig(captured, getConfig, { documentSymbol: { enable: false } });
            expect(captured.onDocumentSymbol?.(td)).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('workspaceSymbol gates on features.workspaceSymbol', async () =>
        {
            await setConfig(captured, getConfig, { workspaceSymbol: { enable: false } });
            expect(captured.onWorkspaceSymbol?.({ query: 'Modal' })).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('signatureHelp gates on features.signatureHelp', async () =>
        {
            await setConfig(captured, getConfig, { signatureHelp: { enable: false } });
            expect(captured.onSignatureHelp?.({ ...td, position: titlePos })).toBeNull();
            await setConfig(captured, getConfig, {});
        });

        it('semanticTokens gates on features.semanticTokens', async () =>
        {
            await setConfig(captured, getConfig, { semanticTokens: { enable: false } });
            expect(captured.semanticTokens?.(td)).toEqual({ data: [] });
            await setConfig(captured, getConfig, {});
        });

        it('codeActions gates on features.codeActions', async () =>
        {
            const range = { start: titlePos, end: titlePos };
            await setConfig(captured, getConfig, { codeActions: { enable: false } });
            expect(captured.onCodeAction?.({ ...td, range, context: { diagnostics: [] } })).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('folding gates on features.folding', async () =>
        {
            await setConfig(captured, getConfig, { folding: { enable: false } });
            expect(captured.onFoldingRanges?.(td)).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('selectionRange OFF falls back to identity ranges', async () =>
        {
            await setConfig(captured, getConfig, { selectionRange: { enable: false } });
            const pos = titlePos;
            expect(captured.onSelectionRanges?.({ ...td, positions: [pos] }))
                .toEqual([{ range: { start: pos, end: pos } }]);
            await setConfig(captured, getConfig, {});
        });

        it('onTypeFormatting gates on features.onTypeFormatting', async () =>
        {
            await setConfig(captured, getConfig, { onTypeFormatting: { enable: false } });
            expect(captured.onDocumentOnTypeFormatting?.({ ...td, position: titlePos, ch: ';' })).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('linkedEditing gates on features.linkedEditing', async () =>
        {
            await setConfig(captured, getConfig, { linkedEditing: { enable: false } });
            expect(captured.onLinkedEditingRange?.({ ...td, position: at(DOC_TEXT, '<Modal', 1) })).toBeNull();
            await setConfig(captured, getConfig, {});
        });

        it('formatting gates on format.enable', async () =>
        {
            await setConfig(captured, getConfig, { format: { enable: false } });
            expect(captured.onDocumentFormatting?.({ ...td, options: { tabSize: 4, insertSpaces: true } })).toEqual([]);
            await setConfig(captured, getConfig, {});
        });

        it('autoClosingTags OFF suppresses azeroth/autoInsert', async () =>
        {
            const autoInsert = captured.requests.get('azeroth/autoInsert')!;
            await setConfig(captured, getConfig, { autoClosingTags: false });
            expect(autoInsert({ ...td, position: titlePos })).toBeNull();
            await setConfig(captured, getConfig, {});
        });
    });

    describe('diagnostics push model', () =>
    {
        it('publishes diagnostics on open and suppresses them when diagnostics.enable=false', async () =>
        {
            // Opening already pushed at least one diagnostics payload for this doc.
            const opened = captured.diagnostics.filter(d => d.uri === DOC_URI);
            expect(opened.length).toBeGreaterThan(0);

            // Turning diagnostics off re-publishes an empty set for every open doc
            // (onDidChangeConfiguration refreshes diagnostics for all documents).
            captured.diagnostics.length = 0;
            await setConfig(captured, getConfig, { diagnostics: { enable: false } });
            const after = captured.diagnostics.filter(d => d.uri === DOC_URI);
            expect(after.length).toBeGreaterThan(0);
            expect(after.every(d => d.diagnostics.length === 0)).toBe(true);

            await setConfig(captured, getConfig, {});
        });
    });

    describe('azeroth/autoInsert close-tag snippet', () =>
    {
        it('returns a close-tag snippet right after typing the > of an opening tag', () =>
        {
            const autoInsert = captured.requests.get('azeroth/autoInsert')!;
            const u = pathToUri(path.join(FIX, 'auto.azeroth'));
            const src = 'const x = <div>;';
            // Open a fresh doc through the document-sync registrar.
            captured.onDidOpenTextDocument?.({
                textDocument: { uri: u, languageId: 'azeroth', version: 1, text: src }
            });
            const snippet = autoInsert({ textDocument: { uri: u }, position: at(src, '<div>', 5) });
            expect(snippet).toBe('$0</div>');
        });
    });

    describe('completion resolve enriches the item', () =>
    {
        it('resolves detail/documentation for the last completed document', () =>
        {
            const items = captured.onCompletion?.({ ...td, position: titlePos }) as { label: string }[];
            const resolved = captured.onCompletionResolve?.(items[0]) as Record<string, unknown>;
            expect(resolved).toHaveProperty('label', items[0].label);
            // resolveCompletion fills these in (may be undefined for some items,
            // but the keys are always present after the spread in the handler).
            expect('detail' in resolved).toBe(true);
            expect('documentation' in resolved).toBe(true);
        });
    });
});
