// The public facade. One AzerothLanguageService per workspace owns an
// AzerothProject (the TypeScript bridge) and exposes one method per editor
// feature. Callers speak `.azeroth` document URIs and line/character positions;
// the facade builds a RequestContext (original source, line index, virtual
// module + mapping) and hands it to the focused providers, which do the real
// work. The `@azerothjs/language-server` adapter is a thin translation layer on
// top of this.

import ts from 'typescript';
import {
    AzerothProject,
    toVirtualFile
} from './ts-project.ts';
import { uriToPath } from './uri.ts';
import { DiagnosticSeverity } from './protocol.ts';
import { LineIndex } from './text.ts';
import type { RequestContext } from './request.ts';
import type {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    CodeAction,
    CodeLens,
    Color,
    ColorInformation,
    ColorPresentation,
    CompletionItem,
    Diagnostic,
    DocumentHighlight,
    DocumentLink,
    DocumentSymbol,
    FoldingRange,
    Hover,
    InlayHint,
    Location,
    Position,
    PrepareRenameResult,
    Range,
    SelectionRange,
    SemanticTokens,
    SignatureHelp,
    TextEdit,
    WorkspaceEdit,
    WorkspaceSymbol
} from './protocol.ts';
import { getCompletions, resolveCompletion, type CompletionOptions } from './providers/completion.ts';
import { getHover } from './providers/hover.ts';
import {
    getDefinition,
    getDocumentHighlights,
    getImplementation,
    getPrepareRename,
    getReferences,
    getRenameEdits,
    getTypeDefinition
} from './providers/navigation.ts';
import { getDocumentSymbols, getWorkspaceSymbols } from './providers/symbols.ts';
import { getDocumentLinks } from './providers/document-links.ts';
import { getColorPresentations, getDocumentColors } from './providers/color.ts';
import { getCodeLenses, resolveCodeLens } from './providers/code-lens.ts';
import {
    incomingCalls,
    outgoingCalls,
    prepareCallHierarchy
} from './providers/call-hierarchy.ts';
import { getDiagnostics } from './providers/diagnostics.ts';
import { getSignatureHelp } from './providers/signature.ts';
import { getSemanticTokens } from './providers/semantic-tokens.ts';
import {
    getCodeActions,
    getFoldingRanges,
    getFormattingEdits,
    getOnTypeFormattingEdits,
    getRangeFormattingEdits,
    getSelectionRanges
} from './providers/structure.ts';
import { getAutoCloseTag, getLinkedEditingRanges } from './providers/editing.ts';
import { getInlayHints, type InlayHintOptions } from './providers/inlay-hints.ts';
import * as perf from './perf.ts';
import type { Metrics } from './perf.ts';

/**
 * Compiler-aware language intelligence for `.azeroth` files.
 *
 * @example
 * ```ts
 * const ls = new AzerothLanguageService(process.cwd());
 * ls.didOpen('file:///App.azeroth', 'export default () => <h1>Hi {name()}</h1>;');
 * ls.getHover('file:///App.azeroth', { line: 0, character: 36 }); // type of name()
 * ```
 */
export class AzerothLanguageService
{
    readonly #project: AzerothProject;

    /** Workspace root (forward-slash, no trailing slash); the anchor for scratch (untitled) docs. */
    readonly #scratchRoot: string;

    constructor(
        workspaceDirectory: string,
        configPath?: string,
        options: { rootProjectFiles?: boolean; nativeDiagnostics?: boolean } = {}
    )
    {
        this.#scratchRoot = workspaceDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
        this.#project = new AzerothProject(workspaceDirectory, configPath, options);
    }

    /**
     * The OS path a document URI maps to. A `file://` URI or a bare path is its real path
     * ({@link uriToPath}); a PATHLESS URI - an untitled / never-saved buffer (`untitled:...`,
     * `vscode-vfs:...`) the editor attaches before a first save - maps to a deterministic synthetic
     * `.azeroth` path under the workspace root. That gives an unsaved scratch file a valid virtual module,
     * so hover / completion / diagnostics work on it instead of throwing "source file not found"; the
     * content is served from the open-document buffer, never from disk.
     */
    #docPath(uri: string): string
    {
        if (uri.startsWith('file://') || uri.startsWith('/') || /^[A-Za-z]:[\\/]/.test(uri))
        {
            return uriToPath(uri);
        }
        const safe = uri.replace(/[^A-Za-z0-9._-]/g, '_');
        return `${ this.#scratchRoot }/__azeroth_scratch__/${ safe }.azeroth`;
    }

    /**
     * The consuming project's real `.ts` files (from its tsconfig). Used by the
     * combined checker to iterate the `.ts` side; only populated meaningfully
     * when the service was constructed with `{ rootProjectFiles: true }`.
     */
    public getProjectTsFiles(): readonly string[]
    {
        return this.#project.getProjectFiles();
    }

