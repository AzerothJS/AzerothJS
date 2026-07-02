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

import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import {
    createConnection,
    TextDocuments,
    TextDocumentSyncKind,
    DidChangeConfigurationNotification,
    DidChangeWatchedFilesNotification,
    FileChangeType,
    type Connection,
    type InitializeParams,
    type InitializeResult,
    type SemanticTokensLegend,
    type CallHierarchyItem,
    type CallHierarchyIncomingCall,
    type CallHierarchyOutgoingCall
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    AzerothLanguageService,
    SEMANTIC_TOKEN_TYPES,
    SEMANTIC_TOKEN_MODIFIERS,
    uriToPath,
    type CompletionItem as ServiceCompletionItem,
    type CallHierarchyItem as ServiceCallHierarchyItem,
    type CodeLens as ServiceCodeLens,
    type CompletionOptions,
    type InlayHintOptions
} from '@azerothjs/language-service';

/** All `azeroth.*` settings, resolved with defaults. */
export interface AzerothSettings
{
    diagnostics: { enable: boolean };
    format: { enable: boolean };
    autoClosingTags: boolean;
    suggest: CompletionOptions;
    inlayHints: InlayHintOptions;
    features: FeatureToggles;
}

/**
 * Per-feature on/off switches. Every LSP capability the server advertises can be
 * disabled independently (`azeroth.<feature>.enable: false`), so a user or a
 * project can trim the language experience without disabling the whole server.
 * Gating happens in the request handlers (return empty) rather than by dropping
 * the capability, so toggling takes effect live on the next config change.
 */
export interface FeatureToggles
{
    completion: boolean;
    hover: boolean;
    definition: boolean;
    typeDefinition: boolean;
    implementation: boolean;
    references: boolean;
    documentHighlight: boolean;
    rename: boolean;
    documentSymbol: boolean;
    workspaceSymbol: boolean;
    signatureHelp: boolean;
    semanticTokens: boolean;
    codeActions: boolean;
    folding: boolean;
    selectionRange: boolean;
    onTypeFormatting: boolean;
    linkedEditing: boolean;
    callHierarchy: boolean;
    codeLens: boolean;
    documentLinks: boolean;
    documentColor: boolean;
}

/** Every feature on - the experience an editor gets before any opt-out. */
const ALL_FEATURES_ON: FeatureToggles =
{
    completion: true, hover: true, definition: true, typeDefinition: true,
    implementation: true, references: true, documentHighlight: true, rename: true, documentSymbol: true,
    workspaceSymbol: true, signatureHelp: true, semanticTokens: true, codeActions: true,
    folding: true, selectionRange: true, onTypeFormatting: true, linkedEditing: true,
    callHierarchy: true, codeLens: true, documentLinks: true, documentColor: true
};

