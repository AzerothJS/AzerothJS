// Shared mock vscode-languageserver Connection for the language-server tests.
// startServer is the thin LSP translation layer; both handlers.test.ts and
// multi-root.test.ts drive it through a Connection that captures every handler
// it registers. Hand-rolling that mock in each file meant patching two places
// for every new server handler, so the capture map lives here once. The shape
// mirrors exactly what server.ts touches from `vscode-languageserver/node`:
// the on* registrars, `languages.{inlayHint,semanticTokens,onLinkedEditingRange,
// callHierarchy}`, `onRequest`, the document-sync registrars TextDocuments.listen
// subscribes to, `workspace.{getConfiguration,onDidChangeWorkspaceFolders}`,
// `sendDiagnostics`, `client`, `console`, and `window`.

interface Captured
{
    onInitialize?: (params: unknown) => unknown;
    onInitialized?: (params: unknown) => unknown;
    onDidChangeConfiguration?: (params: unknown) => unknown;
    onCompletion?: (params: unknown) => unknown;
    onCompletionResolve?: (params: unknown) => unknown;
    onHover?: (params: unknown) => unknown;
    onDefinition?: (params: unknown) => unknown;
    onTypeDefinition?: (params: unknown) => unknown;
    onReferences?: (params: unknown) => unknown;
    onDocumentHighlight?: (params: unknown) => unknown;
    onPrepareRename?: (params: unknown) => unknown;
    onRenameRequest?: (params: unknown) => unknown;
    onDocumentSymbol?: (params: unknown) => unknown;
    onWorkspaceSymbol?: (params: unknown) => unknown;
    onSignatureHelp?: (params: unknown) => unknown;
    onFoldingRanges?: (params: unknown) => unknown;
    onCodeAction?: (params: unknown) => unknown;
    onDocumentFormatting?: (params: unknown) => unknown;
    onSelectionRanges?: (params: unknown) => unknown;
    onDocumentOnTypeFormatting?: (params: unknown) => unknown;
    onCodeLens?: (params: unknown) => unknown;
    onCodeLensResolve?: (params: unknown) => unknown;
    onDocumentLinks?: (params: unknown) => unknown;
    onDocumentColor?: (params: unknown) => unknown;
    onColorPresentation?: (params: unknown) => unknown;
    onLinkedEditingRange?: (params: unknown) => unknown;
    callHierarchyPrepare?: (params: unknown) => unknown;
    callHierarchyIncoming?: (params: unknown) => unknown;
    callHierarchyOutgoing?: (params: unknown) => unknown;
    inlayHint?: (params: unknown) => unknown;
    semanticTokens?: (params: unknown) => unknown;
    onDidOpenTextDocument?: (params: unknown) => unknown;
    onDidChangeTextDocument?: (params: unknown) => unknown;
    onDidChangeWorkspaceFolders?: (event: unknown) => unknown;
    requests: Map<string, (params: unknown) => unknown>;
    diagnostics: { uri: string; diagnostics: unknown[] }[];
}

/**
 * A mock LSP Connection that records every handler startServer registers, plus a
 * `getConfig` holder a test mutates before firing onDidChangeConfiguration to
 * stand in for the client's `workspace/configuration` response. Returning the
 * connection lets startServer drive it unchanged.
 */
function makeMockConnection(): { connection: unknown; captured: Captured; getConfig: { value: Record<string, unknown> } }
{
    const captured: Captured = { requests: new Map(), diagnostics: [] };
    const getConfig = { value: {} as Record<string, unknown> };
    const capture = (key: keyof Captured) => (handler: (params: unknown) => unknown): void =>
    {
        (captured as Record<string, unknown>)[key] = handler;
    };

    const connection =
    {
        onInitialize: capture('onInitialize'),
        onInitialized: capture('onInitialized'),
        onDidChangeConfiguration: capture('onDidChangeConfiguration'),
        onCompletion: capture('onCompletion'),
        onCompletionResolve: capture('onCompletionResolve'),
        onHover: capture('onHover'),
        onDefinition: capture('onDefinition'),
        onTypeDefinition: capture('onTypeDefinition'),
        onReferences: capture('onReferences'),
        onDocumentHighlight: capture('onDocumentHighlight'),
        onPrepareRename: capture('onPrepareRename'),
        onRenameRequest: capture('onRenameRequest'),
        onDocumentSymbol: capture('onDocumentSymbol'),
        onWorkspaceSymbol: capture('onWorkspaceSymbol'),
        onSignatureHelp: capture('onSignatureHelp'),
        onFoldingRanges: capture('onFoldingRanges'),
        onCodeAction: capture('onCodeAction'),
        onDocumentFormatting: capture('onDocumentFormatting'),
        onSelectionRanges: capture('onSelectionRanges'),
        onDocumentOnTypeFormatting: capture('onDocumentOnTypeFormatting'),
        onCodeLens: capture('onCodeLens'),
        onCodeLensResolve: capture('onCodeLensResolve'),
        onDocumentLinks: capture('onDocumentLinks'),
        onDocumentColor: capture('onDocumentColor'),
        onColorPresentation: capture('onColorPresentation'),
        onRequest: (method: string, handler: (params: unknown) => unknown): void =>
        {
            captured.requests.set(method, handler);
        },
        languages:
        {
            onLinkedEditingRange: capture('onLinkedEditingRange'),
            inlayHint: { on: capture('inlayHint'), refresh: (): void => {} },
            semanticTokens: { on: capture('semanticTokens') },
            callHierarchy:
            {
                onPrepare: capture('callHierarchyPrepare'),
                onIncomingCalls: capture('callHierarchyIncoming'),
                onOutgoingCalls: capture('callHierarchyOutgoing')
            }
        },
        // TextDocuments.listen subscribes to these; capturing onDidOpen/onDidChange
        // lets the test simulate the client opening and editing a document.
        onDidOpenTextDocument: capture('onDidOpenTextDocument'),
        onDidChangeTextDocument: capture('onDidChangeTextDocument'),
        onDidCloseTextDocument: (): void => {},
        onWillSaveTextDocument: (): void => {},
        onWillSaveTextDocumentWaitUntil: (): void => {},
        onDidSaveTextDocument: (): void => {},
        sendDiagnostics: (params: { uri: string; diagnostics: unknown[] }): void =>
        {
            captured.diagnostics.push(params);
        },
        workspace:
        {
            getConfiguration: async (): Promise<Record<string, unknown>> => getConfig.value,
            onDidChangeWorkspaceFolders: capture('onDidChangeWorkspaceFolders')
        },
        client: { register: async (): Promise<void> => {} },
        console: { log: (): void => {}, error: (): void => {}, warn: (): void => {}, info: (): void => {} },
        window: { showErrorMessage: (): void => {}, showWarningMessage: (): void => {}, showInformationMessage: (): void => {} },
        listen: (): void => {}
    };

    return { connection, captured, getConfig };
}

/** A position located by searching the source for `needle`. */
function at(source: string, needle: string, offsetInNeedle = 0): { line: number; character: number }
{
    const index = source.indexOf(needle) + offsetInNeedle;
    const before = source.slice(0, index);
    const line = before.split('\n').length - 1;
    const character = index - (before.lastIndexOf('\n') + 1);
    return { line, character };
}

export { makeMockConnection, at };
export type { Captured };