    /**
     * Diagnostics for a real `.ts` file in the program (no offset
     * mapping - positions are the file's own). Lets the combined checker report
     * `.ts` errors - including those at the `.ts` -> `.azeroth` import boundary -
     * from the same program that checks the `.azeroth` files.
     */
    public getTsDiagnostics(filePath: string): Diagnostic[]
    {
        // One raw-diagnostics primitive serves both engines (classic service or native
        // compiler); the shaping below is engine-agnostic.
        const raw = this.#project.rawTsDiagnostics(filePath);

        const out: Diagnostic[] = [];
        for (const diag of raw)
        {
            if (diag.start === undefined || diag.length === undefined || !diag.file)
            {
                continue;
            }
            const start = diag.file.getLineAndCharacterOfPosition(diag.start);
            const end = diag.file.getLineAndCharacterOfPosition(diag.start + diag.length);
            out.push({
                range: { start, end },
                severity: diag.category === ts.DiagnosticCategory.Error
                    ? DiagnosticSeverity.Error
                    : DiagnosticSeverity.Warning,
                message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
                code: diag.code,
                source: 'azeroth-ts'
            });
        }
        return out;
    }

    /** Registers or replaces a document's content. */
    public didOpen(uri: string, source: string): void
    {
        this.#project.openDocument(this.#docPath(uri), source);
    }

    /** Updates a document's content. */
    public didChange(uri: string, source: string): void
    {
        this.#project.openDocument(this.#docPath(uri), source);
    }

    /** Drops a document. */
    public didClose(uri: string): void
    {
        this.#project.closeDocument(this.#docPath(uri));
    }

    /**
     * Sizes of the internal per-document caches. Intended for leak detection: a
     * harness that opens, edits, and closes many documents can assert these stay
     * bounded (they should fall back to the count of still-open documents), not
     * grow with the number of cycles.
     */
    public getCacheStats(): { openDocuments: number; virtualCache: number; mtimeCache: number }
    {
        return this.#project.cacheStats();
    }

    /**
     * Re-scans the workspace for `.azeroth` files. Call on a watched-file
     * create/delete so newly-added components join the program (cross-file
     * completion, go-to-definition, auto-import) without a restart.
     */
    public refreshWorkspace(): void
    {
        this.#project.refreshWorkspace();
    }

    /**
     * Re-discovers the workspace stylesheets backing class-name intelligence,
     * without rebuilding the TypeScript program. Call when a `.css`/`.scss`/
     * `.less`/`.sass` file is created or deleted; edits to existing files are
     * picked up automatically by mtime.
     */
    public refreshStyles(): void
    {
        this.#project.refreshStyles();
    }

    /**
     * Picks up an on-disk content change to an existing `.azeroth`/`.ts` file
     * without re-scanning the workspace. Call on a watched-file CHANGE (not
     * create/delete) so a closed file's new content is re-read; see
     * {@link AzerothProject.invalidateDiskCache}.
     */
    public invalidateDiskCache(): void
    {
        this.#project.invalidateDiskCache();
    }

    /** Context-aware completion at a position. */
    public getCompletions(uri: string, position: Position, options?: CompletionOptions): CompletionItem[]
    {
        const ctx = this.#context(uri);
        return ctx ? perf.measure('completion', () => getCompletions(ctx, ctx.lineIndex.offsetAt(position), options)) : [];
    }

    /** Lazily fills in a completion item's documentation/detail. */
    public resolveCompletion(uri: string, item: CompletionItem): CompletionItem
    {
        const ctx = this.#context(uri);
        return ctx ? resolveCompletion(ctx, item) : item;
    }

    /** Hover information at a position. */
    public getHover(uri: string, position: Position): Hover | null
    {
        const ctx = this.#context(uri);
        return ctx ? perf.measure('hover', () => getHover(ctx, ctx.lineIndex.offsetAt(position))) : null;
    }

    /** Definition location(s) for the symbol at a position. */
    public getDefinition(uri: string, position: Position): Location[]
    {
        const ctx = this.#context(uri);
        return ctx ? perf.measure('definition', () => getDefinition(ctx, ctx.lineIndex.offsetAt(position))) : [];
    }

    /** Type-definition location(s) for the symbol at a position. */
    public getTypeDefinition(uri: string, position: Position): Location[]
    {
        const ctx = this.#context(uri);
        return ctx ? getTypeDefinition(ctx, ctx.lineIndex.offsetAt(position)) : [];
    }

    /** All references to the symbol at a position. */
    public getReferences(uri: string, position: Position): Location[]
    {
        const ctx = this.#context(uri);
        return ctx ? getReferences(ctx, ctx.lineIndex.offsetAt(position)) : [];
    }

