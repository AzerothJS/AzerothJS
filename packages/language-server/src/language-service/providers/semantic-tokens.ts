// Semantic highlighting for a `.azeroth` file. Two sources are merged: the
// markup layer (component vs. host tags, event vs. plain attributes - the
// parser-derived distinctions a TextMate grammar can't make reliably), and the
// TypeScript classifier run over the virtual module, which colours the embedded
// script and expression regions exactly as a `.ts` file would. Markup tokens
// win inside markup regions; TS tokens cover the script/hole code. Output is
// LSP's packed delta encoding.

import ts from 'typescript';
import { isWhitespace, isIdentPart, parseModule } from '@azerothjs/compiler';
import type { MarkupElement } from '@azerothjs/compiler';
import {
    SEMANTIC_TOKEN_TYPES,
    SEMANTIC_TOKEN_MODIFIERS,
    type SemanticTokens,
    type SemanticTokenType,
    type SemanticTokenModifier
} from '../protocol.ts';
import { collectMarkupNodes } from '../markup-model.ts';
import { BUILTIN_COMPONENTS } from '../virtual-code.ts';
import type { RequestContext } from '../request.ts';

const TYPE_INDEX = new Map<SemanticTokenType, number>(
    SEMANTIC_TOKEN_TYPES.map((type, index) => [type, index])
);

const MODIFIER_BIT = new Map<SemanticTokenModifier, number>(
    SEMANTIC_TOKEN_MODIFIERS.map((modifier, index) => [modifier, 1 << index])
);

// A built-in component (`Show`, `For`, ...) is library-provided, so its tag tokens
// carry the `defaultLibrary` modifier - the one distinction the markup layer can
// make. User components and host tags carry no modifiers.
const DEFAULT_LIBRARY_BIT = MODIFIER_BIT.get('defaultLibrary') ?? 0;
const BUILTIN_SET = new Set<string>(BUILTIN_COMPONENTS);

// The name declared by a reactive keyword carries `reactive` (+ `declaration`), so themes can
// colour a component's reactive surface distinctly from plain variables.
const REACTIVE_DECL_BITS = (MODIFIER_BIT.get('reactive') ?? 0) | (MODIFIER_BIT.get('declaration') ?? 0);

/** Body-item kinds that declare a reactive name (effect declares none). */
const REACTIVE_KINDS = new Set(['state', 'derived', 'deferred', 'resource', 'stream', 'store', 'selector', 'form']);

// The 2020 classifier (`SemanticClassificationFormat.TwentyTwenty`) packs each
// span's classification as `((tokenType + 1) << typeOffset) | modifierBitset`,
// where typeOffset is 8 and the low 8 bits are a TokenModifier bitset. The `+ 1`
// is part of TS's wire encoding (so a raw 0 means "no token"), so decoding the
// type index subtracts it back off - see classifier2020's getSemanticTokens.
const TS_TYPE_OFFSET = 8;
const TS_MODIFIER_MASK = 255;

// Maps TypeScript's own classifier token-type index to a legend type. This is
// the v2020 `TokenType` enum order (verified against the installed typescript):
// 0=class, 1=enum, 2=interface, 3=namespace, 4=typeParameter, 5=type,
// 6=parameter, 7=variable, 8=enumMember, 9=property, 10=function, 11=member.
// `member` is the method case in this legend; there is no token type for keyword
// or comment spans (the grammar colours those), so those classifications drop.
const TS_TYPE_TO_LEGEND: readonly (SemanticTokenType | null)[] = [
    'class', 'enum', 'interface', 'namespace', 'typeParameter', 'type',
    'parameter', 'variable', 'enumMember', 'property', 'function', 'method'
];

// Maps TypeScript's `TokenModifier` bit index to this legend's modifier mask.
// The two legends share the same names but NOT the same order, so the remap is
// by name: TS bits are declaration=0, static=1, async=2, readonly=3,
// defaultLibrary=4, local=5.
const TS_MODIFIER_TO_BIT: readonly number[] = [
    MODIFIER_BIT.get('declaration') ?? 0,
    MODIFIER_BIT.get('static') ?? 0,
    MODIFIER_BIT.get('async') ?? 0,
    MODIFIER_BIT.get('readonly') ?? 0,
    MODIFIER_BIT.get('defaultLibrary') ?? 0,
    MODIFIER_BIT.get('local') ?? 0
];

interface RawToken
{
    offset: number;
    length: number;
    type: SemanticTokenType;
    modifiers: number;
}

/**
 * Packed semantic tokens for the document: the markup tokens merged with the
 * TypeScript classifications of the embedded script/expression regions. Markup
 * tokens win where they overlap, so the TS pass only colours code outside the
 * tag/attribute spans the markup layer already owns.
 */
