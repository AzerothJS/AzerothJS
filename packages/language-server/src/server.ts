// The Language Server Protocol front-end. It owns an LSP connection and a
// document manager, and delegates every request to an AzerothLanguageService
// (from @azerothjs/language-service). Because the service's result types
// already mirror the LSP shapes, this layer is mostly a thin translation: sync
// document text into the service, forward positions, and hand results back.
//
// The actual intelligence - the TypeScript bridge, the markup model, the
// providers - lives in the service. Keeping the protocol plumbing separate
// means the same brain powers the LSP server, the unit tests, and any other
// editor host.

import { dirname } from 'node:path';

import {
    createConnection,
    TextDocuments,
    TextDocumentSyncKind,
    DidChangeConfigurationNotification,
    type Connection,
    type InitializeParams,
    type InitializeResult,
    type SemanticTokensLegend
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    AzerothLanguageService,
    SEMANTIC_TOKEN_TYPES,
    uriToPath,
    type CompletionItem as ServiceCompletionItem,
    type CompletionOptions,
    type InlayHintOptions
} from '@azerothjs/language-service';

/** All `azeroth.*` settings, resolved with defaults. */
interface AzerothSettings
{
    diagnostics: { enable: boolean };
    format: { enable: boolean };
    autoClosingTags: boolean;
    suggest: CompletionOptions;
    inlayHints: InlayHintOptions;
}

/** Defaults applied when a setting is absent or the client can't supply config. */
const DEFAULT_SETTINGS: AzerothSettings =
{
    diagnostics: { enable: true },
    format: { enable: true },
    autoClosingTags: true,
    suggest: { autoImports: true, componentSnippets: true },
    inlayHints:
    {
        enabled: true,
        parameterNames: 'all',
        parameterTypes: true,
        variableTypes: true,
        propertyDeclarationTypes: true,
        functionLikeReturnTypes: true,
        enumMemberValues: true
    }
};

/** The `.azeroth` extension the server is responsible for. */
const EXTENSION = '.azeroth';

const SEMANTIC_LEGEND: SemanticTokensLegend =
{
    tokenTypes: [...SEMANTIC_TOKEN_TYPES],
    tokenModifiers: []
};

/**
 * Wires an AzerothJS language server onto an LSP connection. Pass a connection
 * for testing, or omit it to create the standard stdio/IPC connection (used by
 * the CLI binary).
 *
 * @example
 * ```ts
 * // cli.ts
 * import { startServer } from './server.ts';
 * startServer();
 * ```
 */
