/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import ts from 'typescript';

export type StepKind = 'trivia' | 'literal' | 'identifier' | 'markup' | 'open' | 'close' | 'punct';
export interface Step
{
    next: number;
    kind: StepKind;
    text: string;
    prevChar: string;
    prevWord: string;
    member: boolean;
    postfix: boolean;
    spread: boolean;
    endsOperand: boolean;
    headClosed: boolean;
}

// The TypeScript scanner builds dozens of closures. Reuse its token decoder across short
// markup holes. Each synchronous scan sets the complete input and releases it before any
// nested parser runs. All traversal state (including regex goals) belongs to each walk.
const decoder = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard);
// These statement forms can end at a newline even after an identifier (a type, a
// declarator, or a break/continue label). Ordinary expression holes need no TS parse.
const ASI_STATEMENTS = new Set(['let', 'const', 'var', 'type', 'interface', 'declare', 'debugger', 'break', 'continue']);
const BLOCK_WORDS = new Set(['do', 'else', 'try', 'finally', 'catch']);

const HEADS = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
const PREFIX = new Set(['return', 'typeof', 'instanceof', 'in', 'do', 'else', 'yield', 'await', 'case', 'delete', 'void', 'new', 'throw', 'default', 'extends']);
const lineEnd = /[\r\n\u2028\u2029]/;

/** Represent a consumed markup tree as one TS operand with the same offsets and line breaks.
 * Keeping the padding inside parentheses also keeps its newlines inside the operand for ASI. */
export function maskMarkupOperand(source: string, start: number, end: number): string
{
    if (end - start >= 3 && source[end - 1] === '>')
    {
        return '(0' + source.slice(start + 2, end - 1).replace(/[^\r\n\u2028\u2029]/g, ' ') + ')';
    }
    return '0' + source.slice(start + 1, end).replace(/[^\r\n\u2028\u2029]/g, ' ');
}

/** Consult the TS grammar for slash after a type argument or an ASI-eligible declaration.
 * Only actual literal, JSX and operator nodes provide evidence in a partly recovered framework file. */
function lexicalFacts(source: string, start: number, end: number, markup: number[], firstMarkup: number, prefix: string): Map<number, boolean>
{
    // A consumed framework tree is one operand, including HTML void elements with no TSX
    // spelling. Mask only such spans so TS still parses the entire variable list, including
    // commas inside type arguments. Padding preserves every subsequent token offset.
    let region = prefix;
    const offset = start - prefix.length;
    let at = start;
    for (let i = firstMarkup; i < markup.length; i += 2)
    {
        const open = markup[i] as number;
        const close = markup[i + 1] as number;
        if (open >= end)
        {
            break;
        }
        region += source.slice(at, open) + maskMarkupOperand(source, open, close);
        at = close;
    }
    const file = ts.createSourceFile('region.tsx', region + source.slice(at, end), ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    const facts = new Map<number, boolean>();
    const pending: ts.Node[] = [file];
    while (pending.length > 0)
    {
        const node = pending.pop() as ts.Node;
        if (node.kind === ts.SyntaxKind.RegularExpressionLiteral || ts.isJsxOpeningElement(node)
            || ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningFragment(node))
        {
            facts.set(offset + node.getStart(file), true);
        }
        else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.SlashToken
            || node.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken || node.operatorToken.kind === ts.SyntaxKind.LessThanToken))
        {
            facts.set(offset + node.operatorToken.getStart(file), false);
        }
        else if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.ExclamationToken
            || node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
        {
            facts.set(offset + node.getStart(file), true);
        }
        else if (ts.isNonNullExpression(node) || ts.isPostfixUnaryExpression(node))
        {
            facts.set(offset + node.end - (ts.isNonNullExpression(node) ? 1 : 2), false);
        }
        ts.forEachChild(node, child =>
        {
            pending.push(child);
        });
    }
    return facts;
}

type Declaration = 'variable' | 'initializer' | 'statement' | null;

interface Frame
{
    anchor: number;
    firstMarkup: number;
    prefix: string;
    markupCount: number;
    mayBeLabel: boolean;
    declaration: Declaration;
    closeOperand: boolean;
    head: boolean;
    forHead: boolean;
}

/** One forward lexical walk. Structural callers consume brackets and punctuators one character
 * at a time. TypeScript supplies literal, identifier, whitespace and compound-token boundaries.
 * The caller supplies its existing markup parser and its namespace-aware template reader. */