export function getSemanticTokens(ctx: RequestContext): SemanticTokens
{
    const tokens: RawToken[] = [];
    for (const node of collectMarkupNodes(ctx.source))
    {
        if (node.kind === 'element')
        {
            collectElementTokens(ctx.source, node, tokens);
        }
    }

    // Before the TS pass, so the classifier's plain `variable` token for the same name yields to
    // the reactive-marked one (the TS pass skips spans already owned by earlier tokens).
    collectReactiveDeclTokens(ctx, tokens);

    collectScriptTokens(ctx, tokens);
    collectImportTokens(ctx, tokens);

    tokens.sort((a, b) => a.offset - b.offset);
    return { data: encode(ctx, tokens) };
}

/**
 * Emits a `variable` token with the `reactive` (+ `declaration`) modifiers for every name declared
 * by a reactive keyword (`state count`, `form login`, ...), so themes can colour a component's
 * reactive surface distinctly from plain variables. `effect` declares no name and contributes
 * nothing; a source that fails to parse contributes nothing (diagnostics own that case).
 */
function collectReactiveDeclTokens(ctx: RequestContext, tokens: RawToken[]): void
{
    let module: ReturnType<typeof parseModule>;
    try
    {
        module = parseModule(ctx.source);
    }
    catch
    {
        return;
    }
    for (const item of module.items)
    {
        if (item.kind !== 'component')
        {
            continue;
        }
        for (const decl of item.body)
        {
            if (REACTIVE_KINDS.has(decl.kind) && 'nameStart' in decl && 'nameEnd' in decl)
            {
                tokens.push({
                    offset: decl.nameStart,
                    length: decl.nameEnd - decl.nameStart,
                    type: 'variable',
                    modifiers: REACTIVE_DECL_BITS
                });
            }
        }
    }
}

/**
 * Emits a `variable` token for every binding name in an `import ... from '...'`
 * declaration (default, namespace, named, and `as` aliases). TypeScript's
 * classifier does not tag import bindings, so without this they would stay
 * uncoloured even though the same names are coloured everywhere they're later
 * used. Generated scaffolding imports don't map back to source and are dropped.
 */
function collectImportTokens(ctx: RequestContext, tokens: RawToken[]): void
{
    const sourceFile = ctx.project.service.getProgram()?.getSourceFile(ctx.virtualFile);
    if (sourceFile === undefined)
    {
        return;
    }

    const push = (node: ts.Node): void =>
    {
        const mapped = ctx.virtual.mapping.toOriginalRange(node.getStart(sourceFile), node.getEnd());
        if (mapped !== null)
        {
            tokens.push({ offset: mapped.start, length: mapped.end - mapped.start, type: 'variable', modifiers: 0 });
        }
    };

    for (const statement of sourceFile.statements)
    {
        if (!ts.isImportDeclaration(statement) || statement.importClause === undefined)
        {
            continue;
        }
        const clause = statement.importClause;
        if (clause.name !== undefined)
        {
            push(clause.name);
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined)
        {
            if (ts.isNamespaceImport(bindings))
            {
                push(bindings.name);
            }
            else
            {
                for (const element of bindings.elements)
                {
                    push(element.name);
                }
            }
        }
    }
}

/**
 * Runs the TypeScript classifier over the virtual module and appends a token
 * for each span that maps cleanly back to source and doesn't fall inside a
 * markup-owned span (markup wins there). Spans over generated scaffolding don't
 * map and are dropped; keyword/comment classifications carry no legend type and
 * are dropped too (the grammar colours them).
 */
function collectScriptTokens(ctx: RequestContext, tokens: RawToken[]): void
{
    // markup tokens are the only entries so far; their source spans are the
    // regions the TS pass must yield to.
    const markupSpans = tokens.map(token => ({ start: token.offset, end: token.offset + token.length }));

    const code = ctx.virtual.code;
    const classified = ctx.project.service.getEncodedSemanticClassifications(
        ctx.virtualFile,
        { start: 0, length: code.length },
        ts.SemanticClassificationFormat.TwentyTwenty
    );

    const spans = classified.spans;
    for (let i = 0; i + 2 < spans.length; i += 3)
    {
        const start = spans[i];
        const length = spans[i + 1];
        const classification = spans[i + 2];
        if (start === undefined || length === undefined || classification === undefined)
        {
            continue; // spans is a dense triplet list; satisfies the indexed-access check
        }

        const tsType = (classification >> TS_TYPE_OFFSET) - 1;
        const type = TS_TYPE_TO_LEGEND[tsType];
        if (type === undefined || type === null)
        {
            continue;
        }

        const mapped = ctx.virtual.mapping.toOriginalRange(start, start + length);
        if (mapped === null)
        {
            continue;
        }

        if (overlapsMarkup(markupSpans, mapped.start, mapped.end))
        {
            continue;
        }

        tokens.push({
            offset: mapped.start,
            length: mapped.end - mapped.start,
            type,
            modifiers: remapModifiers(classification & TS_MODIFIER_MASK)
        });
    }
}