export function startServer(connection: Connection = createConnection()): void
{
    const documents = new TextDocuments(TextDocument);

    /** One language service per workspace root (created on initialize). */
    let service: AzerothLanguageService | null = null;

    /** Lazily creates/returns the service, anchored at a sensible root. */
    const ensureService = (anchorUri: string): AzerothLanguageService =>
    {
        if (!service)
        {
            service = new AzerothLanguageService(dirname(uriToPath(anchorUri)));
        }
        return service;
    };

    const isAzeroth = (uri: string): boolean => uri.endsWith(EXTENSION);

    // --- Settings (azeroth.*), pulled from the client and refreshed on change. ---

    let settings: AzerothSettings = DEFAULT_SETTINGS;
    let hasConfigurationCapability = false;

    /** Merges the client's `azeroth` config over the defaults (tolerant of gaps). */
    const applyConfig = (cfg: Record<string, unknown> | undefined): void =>
    {
        const c = (cfg ?? {}) as Record<string, Record<string, unknown> | boolean | undefined>;
        const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {});
        const diagnostics = obj(c.diagnostics);
        const format = obj(c.format);
        const suggest = obj(c.suggest);
        const inlay = obj(c.inlayHints);
        settings =
        {
            diagnostics: { enable: diagnostics.enable !== false },
            format: { enable: format.enable !== false },
            autoClosingTags: c.autoClosingTags !== false,
            suggest:
            {
                autoImports: suggest.autoImports !== false,
                componentSnippets: suggest.componentSnippets !== false
            },
            inlayHints:
            {
                enabled: inlay.enabled !== false,
                parameterNames: (inlay.parameterNames as InlayHintOptions['parameterNames']) ?? 'all',
                parameterTypes: inlay.parameterTypes !== false,
                variableTypes: inlay.variableTypes !== false,
                propertyDeclarationTypes: inlay.propertyDeclarationTypes !== false,
                functionLikeReturnTypes: inlay.functionLikeReturnTypes !== false,
                enumMemberValues: inlay.enumMemberValues !== false
            }
        };
    };

    /** Pulls `azeroth` settings from the client (no-op if config isn't supported). */
    const refreshSettings = async (): Promise<void> =>
    {
        if (!hasConfigurationCapability)
        {
            return;
        }
        try
        {
            applyConfig(await connection.workspace.getConfiguration('azeroth'));
        }
        catch
        {
            // Client can't supply configuration; keep current settings.
        }
    };

    connection.onInitialize((params: InitializeParams): InitializeResult =>
    {
        hasConfigurationCapability = params.capabilities.workspace?.configuration === true;
        const root = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
        if (root)
        {
            service = new AzerothLanguageService(uriToPath(root));
        }

        // Clients without `workspace/configuration` (e.g. the JetBrains LSP
        // client) pass the `azeroth.*` settings as initializationOptions instead.
        if (params.initializationOptions)
        {
            applyConfig(params.initializationOptions as Record<string, unknown>);
        }

        return {
            capabilities:
            {
                textDocumentSync: TextDocumentSyncKind.Full,
                completionProvider:
                {
                    resolveProvider: true,
                    triggerCharacters: ['<', '.', ' ', '{', ':', '@', '/']
                },
                hoverProvider: true,
                definitionProvider: true,
                typeDefinitionProvider: true,
                referencesProvider: true,
                documentHighlightProvider: true,
                renameProvider: true,
                documentSymbolProvider: true,
                workspaceSymbolProvider: true,
                signatureHelpProvider: { triggerCharacters: ['(', ','] },
                semanticTokensProvider: { legend: SEMANTIC_LEGEND, full: true, range: false },
                foldingRangeProvider: true,
                codeActionProvider:
                {
                    codeActionKinds: ['quickfix', 'refactor']
                },
                documentFormattingProvider: true,
                documentOnTypeFormattingProvider: { firstTriggerCharacter: ';', moreTriggerCharacter: ['}', '\n'] },
                selectionRangeProvider: true,
                linkedEditingRangeProvider: true,
                inlayHintProvider: true
            }
        };
    });

    connection.onInitialized(() =>
    {
        if (hasConfigurationCapability)
        {
            void connection.client.register(DidChangeConfigurationNotification.type, undefined);
            void refreshSettings();
        }
    });

    connection.onDidChangeConfiguration(async () =>
    {
        await refreshSettings();
        // Re-evaluate diagnostics and ask the client to refresh inlay hints.
        for (const doc of documents.all())
        {
            refreshDiagnostics(doc.uri);
        }
        void connection.languages.inlayHint.refresh();
    });

    // --- Document lifecycle: keep the service's buffer in sync, publish diagnostics. ---

    const refreshDiagnostics = (uri: string): void =>
    {
        if (!isAzeroth(uri) || !service)
        {
            return;
        }
        const diagnostics = settings.diagnostics.enable ? service.getDiagnostics(uri) : [];
        connection.sendDiagnostics({ uri, diagnostics });
    };

    documents.onDidOpen((event) =>
    {
        if (!isAzeroth(event.document.uri))
        {
            return;
        }
        ensureService(event.document.uri).didOpen(event.document.uri, event.document.getText());
        refreshDiagnostics(event.document.uri);
    });

    documents.onDidChangeContent((event) =>
    {
        if (!isAzeroth(event.document.uri))
        {
            return;
        }
        ensureService(event.document.uri).didChange(event.document.uri, event.document.getText());
        refreshDiagnostics(event.document.uri);
    });

    documents.onDidClose((event) =>
    {
        if (!isAzeroth(event.document.uri) || !service)
        {
            return;
        }
        service.didClose(event.document.uri);
        connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    });

    // --- Feature requests: forward to the service, return its (LSP-shaped) results. ---

    // The resolve request doesn't carry the document URI, so remember the last
    // completed document; completion and its resolve always pair up per file.
    let lastCompletionUri = '';

    connection.onCompletion((params) =>
    {
        if (!service || !isAzeroth(params.textDocument.uri))
        {
            return [];
        }
        lastCompletionUri = params.textDocument.uri;
        return service.getCompletions(params.textDocument.uri, params.position, settings.suggest);
    });

    connection.onCompletionResolve((item) =>
    {
        if (!service || !lastCompletionUri)
        {
            return item;
        }
        // The service's CompletionItem mirrors the LSP one; the only shape
        // difference is `kind` optionality, so the cast at this boundary is safe.
        const resolved = service.resolveCompletion(lastCompletionUri, item as unknown as ServiceCompletionItem);
        return {
            ...item,
            detail: resolved.detail,
            documentation: resolved.documentation,
            additionalTextEdits: resolved.additionalTextEdits
        };
    });

    connection.onHover((params) =>
    {
        if (!service || !isAzeroth(params.textDocument.uri))
        {
            return null;
        }

        const hover = service.getHover(params.textDocument.uri, params.position);
        if (!hover)
        {
            return null;
        }

        return { contents: { kind: 'markdown', value: hover.contents }, range: hover.range };
    });

    connection.onDefinition((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getDefinition(params.textDocument.uri, params.position)
            : []);

    connection.onTypeDefinition((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getTypeDefinition(params.textDocument.uri, params.position)
            : []);

    connection.onReferences((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getReferences(params.textDocument.uri, params.position)
            : []);

    connection.onDocumentHighlight((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getDocumentHighlights(params.textDocument.uri, params.position)
            : []);

    connection.onRenameRequest((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getRenameEdits(params.textDocument.uri, params.position, params.newName)
            : null);

    connection.onDocumentSymbol((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getDocumentSymbols(params.textDocument.uri)
            : []);

    connection.onWorkspaceSymbol((params) =>
        service ? service.getWorkspaceSymbols(params.query) : []);

    connection.onSignatureHelp((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getSignatureHelp(params.textDocument.uri, params.position)
            : null);

    connection.onFoldingRanges((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getFoldingRanges(params.textDocument.uri)
            : []);

    connection.onCodeAction((params) =>
    {
        if (!service || !isAzeroth(params.textDocument.uri))
        {
            return [];
        }
        const codes = params.context.diagnostics
            .map(diagnostic => (typeof diagnostic.code === 'number' ? diagnostic.code : undefined))
            .filter((code): code is number => code !== undefined);
        return service.getCodeActions(params.textDocument.uri, params.range, codes);
    });

    connection.onDocumentFormatting((params) =>
        service && isAzeroth(params.textDocument.uri) && settings.format.enable
            ? service.getFormattingEdits(params.textDocument.uri)
            : []);

    connection.languages.inlayHint.on((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getInlayHints(params.textDocument.uri, params.range, settings.inlayHints)
            : []);

    connection.onSelectionRanges((params) =>
        service && isAzeroth(params.textDocument.uri)
            ? service.getSelectionRanges(params.textDocument.uri, params.positions)
            : params.positions.map(position => ({ range: { start: position, end: position } })));

    connection.onDocumentOnTypeFormatting((params) =>
        service && isAzeroth(params.textDocument.uri) && settings.format.enable
            ? service.getOnTypeFormattingEdits(params.textDocument.uri, params.position, params.ch)
            : []);

    connection.languages.semanticTokens.on((params) =>
    {
        if (!service || !isAzeroth(params.textDocument.uri))
        {
            return { data: [] };
        }
        return service.getSemanticTokens(params.textDocument.uri);
    });

    connection.languages.onLinkedEditingRange((params) =>
    {
        if (!service || !isAzeroth(params.textDocument.uri))
        {
            return null;
        }
        const ranges = service.getLinkedEditingRanges(params.textDocument.uri, params.position);
        return ranges ? { ranges } : null;
    });

    // Custom request: the client calls this after the user types `>` so the
    // editor can auto-close the opening tag (VS Code has no built-in tag close
    // for custom languages). Returns a snippet string, or null.
    connection.onRequest('azeroth/autoInsert', (params: { textDocument: { uri: string }; position: { line: number; character: number } }) =>
    {
        if (!service || !isAzeroth(params.textDocument.uri) || !settings.autoClosingTags)
        {
            return null;
        }
        return service.getAutoCloseTag(params.textDocument.uri, params.position);
    });

    documents.listen(connection);
    connection.listen();
}