    /** Implementation location(s) for the symbol at a position (interface implementors, member overrides). */
    public getImplementation(uri: string, position: Position): Location[]
    {
        const ctx = this.#context(uri);
        return ctx ? perf.measure('implementation', () => getImplementation(ctx, ctx.lineIndex.offsetAt(position))) : [];
    }

    /** Occurrences of the symbol at a position, for editor highlighting. */
    public getDocumentHighlights(uri: string, position: Position): DocumentHighlight[]
    {
        const ctx = this.#context(uri);
        return ctx ? getDocumentHighlights(ctx, ctx.lineIndex.offsetAt(position)) : [];
    }

    /** Validates a rename target at a position (identifier range + current name), or null when not renameable. */
    public getPrepareRename(uri: string, position: Position): PrepareRenameResult | null
    {
        const ctx = this.#context(uri);
        return ctx ? getPrepareRename(ctx, ctx.lineIndex.offsetAt(position)) : null;
    }

    /** Workspace edit to rename the symbol at a position. */
    public getRenameEdits(uri: string, position: Position, newName: string): WorkspaceEdit | null
    {
        const ctx = this.#context(uri);
        return ctx ? getRenameEdits(ctx, ctx.lineIndex.offsetAt(position), newName) : null;
    }

    /** The call-hierarchy node(s) for the symbol at a position. */
    public getCallHierarchyPrepare(uri: string, position: Position): CallHierarchyItem[]
    {
        const ctx = this.#context(uri);
        return ctx ? prepareCallHierarchy(ctx, ctx.lineIndex.offsetAt(position)) : [];
    }

    /**
     * Callers of a prepared call-hierarchy item. The item carries its source URI
     * and offset in `data` (a follow-up request gets no position), so the query
     * re-anchors there.
     */
    public getIncomingCalls(item: CallHierarchyItem): CallHierarchyIncomingCall[]
    {
        if (!item.data)
        {
            return [];
        }
        const ctx = this.#context(item.data.uri);
        return ctx ? incomingCalls(ctx, item.data.offset) : [];
    }

    /** Callees of a prepared call-hierarchy item (anchored via `data`, as above). */
    public getOutgoingCalls(item: CallHierarchyItem): CallHierarchyOutgoingCall[]
    {
        if (!item.data)
        {
            return [];
        }
        const ctx = this.#context(item.data.uri);
        return ctx ? outgoingCalls(ctx, item.data.offset) : [];
    }

    /** The document outline. */
    public getDocumentSymbols(uri: string): DocumentSymbol[]
    {
        const ctx = this.#context(uri);
        return ctx ? getDocumentSymbols(ctx) : [];
    }