/** Translates a TS modifier bitset into this legend's modifier mask. */
function remapModifiers(bitset: number): number
{
    let mask = 0;
    for (let bit = 0; bit < TS_MODIFIER_TO_BIT.length; bit++)
    {
        if (bitset & (1 << bit))
        {
            mask |= TS_MODIFIER_TO_BIT[bit] ?? 0;
        }
    }
    return mask;
}

/** True when `[start, end)` intersects any markup-owned source span. */
function overlapsMarkup(markupSpans: { start: number; end: number }[], start: number, end: number): boolean
{
    for (const span of markupSpans)
    {
        if (start < span.end && end > span.start)
        {
            return true;
        }
    }
    return false;
}

/** Emits tokens for a single element's tag name (open + close) and attributes. */
function collectElementTokens(source: string, node: MarkupElement, tokens: RawToken[]): void
{
    const type: SemanticTokenType = node.isComponent ? 'component' : 'tag';
    const modifiers = node.isComponent && BUILTIN_SET.has(node.tag) ? DEFAULT_LIBRARY_BIT : 0;

    // Opening tag name (`<div`, `<Switch`).
    tokens.push({ offset: node.start + 1, length: node.tag.length, type, modifiers });

    // Closing tag name (`</div>`, `</Switch>`); absent for self-closing elements.
    const close = closingTagNameSpan(source, node);
    if (close !== null)
    {
        tokens.push({ offset: close.start, length: close.end - close.start, type, modifiers });
    }

    for (const attr of node.attributes)
    {
        if (attr.spread || attr.name === null)
        {
            continue;
        }
        const third = attr.name[2];
        const isEvent = attr.name.length > 2 && attr.name.startsWith('on') && third !== undefined && third === third.toUpperCase();
        tokens.push({ offset: attr.start, length: attr.name.length, type: isEvent ? 'event' : 'attribute', modifiers: 0 });

        if (attr.value.kind === 'static')
        {
            const eq = source.indexOf('=', attr.start + attr.name.length);
            if (eq !== -1)
            {
                let q = eq + 1;
                while (q < attr.end && isWhitespace(source[q]))
                {
                    q++;
                }
                if (source[q] === '"' || source[q] === '\'')
                {
                    tokens.push({ offset: q, length: attr.end - q, type: 'string', modifiers: 0 });
                }
            }
        }
    }
}

/**
 * The `[start, end)` of an element's CLOSING tag name (`div` in `</div>`), or
 * null when the element is self-closing (`<br/>`, `<Comp ... />`). Scans back
 * from the element's final `>`: if the char before it (past whitespace) is `/`
 * the element self-closes; otherwise the identifier run ending there is the
 * closing tag name, which must be preceded (past whitespace) by `/`.
 */
function closingTagNameSpan(source: string, node: MarkupElement): { start: number; end: number } | null
{
    const end = node.end;
    if (end < 2 || source[end - 1] !== '>')
    {
        return null;
    }

    let i = end - 2;
    while (i > node.start && isWhitespace(source[i]))
    {
        i--;
    }
    // `/>` (self-closing): the slash sits right before the `>`.
    if (source[i] === '/')
    {
        return null;
    }

    const nameEnd = i + 1;
    let j = i;
    while (j > node.start && (isIdentPart(source[j]) || source[j] === '.' || source[j] === '-'))
    {
        j--;
    }
    let nameStart = j + 1;
    // A tag name can contain `.`/`-` (`Foo.Bar`, `my-el`) but never START with
    // one; drop any leading punctuation the run picked up from a malformed close.
    while (nameStart < nameEnd && (source[nameStart] === '.' || source[nameStart] === '-'))
    {
        nameStart++;
    }
    if (nameStart >= nameEnd)
    {
        return null;
    }
    // Confirm a closing tag: the name is preceded (past whitespace) by `/`.
    let k = j;
    while (k > node.start && isWhitespace(source[k]))
    {
        k--;
    }
    if (source[k] !== '/')
    {
        return null;
    }
    return { start: nameStart, end: nameEnd };
}

/** Delta-encodes tokens into the flat array LSP expects (5 ints each). */
function encode(ctx: RequestContext, tokens: RawToken[]): number[]
{
    const data: number[] = [];
    let prevLine = 0;
    let prevChar = 0;

    for (const token of tokens)
    {
        const pos = ctx.lineIndex.positionAt(token.offset);
        const deltaLine = pos.line - prevLine;
        const deltaChar = deltaLine === 0 ? pos.character - prevChar : pos.character;
        data.push(deltaLine, deltaChar, token.length, TYPE_INDEX.get(token.type) ?? 0, token.modifiers);
        prevLine = pos.line;
        prevChar = pos.character;
    }

    return data;
}
