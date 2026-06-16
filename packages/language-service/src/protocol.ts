// Editor-agnostic result types for the language service. They mirror the
// Language Server Protocol shapes closely (and reuse its numeric enums) so the
// `@azerothjs/language-server` adapter is a near-passthrough, but the core
// itself depends on nothing but TypeScript and the compiler - which keeps it
// unit-testable without an editor in the loop.

/** Zero-based line/character position. */
export interface Position
{
    line: number;
    character: number;
}

/** A half-open `[start, end)` range. */
export interface Range
{
    start: Position;
    end: Position;
}

/** A range within a specific document. */
export interface Location
{
    uri: string;
    range: Range;
}

/** LSP CompletionItemKind values (subset used here). */
export const CompletionItemKind =
{
    Method: 2,
    Function: 3,
    Field: 5,
    Variable: 6,
    Class: 7,
    Interface: 8,
    Property: 10,
    Enum: 13,
    Keyword: 14,
    Snippet: 15,
    Constant: 21,
    Struct: 22,
    Event: 23,
    TypeParameter: 25,
    Text: 1,
    Module: 9,
    Value: 12,
    Component: 7
} as const;

export type CompletionItemKindValue = (typeof CompletionItemKind)[keyof typeof CompletionItemKind];

/** A single completion suggestion. */
export interface CompletionItem
{
    label: string;
    kind: CompletionItemKindValue;
    detail?: string;
    documentation?: string;
    insertText?: string;
    /** 2 = Snippet (LSP InsertTextFormat). */
    insertTextFormat?: 1 | 2;
    sortText?: string;
    filterText?: string;
    /** Characters that accept this item and are typed through (e.g. `=`, ` `). */
    commitCharacters?: string[];
    /** Pre-selects this item when the list opens (the clear contextual winner). */
    preselect?: boolean;
    /** Edits applied alongside the insertion (e.g. an auto-import line). */
    additionalTextEdits?: TextEdit[];
    /** Opaque payload so a resolve step can fetch lazy detail from TS. */
    data?: unknown;
}

/** Hover content for a position. */
export interface Hover
{
    /** Markdown contents. */
    contents: string;
    range?: Range;
}

/** A signature-help overload. */
export interface SignatureInformation
{
    label: string;
    documentation?: string;
    parameters: { label: string; documentation?: string }[];
}

/** Signature help at a call site. */
export interface SignatureHelp
{
    signatures: SignatureInformation[];
    activeSignature: number;
    activeParameter: number;
}

/** A text replacement within the current document. */
export interface TextEdit
{
    range: Range;
    newText: string;
}

/** Edits grouped by document URI (for rename). */
export interface WorkspaceEdit
{
    changes: Record<string, TextEdit[]>;
}

/** The prepareRename response: the identifier range and its current name. A null reply means the position can't be renamed. */
export interface PrepareRenameResult
{
    range: Range;
    placeholder: string;
}

/** An RGBA color, each channel in `[0, 1]` (LSP's normalized representation). */
export interface Color
{
    red: number;
    green: number;
    blue: number;
    alpha: number;
}

/** A color literal located in the document, for swatch rendering. */
export interface ColorInformation
{
    range: Range;
    color: Color;
}

/** One way to spell a picked color (e.g. `#ff0000`, `rgb(255, 0, 0)`). */
export interface ColorPresentation
{
    label: string;
    /** Edit that rewrites the literal to this spelling; absent when `label` is inserted verbatim. */
    textEdit?: TextEdit;
}

/** LSP SymbolKind values (subset). */
export const SymbolKind = {
    File: 1,
    Module: 2,
    Namespace: 3,
    Class: 5,
    Method: 6,
    Property: 7,
    Field: 8,
    Constructor: 9,
    Enum: 10,
    Interface: 11,
    Function: 12,
    Variable: 13,
    Constant: 14,
    Struct: 23,
    EnumMember: 22,
    TypeParameter: 26,
    Object: 19
} as const;

export type SymbolKindValue = (typeof SymbolKind)[keyof typeof SymbolKind];

/** A hierarchical document symbol. */
export interface DocumentSymbol
{
    name: string;
    detail?: string;
    kind: SymbolKindValue;
    range: Range;
    selectionRange: Range;
    children?: DocumentSymbol[];
}

/** A flat workspace symbol. */
export interface WorkspaceSymbol
{
    name: string;
    kind: SymbolKindValue;
    location: Location;
    containerName?: string;
}

