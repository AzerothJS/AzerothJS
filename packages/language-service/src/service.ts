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
    CodeAction,
    CompletionItem,
    Diagnostic,
    DocumentHighlight,
    DocumentSymbol,
    FoldingRange,
    Hover,
    InlayHint,
    Location,
    Position,
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
    getReferences,
    getRenameEdits,
    getTypeDefinition
} from './providers/navigation.ts';
import { getDocumentSymbols, getWorkspaceSymbols } from './providers/symbols.ts';
import { getDiagnostics } from './providers/diagnostics.ts';
import { getSignatureHelp } from './providers/signature.ts';
import { getSemanticTokens } from './providers/semantic-tokens.ts';
import {
    getCodeActions,
    getFoldingRanges,
    getFormattingEdits,
    getOnTypeFormattingEdits,
    getSelectionRanges
} from './providers/structure.ts';
import { getAutoCloseTag, getLinkedEditingRanges } from './providers/editing.ts';
import { getInlayHints, type InlayHintOptions } from './providers/inlay-hints.ts';

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
    private readonly project: AzerothProject;

    constructor(
        workspaceDirectory: string,
        configPath?: string,
        options: { rootProjectFiles?: boolean } = {}
    )
    {
        this.project = new AzerothProject(workspaceDirectory, configPath, options);
    }

    /**
     * The consuming project's real `.ts` files (from its tsconfig). Used by the
     * combined checker to iterate the `.ts` side; only populated meaningfully
     * when the service was constructed with `{ rootProjectFiles: true }`.
     */
    public getProjectTsFiles(): readonly string[]
    {
        return this.project.getProjectFiles();
    }

    /**
     * Diagnostics for a real `.ts` file in the program (no offset
     * mapping - positions are the file's own). Lets the combined checker report
     * `.ts` errors - including those at the `.ts` -> `.azeroth` import boundary -
     * from the same program that checks the `.azeroth` files.
     */
    public getTsDiagnostics(filePath: string): Diagnostic[]
    {
        const service = this.project.service;
        const raw = [
            ...service.getSyntacticDiagnostics(filePath),
            ...service.getSemanticDiagnostics(filePath)
        ];

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
        this.project.openDocument(uriToPath(uri), source);
    }

    /** Updates a document's content. */
    public didChange(uri: string, source: string): void
    {
        this.project.openDocument(uriToPath(uri), source);
    }

    /** Drops a document. */
    public didClose(uri: string): void
    {
        this.project.closeDocument(uriToPath(uri));
    }

    /**
     * Re-scans the workspace for `.azeroth` files. Call on a watched-file
     * create/delete so newly-added components join the program (cross-file
     * completion, go-to-definition, auto-import) without a restart.
     */
    public refreshWorkspace(): void
    {
        this.project.refreshWorkspace();
    }

    /** Context-aware completion at a position. */
    public getCompletions(uri: string, position: Position, options?: CompletionOptions): CompletionItem[]
    {
        const ctx = this.context(uri);
        return ctx ? getCompletions(ctx, ctx.lineIndex.offsetAt(position), options) : [];
    }

    /** Lazily fills in a completion item's documentation/detail. */
    public resolveCompletion(uri: string, item: CompletionItem): CompletionItem
    {
        const ctx = this.context(uri);
        return ctx ? resolveCompletion(ctx, item) : item;
    }

    /** Hover information at a position. */
    public getHover(uri: string, position: Position): Hover | null
    {
        const ctx = this.context(uri);
        return ctx ? getHover(ctx, ctx.lineIndex.offsetAt(position)) : null;
    }

    /** Definition location(s) for the symbol at a position. */
    public getDefinition(uri: string, position: Position): Location[]
    {
        const ctx = this.context(uri);
        return ctx ? getDefinition(ctx, ctx.lineIndex.offsetAt(position)) : [];
    }

    /** Type-definition location(s) for the symbol at a position. */
    public getTypeDefinition(uri: string, position: Position): Location[]
    {
        const ctx = this.context(uri);
        return ctx ? getTypeDefinition(ctx, ctx.lineIndex.offsetAt(position)) : [];
    }

    /** All references to the symbol at a position. */
    public getReferences(uri: string, position: Position): Location[]
    {
        const ctx = this.context(uri);
        return ctx ? getReferences(ctx, ctx.lineIndex.offsetAt(position)) : [];
    }

    /** Occurrences of the symbol at a position, for editor highlighting. */
    public getDocumentHighlights(uri: string, position: Position): DocumentHighlight[]
    {
        const ctx = this.context(uri);
        return ctx ? getDocumentHighlights(ctx, ctx.lineIndex.offsetAt(position)) : [];
    }

    /** Workspace edit to rename the symbol at a position. */
    public getRenameEdits(uri: string, position: Position, newName: string): WorkspaceEdit | null
    {
        const ctx = this.context(uri);
        return ctx ? getRenameEdits(ctx, ctx.lineIndex.offsetAt(position), newName) : null;
    }

    /** The document outline. */
    public getDocumentSymbols(uri: string): DocumentSymbol[]
    {
        const ctx = this.context(uri);
        return ctx ? getDocumentSymbols(ctx) : [];
    }

    /** Project-wide symbol search. */
    public getWorkspaceSymbols(query: string): WorkspaceSymbol[]
    {
        return getWorkspaceSymbols(this.project, query);
    }

    /** Signature help for the call enclosing a position. */
    public getSignatureHelp(uri: string, position: Position): SignatureHelp | null
    {
        const ctx = this.context(uri);
        return ctx ? getSignatureHelp(ctx, ctx.lineIndex.offsetAt(position)) : null;
    }

    /** Diagnostics for the document. */
    public getDiagnostics(uri: string): Diagnostic[]
    {
        const ctx = this.context(uri);
        return ctx ? getDiagnostics(ctx) : [];
    }

    /** Packed semantic tokens for the markup in the document. */
    public getSemanticTokens(uri: string): SemanticTokens
    {
        const ctx = this.context(uri);
        return ctx ? getSemanticTokens(ctx) : { data: [] };
    }

    /** Folding ranges for the document. */
    public getFoldingRanges(uri: string): FoldingRange[]
    {
        const ctx = this.context(uri);
        return ctx ? getFoldingRanges(ctx) : [];
    }

    /** Code actions (quick fixes) for a range. */
    public getCodeActions(uri: string, range: Range, errorCodes: number[] = []): CodeAction[]
    {
        const ctx = this.context(uri);
        return ctx ? getCodeActions(ctx, range, errorCodes) : [];
    }

    /** Whole-document formatting edits (script/expression regions only). */
    public getFormattingEdits(uri: string): TextEdit[]
    {
        const ctx = this.context(uri);
        return ctx ? getFormattingEdits(ctx) : [];
    }

    /** Inline parameter-name / inferred-type hints for a range. */
    public getInlayHints(uri: string, range: Range, options?: InlayHintOptions): InlayHint[]
    {
        const ctx = this.context(uri);
        return ctx ? getInlayHints(ctx, range, options) : [];
    }

    /** Smart-selection (Expand/Shrink Selection) chains for the given carets. */
    public getSelectionRanges(uri: string, positions: Position[]): SelectionRange[]
    {
        const ctx = this.context(uri);
        return ctx ? getSelectionRanges(ctx, positions) : positions.map(position => ({ range: { start: position, end: position } }));
    }

    /** Formatting edits triggered by typing `ch` at a position. */
    public getOnTypeFormattingEdits(uri: string, position: Position, ch: string): TextEdit[]
    {
        const ctx = this.context(uri);
        return ctx ? getOnTypeFormattingEdits(ctx, position, ch) : [];
    }

    /**
     * After the caret types `>`, returns a snippet closing the just-opened tag
     * (e.g. `$0</div>`), or null. Powers JSX-style tag auto-closing.
     */
    public getAutoCloseTag(uri: string, position: Position): string | null
    {
        const ctx = this.context(uri);
        return ctx ? getAutoCloseTag(ctx, ctx.lineIndex.offsetAt(position)) : null;
    }

    /** Opening/closing tag-name ranges to edit together (linked editing). */
    public getLinkedEditingRanges(uri: string, position: Position): Range[] | null
    {
        const ctx = this.context(uri);
        return ctx ? getLinkedEditingRanges(ctx, ctx.lineIndex.offsetAt(position)) : null;
    }

    /** The compiled virtual TS for a document - exposed for tests/tooling. */
    public getVirtualCode(uri: string): string
    {
        return this.project.getVirtual(uriToPath(uri)).code;
    }

    /** Builds a RequestContext for a known document, or null if unknown. */
    private context(uri: string): RequestContext | null
    {
        const azerothPath = uriToPath(uri);
        const source = this.project.getSource(azerothPath);
        if (source === undefined)
        {
            return null;
        }
        return {
            project: this.project,
            uri,
            azerothPath,
            virtualFile: toVirtualFile(azerothPath),
            source,
            virtual: this.project.getVirtual(azerothPath),
            lineIndex: new LineIndex(source)
        };
    }
}