/** Defaults applied when a setting is absent or the client can't supply config. */
const DEFAULT_SETTINGS: AzerothSettings =
{
    diagnostics: { enable: true },
    format: { enable: true },
    autoClosingTags: true,
    suggest: { autoImports: true, componentSnippets: true },
    features: ALL_FEATURES_ON,
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

/**
 * Resolves an `azeroth.*` client-config blob into a complete {@link AzerothSettings},
 * applying every default for absent/malformed keys. Pure and total (never throws),
 * so it is unit-testable in isolation from the LSP connection. Every value follows
 * the "on unless explicitly `false`" convention, so a partial config is safe.
 */
export function parseSettings(cfg: Record<string, unknown> | undefined): AzerothSettings
{
    const c = (cfg ?? {}) as Record<string, Record<string, unknown> | boolean | undefined>;
    const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {});
    // A feature is on unless `azeroth.<feature>.enable` is explicitly false.
    const featureOn = (key: keyof FeatureToggles): boolean => obj(c[key]).enable !== false;
    const diagnostics = obj(c.diagnostics);
    const format = obj(c.format);
    const suggest = obj(c.suggest);
    const inlay = obj(c.inlayHints);
    return {
        diagnostics: { enable: diagnostics.enable !== false },
        format: { enable: format.enable !== false },
        autoClosingTags: c.autoClosingTags !== false,
        suggest:
        {
            autoImports: suggest.autoImports !== false,
            componentSnippets: suggest.componentSnippets !== false
        },
        features:
        {
            completion: featureOn('completion'),
            hover: featureOn('hover'),
            definition: featureOn('definition'),
            typeDefinition: featureOn('typeDefinition'),
            implementation: featureOn('implementation'),
            references: featureOn('references'),
            documentHighlight: featureOn('documentHighlight'),
            rename: featureOn('rename'),
            documentSymbol: featureOn('documentSymbol'),
            workspaceSymbol: featureOn('workspaceSymbol'),
            signatureHelp: featureOn('signatureHelp'),
            semanticTokens: featureOn('semanticTokens'),
            codeActions: featureOn('codeActions'),
            folding: featureOn('folding'),
            selectionRange: featureOn('selectionRange'),
            onTypeFormatting: featureOn('onTypeFormatting'),
            linkedEditing: featureOn('linkedEditing'),
            callHierarchy: featureOn('callHierarchy'),
            codeLens: featureOn('codeLens'),
            documentLinks: featureOn('documentLinks'),
            documentColor: featureOn('documentColor')
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
}

/** The `.azeroth` extension the server is responsible for. */
const EXTENSION = '.azeroth';

const SEMANTIC_LEGEND: SemanticTokensLegend =
{
    tokenTypes: [...SEMANTIC_TOKEN_TYPES],
    tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS]
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

    // One language service per workspace root, keyed by absolute root path. A
    // document resolves against the service whose root is its longest-matching
    // prefix (i.e. its nearest project); a file outside every root falls back to
    // a service anchored at its own directory. This is what lets a multi-root
    // workspace resolve each file against the correct tsconfig/project instead
    // of forcing everything through the first folder.
    const services = new Map<string, AzerothLanguageService>();
    let roots: string[] = [];

    const norm = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '');

    // rootProjectFiles: the editor program must contain the project's real `.ts` files, not just
    // the ones reachable from an open `.azeroth` import. Find References / Rename on a symbol used
    // from BOTH sides is otherwise silently incomplete - a `.ts`-only usage (e.g. main.ts calling a
    // util a component also calls) never appears, and a rename quietly leaves it stale.
    const SERVICE_OPTIONS = { rootProjectFiles: true } as const;

    /** Registers a workspace root and eagerly creates its service. */
    const registerRoot = (rootUri: string): void =>
    {
        const root = norm(uriToPath(rootUri));
        if (!roots.includes(root))
        {
            roots.push(root);
            if (!services.has(root))
            {
                services.set(root, new AzerothLanguageService(root, undefined, SERVICE_OPTIONS));
            }
        }
    };

    /**
     * Nearest ancestor directory of `filePath` that contains a `tsconfig.json`,
     * or null if none up to the filesystem root. This is the file's real TS
     * project: a monorepo opened at its parent has no tsconfig there, but each
     * sub-package (`website/`, `server/`) does, and a file must resolve against
     * its own - for `paths`, `types`, and the zero-config `vite/client` globals
     * (`import.meta.env`, `*.png`). Anchoring on the workspace root instead would
     * resolve against an empty config and wrongly flag those as errors.
     */
    const nearestProjectDir = (filePath: string): string | null =>
    {
        let dir = norm(dirname(filePath));
        while (true)
        {
            if (existsSync(join(dir, 'tsconfig.json')))
            {
                return dir;
            }
            const parent = norm(dirname(dir));
            if (parent === dir)
            {
                return null;
            }
            dir = parent;
        }
    };

    /** Returns the service keyed by `key`, creating it anchored there if needed. */
    const serviceAt = (key: string): AzerothLanguageService =>
    {
        let svc = services.get(key);
        if (!svc)
        {
            svc = new AzerothLanguageService(key, undefined, SERVICE_OPTIONS);
            services.set(key, svc);
        }
        return svc;
    };

    /**
     * The service for `uri`: anchored at the file's nearest tsconfig project, so
     * each sub-package of a monorepo resolves against its own config regardless
     * of which ancestor folder the editor opened. Falls back to the longest-
     * matching workspace root, then the file's own directory, when no tsconfig
     * exists above the file.
     */
    const serviceFor = (uri: string): AzerothLanguageService =>
    {
        const filePath = uriToPath(uri);
        const projectDir = nearestProjectDir(filePath);
        if (projectDir)
        {
            return serviceAt(projectDir);
        }
        const path = norm(filePath);
        let best: string | null = null;
        for (const root of roots)
        {
            if ((path === root || path.startsWith(root + '/')) && (best === null || root.length > best.length))
            {
                best = root;
            }
        }
        return serviceAt(best ?? norm(dirname(filePath)));
    };

    const isAzeroth = (uri: string): boolean => uri.endsWith(EXTENSION);

    // An unexpected throw from the service must not reach the LSP client (it
    // wedges the feature for the session). Degrade to the handler's type-correct
    // safe default and log, so one bad request can't take a capability down.
    const safe = <T>(fn: () => T, fallback: T): T =>
    {
        try
        {
            return fn();
        }
        catch (e)
        {
            connection.console.error(`[azeroth] request handler failed: ${ e instanceof Error ? e.stack ?? e.message : String(e) }`);
            return fallback;
        }
    };

    // --- Settings (azeroth.*), pulled from the client and refreshed on change. ---

    let settings: AzerothSettings = DEFAULT_SETTINGS;
    let hasConfigurationCapability = false;
    let hasWorkspaceFolderCapability = false;

    /** Merges the client's `azeroth` config over the defaults (tolerant of gaps). */
    const applyConfig = (cfg: Record<string, unknown> | undefined): void =>
    {
        settings = parseSettings(cfg);
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
        hasWorkspaceFolderCapability = params.capabilities.workspace?.workspaceFolders === true;
        // Register EVERY folder, not just the first, so each root gets its own
        // project-anchored service.
        if (params.workspaceFolders && params.workspaceFolders.length > 0)
        {
            for (const folder of params.workspaceFolders)
            {
                registerRoot(folder.uri);
            }
        }
        else if (params.rootUri)
        {
            registerRoot(params.rootUri);
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
                textDocumentSync: TextDocumentSyncKind.Incremental,
                completionProvider:
                {
                    resolveProvider: true,
                    triggerCharacters: ['<', '.', ' ', '{', ':', '@', '/']
                },
                hoverProvider: true,
                definitionProvider: true,
                typeDefinitionProvider: true,
                implementationProvider: true,
                referencesProvider: true,
                documentHighlightProvider: true,
                renameProvider: { prepareProvider: true },
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
                documentRangeFormattingProvider: true,
                documentOnTypeFormattingProvider: { firstTriggerCharacter: ';', moreTriggerCharacter: ['}', '\n'] },
                selectionRangeProvider: true,
                linkedEditingRangeProvider: true,
                callHierarchyProvider: true,
                codeLensProvider: { resolveProvider: true },
                documentLinkProvider: {},
                colorProvider: true,
                inlayHintProvider: true,
                workspace:
                {
                    workspaceFolders: { supported: true, changeNotifications: true }
                }
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
        // Watch stylesheets and components so class-name intelligence and the
        // cross-file program stay current when files are added or removed.
        // Edits to existing files are picked up without an event (by mtime).
        // A client without dynamic watched-file registration rejects this; that's
        // fine (mtime still refreshes edits), so swallow it rather than leave an
        // unhandled rejection.
        connection.client.register(DidChangeWatchedFilesNotification.type, {
            watchers: [
                { globPattern: '**/*.{css,scss,less,sass}' },
                { globPattern: '**/*.azeroth' }
            ]
        }).catch(() =>
        {
            // Client lacks dynamic registration; mtime still refreshes edits.
        });
        if (hasWorkspaceFolderCapability)
        {
            connection.workspace.onDidChangeWorkspaceFolders((event) =>
            {
                for (const removed of event.removed)
                {
                    const root = norm(uriToPath(removed.uri));
                    roots = roots.filter((r) => r !== root);
                    // Evict the root's service AND any sub-package services anchored
                    // under it: serviceFor keys by the file's nearest tsconfig dir
                    // (often a child of the root), so deleting only `root` would leak
                    // those nested TS LanguageServices when the folder is removed. A
                    // stray later request just re-creates the service lazily.
                    const stale = [...services.keys()].filter((key) => key === root || key.startsWith(root + '/'));
                    for (const key of stale)
                    {
                        services.delete(key);
                    }
                }
                for (const added of event.added)
                {
                    registerRoot(added.uri);
                }
            });
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

    // A watched stylesheet or component was created/changed/deleted. The work
    // needed depends on WHICH:
    //  - A change to the file SET (`.azeroth` created/deleted) needs a full
    //    workspace rescan so a new component joins (or a deleted one leaves) the
    //    program.
    //  - A plain CONTENT change to an existing `.azeroth` only needs the disk
    //    cache invalidated: a CLOSED file's mtime is memoized per project-version
    //    epoch, so without a version bump TypeScript serves stale types - but the
    //    expensive readDirectory rescan isn't needed since the file set is the
    //    same. (Open buffers sync through the document manager, untouched here.)
    //  - A stylesheet created/deleted re-discovers the class index; a stylesheet
    //    content change needs nothing (the index re-reads it by mtime on demand).
    connection.onDidChangeWatchedFiles((params) =>
    {
        let componentSetChanged = false; // an `.azeroth` file created or deleted
        let componentChanged = false;    // any `.azeroth` event (incl. content edit)
        let styleSetChanged = false;     // a stylesheet created or deleted
        for (const change of params.changes)
        {
            const setEvent = change.type === FileChangeType.Created || change.type === FileChangeType.Deleted;
            if (change.uri.endsWith(EXTENSION))
            {
                componentChanged = true;
                if (setEvent)
                {
                    componentSetChanged = true;
                }
            }
            else if (setEvent)
            {
                styleSetChanged = true;
            }
        }
        for (const svc of services.values())
        {
            if (componentSetChanged)
            {
                svc.refreshWorkspace(); // rescans the file set; also refreshes styles
            }
            else if (componentChanged)
            {
                svc.invalidateDiskCache(); // content edit only: re-read, no rescan
            }
            if (styleSetChanged && !componentSetChanged)
            {
                svc.refreshStyles();
            }
        }
        if (componentChanged)
        {
            for (const doc of documents.all())
            {
                refreshDiagnostics(doc.uri);
            }
        }
    });

    // --- Document lifecycle: keep the service's buffer in sync, publish diagnostics. ---

    const refreshDiagnostics = (uri: string): void =>
    {
        if (!isAzeroth(uri))
        {
            return;
        }
        const diagnostics = settings.diagnostics.enable ? safe(() => serviceFor(uri).getDiagnostics(uri), []) : [];
        connection.sendDiagnostics({ uri, diagnostics });
    };

    documents.onDidOpen((event) =>
    {
        if (!isAzeroth(event.document.uri))
        {
            return;
        }
        serviceFor(event.document.uri).didOpen(event.document.uri, event.document.getText());
        refreshDiagnostics(event.document.uri);
    });

    documents.onDidChangeContent((event) =>
    {
        if (!isAzeroth(event.document.uri))
        {
            return;
        }
        serviceFor(event.document.uri).didChange(event.document.uri, event.document.getText());
        refreshDiagnostics(event.document.uri);
    });

    documents.onDidClose((event) =>
    {
        if (!isAzeroth(event.document.uri))
        {
            return;
        }
        serviceFor(event.document.uri).didClose(event.document.uri);
        connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    });

    // --- Feature requests: forward to the service, return its (LSP-shaped) results. ---

    // The resolve request doesn't carry the document URI, so remember the last
    // completed document; completion and its resolve always pair up per file.
    let lastCompletionUri = '';

    // The service supplies a completion item's `documentation` as a plain string;
    // render it as markdown so a keyword item's bold heading + fenced `azeroth`
    // example format in the editor. Plain prose is valid markdown, so items that
    // were already plain (props, attributes, built-ins) look identical.
    const markdownDoc = <T extends { documentation?: unknown }>(item: T): T =>
        typeof item.documentation === 'string'
            ? { ...item, documentation: { kind: 'markdown', value: item.documentation } } as T
            : item;

    connection.onCompletion((params) =>
    {
        if (!isAzeroth(params.textDocument.uri) || !settings.features.completion)
        {
            return [];
        }
        lastCompletionUri = params.textDocument.uri;
        return safe(
            () => serviceFor(params.textDocument.uri)
                .getCompletions(params.textDocument.uri, params.position, settings.suggest)
                .map(markdownDoc),
            []
        );
    });

    connection.onCompletionResolve((item) =>
    {
        if (!lastCompletionUri)
        {
            return item;
        }
        // The service's CompletionItem mirrors the LSP one; the only shape
        // difference is `kind` optionality, so the cast at this boundary is safe.
        return safe(() =>
        {
            const resolved = serviceFor(lastCompletionUri).resolveCompletion(lastCompletionUri, item as unknown as ServiceCompletionItem);
            return {
                ...item,
                detail: resolved.detail,
                documentation: resolved.documentation === undefined
                    ? undefined
                    : { kind: 'markdown', value: resolved.documentation },
                additionalTextEdits: resolved.additionalTextEdits
            };
        }, item);
    });

    connection.onHover((params) =>
    {
        if (!isAzeroth(params.textDocument.uri) || !settings.features.hover)
        {
            return null;
        }

        return safe(() =>
        {
            const hover = serviceFor(params.textDocument.uri).getHover(params.textDocument.uri, params.position);
            if (!hover)
            {
                return null;
            }
            return { contents: { kind: 'markdown', value: hover.contents }, range: hover.range };
        }, null);
    });

    connection.onDefinition((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.definition
            ? safe(() => serviceFor(params.textDocument.uri).getDefinition(params.textDocument.uri, params.position), [])
            : []);

    connection.onTypeDefinition((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.typeDefinition
            ? safe(() => serviceFor(params.textDocument.uri).getTypeDefinition(params.textDocument.uri, params.position), [])
            : []);

    connection.onImplementation((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.implementation
            ? safe(() => serviceFor(params.textDocument.uri).getImplementation(params.textDocument.uri, params.position), [])
            : []);

    connection.onReferences((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.references
            ? safe(() => serviceFor(params.textDocument.uri).getReferences(params.textDocument.uri, params.position), [])
            : []);

    connection.onDocumentHighlight((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.documentHighlight
            ? safe(() => serviceFor(params.textDocument.uri).getDocumentHighlights(params.textDocument.uri, params.position), [])
            : []);

    // prepareRename shares the rename toggle: validating the target up-front is
    // the first half of the same feature, so it gates behind features.rename.
    connection.onPrepareRename((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.rename
            ? safe(() => serviceFor(params.textDocument.uri).getPrepareRename(params.textDocument.uri, params.position), null)
            : null);

    connection.onRenameRequest((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.rename
            ? safe(() => serviceFor(params.textDocument.uri).getRenameEdits(params.textDocument.uri, params.position, params.newName), null)
            : null);

    connection.onDocumentSymbol((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.documentSymbol
            ? safe(() => serviceFor(params.textDocument.uri).getDocumentSymbols(params.textDocument.uri), [])
            : []);

    connection.onWorkspaceSymbol((params) =>
        // Workspace symbols span every root, so query each per-root service and
        // merge - the one handler that isn't keyed to a single document.
        settings.features.workspaceSymbol
            ? safe(() => [...services.values()].flatMap((s) => s.getWorkspaceSymbols(params.query)), [])
            : []);

    connection.onSignatureHelp((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.signatureHelp
            ? safe(() => serviceFor(params.textDocument.uri).getSignatureHelp(params.textDocument.uri, params.position), null)
            : null);

    connection.onFoldingRanges((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.folding
            ? safe(() => serviceFor(params.textDocument.uri).getFoldingRanges(params.textDocument.uri), [])
            : []);

    connection.onCodeAction((params) =>
    {
        if (!isAzeroth(params.textDocument.uri) || !settings.features.codeActions)
        {
            return [];
        }
        return safe(() =>
        {
            const codes = params.context.diagnostics
                .map(diagnostic => (typeof diagnostic.code === 'number' ? diagnostic.code : undefined))
                .filter((code): code is number => code !== undefined);
            return serviceFor(params.textDocument.uri).getCodeActions(params.textDocument.uri, params.range, codes);
        }, []);
    });

    connection.onDocumentFormatting((params) =>
        isAzeroth(params.textDocument.uri) && settings.format.enable
            ? safe(() => serviceFor(params.textDocument.uri).getFormattingEdits(params.textDocument.uri), [])
            : []);

    connection.onDocumentRangeFormatting((params) =>
        isAzeroth(params.textDocument.uri) && settings.format.enable
            ? safe(() => serviceFor(params.textDocument.uri).getRangeFormattingEdits(params.textDocument.uri, params.range), [])
            : []);

    connection.languages.inlayHint.on((params) =>
        isAzeroth(params.textDocument.uri)
            ? safe(() => serviceFor(params.textDocument.uri).getInlayHints(params.textDocument.uri, params.range, settings.inlayHints), [])
            : []);

    connection.onSelectionRanges((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.selectionRange
            ? safe(() => serviceFor(params.textDocument.uri).getSelectionRanges(params.textDocument.uri, params.positions),
                params.positions.map(position => ({ range: { start: position, end: position } })))
            : params.positions.map(position => ({ range: { start: position, end: position } })));

    connection.onDocumentOnTypeFormatting((params) =>
        isAzeroth(params.textDocument.uri) && settings.format.enable && settings.features.onTypeFormatting
            ? safe(() => serviceFor(params.textDocument.uri).getOnTypeFormattingEdits(params.textDocument.uri, params.position, params.ch), [])
            : []);

    connection.languages.semanticTokens.on((params) =>
    {
        if (!isAzeroth(params.textDocument.uri) || !settings.features.semanticTokens)
        {
            return { data: [] };
        }
        return safe(() => serviceFor(params.textDocument.uri).getSemanticTokens(params.textDocument.uri), { data: [] });
    });

    connection.languages.onLinkedEditingRange((params) =>
    {
        if (!isAzeroth(params.textDocument.uri) || !settings.features.linkedEditing)
        {
            return null;
        }
        return safe(() =>
        {
            const ranges = serviceFor(params.textDocument.uri).getLinkedEditingRanges(params.textDocument.uri, params.position);
            return ranges ? { ranges } : null;
        }, null);
    });

    connection.languages.callHierarchy.onPrepare((params): CallHierarchyItem[] | null =>
        isAzeroth(params.textDocument.uri) && settings.features.callHierarchy
            ? safe(() => serviceFor(params.textDocument.uri).getCallHierarchyPrepare(params.textDocument.uri, params.position) as unknown as CallHierarchyItem[], null)
            : null);

    connection.languages.callHierarchy.onIncomingCalls((params): CallHierarchyIncomingCall[] =>
    {
        // The follow-up requests carry only the prepared item (whose `data` holds
        // the source URI), not a textDocument; route by that uri.
        if (!settings.features.callHierarchy)
        {
            return [];
        }
        const item = params.item as unknown as ServiceCallHierarchyItem;
        const uri = item.data?.uri;
        if (!uri || !isAzeroth(uri))
        {
            return [];
        }
        return safe(() => serviceFor(uri).getIncomingCalls(item) as unknown as CallHierarchyIncomingCall[], []);
    });

    connection.languages.callHierarchy.onOutgoingCalls((params): CallHierarchyOutgoingCall[] =>
    {
        if (!settings.features.callHierarchy)
        {
            return [];
        }
        const item = params.item as unknown as ServiceCallHierarchyItem;
        const uri = item.data?.uri;
        if (!uri || !isAzeroth(uri))
        {
            return [];
        }
        return safe(() => serviceFor(uri).getOutgoingCalls(item) as unknown as CallHierarchyOutgoingCall[], []);
    });

    connection.onCodeLens((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.codeLens
            ? safe(() => serviceFor(params.textDocument.uri).getCodeLenses(params.textDocument.uri), [])
            : []);

    connection.onCodeLensResolve((lens) =>
    {
        // The resolve request carries only the lens; its `data` holds the source
        // URI (stashed by getCodeLenses), so route by that.
        if (!settings.features.codeLens)
        {
            return lens;
        }
        const uri = (lens.data as { uri?: string } | undefined)?.uri;
        if (!uri || !isAzeroth(uri))
        {
            return lens;
        }
        return safe(() => serviceFor(uri).resolveCodeLens(uri, lens as unknown as ServiceCodeLens) as unknown as typeof lens, lens);
    });

    connection.onDocumentLinks((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.documentLinks
            ? safe(() => serviceFor(params.textDocument.uri).getDocumentLinks(params.textDocument.uri), [])
            : []);

    connection.onDocumentColor((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.documentColor
            ? safe(() => serviceFor(params.textDocument.uri).getDocumentColors(params.textDocument.uri), [])
            : []);

    connection.onColorPresentation((params) =>
        isAzeroth(params.textDocument.uri) && settings.features.documentColor
            ? safe(() => serviceFor(params.textDocument.uri).getColorPresentations(params.textDocument.uri, params.color, params.range), [])
            : []);

    // Custom request: the client calls this after the user types `>` so the
    // editor can auto-close the opening tag (VS Code has no built-in tag close
    // for custom languages). Returns a snippet string, or null.
    connection.onRequest('azeroth/autoInsert', (params: { textDocument: { uri: string }; position: { line: number; character: number } }) =>
    {
        if (!isAzeroth(params.textDocument.uri) || !settings.autoClosingTags)
        {
            return null;
        }
        return safe(() => serviceFor(params.textDocument.uri).getAutoCloseTag(params.textDocument.uri, params.position), null);
    });

    documents.listen(connection);
    connection.listen();
}