export function codeWalker(source: string, from: number, limit: number, expression: boolean,
    readTemplate: (i: number) => number, readMarkup: (i: number) => number, readGeneric: ((i: number) => number) | undefined,
    adjacentMarkup: (i: number) => boolean): (i: number) => Step
{
    const frames: Frame[] = [];
    const initial: Step = { next: from, kind: 'punct', text: '', prevChar: '', prevWord: '', endsOperand: false,
        member: false, postfix: false, spread: false, headClosed: false };
    let last = initial;
    let next = from;
    let lineBreak = false;
    let forAwait = false;
    let labelName = false;
    let labelColon = false;
    let compoundEnd = -1;
    let compound = '';
    let postfixUpdate = false;
    let anchor = from;
    const markup: number[] = [];
    let firstMarkup = 0;
    let prefix = '';
    let declaration: Declaration = null;
    let grammar: Map<number, boolean> | undefined;
    let parsedFrom = -1;
    let parsedTo = from;

    const consult = (i: number, fallback: boolean): boolean =>
    {
        if (i >= parsedTo || parsedFrom > anchor || (!grammar?.has(i) && parsedFrom < anchor))
        {
            // Reparse from a fresh statement after framework markup. In a long expression
            // double the observed span, so successive ambiguous operators share the parse.
            parsedFrom = anchor;
            parsedTo = Math.min(limit, i + Math.max(32, i - anchor + 1));
            grammar = lexicalFacts(source, parsedFrom, parsedTo, markup, firstMarkup, prefix);
        }
        return grammar?.get(i) ?? fallback;
    };

    const afterOperand = (end: number): void =>
    {
        // Once a whole operand has been consumed, its spelling cannot affect the tail.
        // Preserve the variable-list context for a later comma, even after HTML-only
        // markup. This also bounds parsing across arrays of adjacent markup expressions.
        anchor = end;
        firstMarkup = markup.length;
        prefix = declaration === 'initializer' || declaration === 'variable' ? 'let _ = 0 ' : '0 ';
        parsedTo = Math.min(parsedTo, end);
    };

    return (i: number): Step =>
    {
        if (i > next && last.kind === 'markup')
        {
            // Markup search reports the opening offset; its owner then parses the whole
            // region. Resume at that end while retaining the surrounding expression.
            markup[markup.length - 1] = i;
            afterOperand(i);
        }
        else if (i !== next)
        {
            // The component and section parsers can consume an entire declaration between steps.
            last = initial;
            frames.length = 0;
            lineBreak = false;
            forAwait = false;
            labelName = false;
            labelColon = false;
            compoundEnd = -1;
            anchor = i;
            firstMarkup = markup.length;
            prefix = '';
            declaration = null;
        }
        const ch = source[i] ?? '';
        const continuation = i < compoundEnd;
        let regex = false;
        if (ch === '/' && !continuation && source[i + 1] !== '/' && source[i + 1] !== '*')
        {
            const ambiguous = lineBreak && declaration !== null && declaration !== 'initializer' && last.endsOperand || last.text === '}'
                || last.text === '>' && compound !== '=>';
            regex = ambiguous ? consult(i, !last.endsOperand) : !last.endsOperand;
        }
        let token: ts.SyntaxKind = ts.SyntaxKind.Unknown;
        next = i + 1;
        if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\u2028' || ch === '\u2029')
        {
            token = ts.SyntaxKind.WhitespaceTrivia;
        }
        else if (!'()[]{};,:'.includes(ch) && !(ch === '/' && !regex && !'/*='.includes(source[next] ?? '')))
        {
            decoder.setText(source, i);
            token = decoder.scan();
            if (regex)
            {
                decoder.reScanSlashToken();
            }
            next = decoder.getTokenEnd();
            decoder.setText(undefined);
        }
        if (token >= ts.SyntaxKind.FirstTriviaToken && token <= ts.SyntaxKind.LastTriviaToken)
        {
            lineBreak ||= lineEnd.test(source.slice(i, next));
            return { ...last, next, kind: 'trivia', text: '' };
        }
        let kind: StepKind = 'punct';
        let text = ch;
        let endsOperand = false;
        let member = false;
        let postfix = false;
        let spread = false;
        let headClosed = false;
        const frame = frames.at(-1);
        if (ch === '`')
        {
            next = readTemplate(i);
            kind = 'literal';
        }
        else if (regex)
        {
            kind = 'literal';
        }
        else if (ch === '<' && !continuation && (source[i + 1] === '>' || /^[a-z_$]$/i.test(source[i + 1] ?? ''))
            && (last.text === '}' || (last.text === '>' && compound !== '=>')
                ? consult(i, !last.endsOperand) : !last.endsOperand || lineBreak && last.postfix || last.kind === 'markup' && adjacentMarkup(i)))
        {
            const generic = source[i + 1] === '>' ? -1 : readGeneric?.(i) ?? -1;
            if (generic !== -1)
            {
                next = generic;
                text = '>';
            }
            else
            {
                const end = readMarkup(i);
                if (end !== -1)
                {
                    next = end;
                    kind = 'markup';
                }
            }
        }
        else if (token === ts.SyntaxKind.Identifier || (token >= ts.SyntaxKind.FirstKeyword && token <= ts.SyntaxKind.LastKeyword))
        {
            kind = 'identifier';
            text = source.slice(i, next);
            member = last.prevChar === '.' && !last.spread;
            const ofOperator = text === 'of' && frame?.forHead === true && last.endsOperand
                && last.prevWord !== 'let' && last.prevWord !== 'const' && last.prevWord !== 'var';
            endsOperand = member || (!PREFIX.has(text) && !ofOperator);
        }
        else if (token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.NumericLiteral
            || token === ts.SyntaxKind.BigIntLiteral || token === ts.SyntaxKind.PrivateIdentifier)
        {
            kind = 'literal';
        }
        else if (ch === '(' || ch === '[' || ch === '{')
        {
            kind = 'open';
            const head = ch === '(' && !last.member && (HEADS.has(last.prevWord) || forAwait);
            const object = ch === '{' && !labelColon && !last.headClosed && !last.endsOperand && compound !== '=>'
                && (last !== initial || expression) && last.prevChar !== ';' && last.prevChar !== '}'
                && !BLOCK_WORDS.has(last.prevWord) && !(last.text === '{' && !frame?.closeOperand);
            if (object && last === initial)
            {
                // A bare object in an expression hole is an operand. Give TypeScript the
                // same entry grammar when it resolves a following slash or comparison.
                prefix = '(';
            }
            frames.push({ anchor, firstMarkup, prefix, markupCount: markup.length, mayBeLabel: ch === '{' && last.text === ':',
                declaration, head, forHead: head && (last.prevWord === 'for' || forAwait), closeOperand: ch === '{' ? object : !head });
            declaration = null;
        }
        else if (ch === ')' || ch === ']' || ch === '}')
        {
            kind = 'close';
            frames.pop();
            anchor = frame?.anchor ?? anchor;
            firstMarkup = frame?.firstMarkup ?? firstMarkup;
            prefix = frame?.prefix ?? prefix;
            declaration = frame?.declaration ?? null;
            endsOperand = frame?.closeOperand ?? ch !== '}';
            headClosed = frame?.head === true;
            if (endsOperand && frame && markup.length > frame.markupCount && !frame.mayBeLabel)
            {
                afterOperand(next);
            }
        }
        if (kind === 'punct' && !(ch === '<' && text === '>'))
        {
            if (!continuation)
            {
                compoundEnd = next;
                compound = source.slice(i, next);
                // The same closing brace can finish a labeled block, a class declaration,
                // or an expression. Resolve the actual unary token before choosing the
                // lexical goal for its operand, including a following regex.
                const ambiguousUpdate = last.text === '}' && (compound === '!' || compound === '++' || compound === '--');
                postfixUpdate = !lineBreak && (ambiguousUpdate ? !consult(i, !last.endsOperand) : last.endsOperand);
            }
            next = i + 1;
            spread = compound === '...' && next === compoundEnd;
            postfix = (compound === '++' || compound === '--') && next === compoundEnd && postfixUpdate
                || compound === '!' && postfixUpdate;
            endsOperand = postfix;
        }
        else if (kind !== 'punct')
        {
            compoundEnd = -1;
            compound = '';
        }
        const atStatement = last === initial ? !expression : last.text === ';' || last.headClosed || labelColon
            || last.text === '{' && !frame?.closeOperand || last.text === '}' && !last.endsOperand;
        labelColon = text === ':' && labelName;
        labelName = kind === 'identifier' && atStatement;
        forAwait = kind === 'identifier' && text === 'await' && last.prevWord === 'for' && !last.member;
        if (kind === 'literal' || kind === 'markup')
        {
            endsOperand = true;
            text = '';
        }
        if (kind === 'identifier' && !member && last.prevWord !== 'as' && ASI_STATEMENTS.has(text))
        {
            anchor = i;
            firstMarkup = markup.length;
            prefix = '';
            declaration = text === 'let' || text === 'const' || text === 'var' ? 'variable' : 'statement';
        }
        else if (compound === '=' && declaration === 'variable')
        {
            declaration = 'initializer';
        }
        else if (text === ',' && declaration === 'initializer')
        {
            declaration = 'variable';
        }
        else if (kind === 'markup')
        {
            markup.push(i, next);
            afterOperand(next);
        }
        else if (text === ';')
        {
            anchor = next;
            firstMarkup = markup.length;
            prefix = '';
            declaration = null;
        }
        const prevChar = kind === 'literal' && (token === ts.SyntaxKind.NumericLiteral || token === ts.SyntaxKind.BigIntLiteral)
            ? '0' : kind === 'markup' ? '>' : kind === 'identifier' ? source[next - 1] as string : text || ch;
        last = { kind, text, next, prevChar, prevWord: kind === 'identifier' ? text : '', endsOperand, member, postfix, spread, headClosed };
        lineBreak = false;
        return last;
    };
}