/**
 * A node in the call hierarchy. `data` carries the originating document URI and
 * the source offset of the selection so the follow-up incoming/outgoing request
 * (which only gets the item back, not a position) can rebuild the query.
 */
export interface CallHierarchyItem
{
    name: string;
    kind: SymbolKindValue;
    detail?: string;
    uri: string;
    range: Range;
    selectionRange: Range;
    data?: { uri: string; offset: number };
}

/** A caller of the queried item, with the ranges where the calls appear. */
export interface CallHierarchyIncomingCall
{
    from: CallHierarchyItem;
    fromRanges: Range[];
}

/** A callee of the queried item, with the call-site ranges in the caller. */
export interface CallHierarchyOutgoingCall
{
    to: CallHierarchyItem;
    fromRanges: Range[];
}

/** LSP DiagnosticSeverity. */
export const DiagnosticSeverity =
{
    Error: 1,
    Warning: 2,
    Information: 3,
    Hint: 4
} as const;

export type DiagnosticSeverityValue = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

/** A secondary location that explains a diagnostic (e.g. "'x' is declared here"). */
export interface DiagnosticRelatedInformation
{
    location: Location;
    message: string;
}

/** A problem reported on a range. */
export interface Diagnostic
{
    range: Range;
    severity: DiagnosticSeverityValue;
    message: string;
    code?: string | number;
    source: string;
    relatedInformation?: DiagnosticRelatedInformation[];
}

/** A smart-selection range and its enclosing parent (for Expand Selection). */
export interface SelectionRange
{
    range: Range;
    parent?: SelectionRange;
}

/** An inline hint. `kind`: 1 Type, 2 Parameter. */
export interface InlayHint
{
    position: Position;
    label: string;
    kind?: 1 | 2;
    paddingLeft?: boolean;
    paddingRight?: boolean;
}

/** An occurrence of a symbol to highlight. `kind`: 1 text, 2 read, 3 write. */
export interface DocumentHighlight
{
    range: Range;
    kind?: 1 | 2 | 3;
}

/** A collapsible region. */
export interface FoldingRange
{
    startLine: number;
    endLine: number;
    kind?: 'comment' | 'region' | 'imports';
}

/** An editor command (title + identifier + optional arguments). */
export interface Command
{
    title: string;
    command: string;
    arguments?: unknown[];
}

/**
 * A clickable annotation over a range (e.g. a "N references" lens). Lenses are
 * emitted unresolved - with `data` carrying the source URI + offset - so the
 * initial pass stays cheap; the `command` is filled in by a later resolve step.
 */
export interface CodeLens
{
    range: Range;
    command?: Command;
    data?: unknown;
}

/**
 * A clickable link over a range (e.g. a relative import specifier). `target` is
 * the `file://` URI the editor opens on click; `tooltip` is optional hover text.
 */
export interface DocumentLink
{
    range: Range;
    target?: string;
    tooltip?: string;
}

/** A code action (quick fix / refactor). */
export interface CodeAction
{
    title: string;
    kind: string;
    edit?: WorkspaceEdit;
    /** True for the preferred fix at a position. */
    isPreferred?: boolean;
}

/** Raw semantic-token data in LSP's packed delta encoding. */
export interface SemanticTokens
{
    data: number[];
}

/**
 * The token types this service emits, in legend order. Each name's index is the
 * legend id sent on the wire, so this order is a contract with the editor and
 * must stay stable - APPEND new types, never reorder. The leading six are the
 * markup-layer distinctions; the trailing block is the standard set the
 * TypeScript classifier produces for embedded script/expression regions, so a
 * `.azeroth` file's TS colours the same as a `.ts` file.
 */
export const SEMANTIC_TOKEN_TYPES = [
    'component', 'tag', 'attribute', 'event', 'string', 'delimiter',
    'namespace', 'class', 'enum', 'interface', 'typeParameter', 'type',
    'parameter', 'variable', 'property', 'enumMember', 'function', 'method'
] as const;

export type SemanticTokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];

/**
 * The token modifiers this service emits, in legend order. Each name's index is
 * the bit position the encoder sets in a token's modifier mask, so this order is
 * a wire contract with the editor and must stay stable. The set mirrors the
 * standard TypeScript modifiers so the legend reads the same as a `.ts` file;
 * the markup provider currently sets only `defaultLibrary` (built-in components).
 */
export const SEMANTIC_TOKEN_MODIFIERS = [
    'declaration', 'readonly', 'static', 'async', 'defaultLibrary', 'local'
] as const;

export type SemanticTokenModifier = (typeof SEMANTIC_TOKEN_MODIFIERS)[number];