    /** Project-wide symbol search. */
    public getWorkspaceSymbols(query: string): WorkspaceSymbol[]
    {
        return getWorkspaceSymbols(this.#project, query);
    }

    /** Clickable links over the relative import specifiers in the document. */
    public getDocumentLinks(uri: string): DocumentLink[]
    {
        const ctx = this.#context(uri);
        return ctx ? getDocumentLinks(ctx) : [];
    }

    /** Color swatches over CSS color literals in style attributes and css`` templates. */
    public getDocumentColors(uri: string): ColorInformation[]
    {
        const ctx = this.#context(uri);
        return ctx ? getDocumentColors(ctx) : [];
    }

    /** The spelling choices for a picked color at a range. */
    public getColorPresentations(uri: string, color: Color, range: Range): ColorPresentation[]
    {
        const ctx = this.#context(uri);
        return ctx ? getColorPresentations(ctx, color, range) : [];
    }

    /** Unresolved reference lenses over the document's top-level declarations. */
    public getCodeLenses(uri: string): CodeLens[]
    {
        const ctx = this.#context(uri);
        return ctx ? getCodeLenses(ctx) : [];
    }

    /** Fills a lens's command with its reference count (anchored via `data`). */
    public resolveCodeLens(uri: string, lens: CodeLens): CodeLens
    {
        const ctx = this.#context(uri);
        return ctx ? resolveCodeLens(ctx, lens) : lens;
    }

    /** Signature help for the call enclosing a position. */
    public getSignatureHelp(uri: string, position: Position): SignatureHelp | null
    {
        const ctx = this.#context(uri);
        return ctx ? getSignatureHelp(ctx, ctx.lineIndex.offsetAt(position)) : null;
    }

    /** Diagnostics for the document. */
    public getDiagnostics(uri: string): Diagnostic[]
    {
        const ctx = this.#context(uri);
        return ctx ? perf.measure('diagnostics', () => getDiagnostics(ctx)) : [];
    }

    /** Packed semantic tokens for the markup in the document. */
    public getSemanticTokens(uri: string): SemanticTokens
    {
        const ctx = this.#context(uri);
        return ctx ? perf.measure('semanticTokens', () => getSemanticTokens(ctx)) : { data: [] };
    }

    /** Folding ranges for the document. */
    public getFoldingRanges(uri: string): FoldingRange[]
    {
        const ctx = this.#context(uri);
        return ctx ? getFoldingRanges(ctx) : [];
    }

    /** Code actions (quick fixes) for a range. */
    public getCodeActions(uri: string, range: Range, errorCodes: number[] = []): CodeAction[]
    {
        const ctx = this.#context(uri);
        return ctx ? getCodeActions(ctx, range, errorCodes) : [];
    }

    /** Whole-document formatting edits (script/expression regions only). */
    public getFormattingEdits(uri: string): TextEdit[]
    {
        const ctx = this.#context(uri);
        return ctx ? getFormattingEdits(ctx) : [];
    }

    /** Format-selection edits for a range (script/expression regions only). */
    public getRangeFormattingEdits(uri: string, range: Range): TextEdit[]
    {
        const ctx = this.#context(uri);
        return ctx ? getRangeFormattingEdits(ctx, range) : [];
    }

    /** Inline parameter-name / inferred-type hints for a range. */
    public getInlayHints(uri: string, range: Range, options?: InlayHintOptions): InlayHint[]
    {
        const ctx = this.#context(uri);
        return ctx ? getInlayHints(ctx, range, options) : [];
    }

    /** Smart-selection (Expand/Shrink Selection) chains for the given carets. */
    public getSelectionRanges(uri: string, positions: Position[]): SelectionRange[]
    {
        const ctx = this.#context(uri);
        return ctx ? getSelectionRanges(ctx, positions) : positions.map(position => ({ range: { start: position, end: position } }));
    }

    /** Formatting edits triggered by typing `ch` at a position. */
    public getOnTypeFormattingEdits(uri: string, position: Position, ch: string): TextEdit[]
    {
        const ctx = this.#context(uri);
        return ctx ? getOnTypeFormattingEdits(ctx, position, ch) : [];
    }

    /**
     * After the caret types `>`, returns a snippet closing the just-opened tag
     * (e.g. `$0</div>`), or null. Powers tag auto-closing.
     */
    public getAutoCloseTag(uri: string, position: Position): string | null
    {
        const ctx = this.#context(uri);
        return ctx ? getAutoCloseTag(ctx, ctx.lineIndex.offsetAt(position)) : null;
    }

    /** Opening/closing tag-name ranges to edit together (linked editing). */
    public getLinkedEditingRanges(uri: string, position: Position): Range[] | null
    {
        const ctx = this.#context(uri);
        return ctx ? getLinkedEditingRanges(ctx, ctx.lineIndex.offsetAt(position)) : null;
    }

    /** The compiled virtual TS for a document - exposed for tests/tooling. */
    public getVirtualCode(uri: string): string
    {
        return this.#project.getVirtual(uriToPath(uri)).code;
    }

    /**
     * The underlying TypeScript program over the virtual modules - exposed for
     * tooling (docgen) that needs to read the real, checked types. Returns
     * undefined when no program is available yet.
     */
    public getProgram(): ts.Program | undefined
    {
        return this.#project.service.getProgram();
    }

    /**
     * Toggles opt-in performance instrumentation. Off by default; while off the
     * normal path carries zero overhead (no `performance.now()` calls, nothing
     * recorded). Turn it on to populate `getMetrics`.
     */
    public setMetricsEnabled(enabled: boolean): void
    {
        perf.setEnabled(enabled);
    }

    /**
     * Timings for the most recent request, in milliseconds. Only meaningful when
     * instrumentation was enabled via `setMetricsEnabled` before the request;
     * otherwise the values are zero.
     */
    public getMetrics(): Metrics
    {
        return perf.snapshot();
    }

    /** Builds a RequestContext for a known document, or null if unknown. */
    #context(uri: string): RequestContext | null
    {
        if (!perf.isEnabled())
        {
            return this.#buildContext(uri);
        }
        const start = performance.now();
        const ctx = this.#buildContext(uri);
        perf.record('total', performance.now() - start);
        return ctx;
    }

    #buildContext(uri: string): RequestContext | null
    {
        const azerothPath = this.#docPath(uri);
        const source = this.#project.getSource(azerothPath);
        if (source === undefined)
        {
            return null;
        }
        return {
            project: this.#project,
            uri,
            azerothPath,
            virtualFile: toVirtualFile(azerothPath),
            source,
            virtual: this.#project.getVirtual(azerothPath),
            lineIndex: new LineIndex(source)
        };
    }
}
