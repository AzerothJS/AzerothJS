// Semantic highlighting for the markup layer. The TextMate grammar in the
// extension colours the bulk of a `.azeroth` file (it embeds the TypeScript
// grammar); these tokens add the precise, parser-derived distinctions a grammar
// can't make reliably - chiefly component tags vs. host tags and event vs.
// plain attributes. Output is LSP's packed delta encoding.

import { isWhitespace } from '@azerothjs/compiler';
import type { MarkupElement } from '@azerothjs/compiler';
import {
    SEMANTIC_TOKEN_TYPES,
    type SemanticTokens,
    type SemanticTokenType
} from '../protocol.ts';
import { collectMarkupNodes } from '../markup-model.ts';
import type { RequestContext } from '../request.ts';

const TYPE_INDEX = new Map<SemanticTokenType, number>(
    SEMANTIC_TOKEN_TYPES.map((type, index) => [type, index])
);

interface RawToken
{
    offset: number;
    length: number;
    type: SemanticTokenType;
}

/** Packed semantic tokens for the markup in the document. */
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

    tokens.sort((a, b) => a.offset - b.offset);
    return { data: encode(ctx, tokens) };
}

/** Emits tokens for a single element's tag name and attributes. */
function collectElementTokens(source: string, node: MarkupElement, tokens: RawToken[]): void
{
    tokens.push({
        offset: node.start + 1,
        length: node.tag.length,
        type: node.isComponent ? 'component' : 'tag'
    });

    for (const attr of node.attributes)
    {
        if (attr.spread || attr.name === null)
        {
            continue;
        }
        const isEvent = attr.name.length > 2 && attr.name.startsWith('on') && attr.name[2] === attr.name[2].toUpperCase();
        tokens.push({ offset: attr.start, length: attr.name.length, type: isEvent ? 'event' : 'attribute' });

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
                    tokens.push({ offset: q, length: attr.end - q, type: 'string' });
                }
            }
        }
    }
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
        data.push(deltaLine, deltaChar, token.length, TYPE_INDEX.get(token.type) ?? 0, 0);
        prevLine = pos.line;
        prevChar = pos.character;
    }

    return data;
}
