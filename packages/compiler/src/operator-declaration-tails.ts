/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as ts from 'typescript';
import type { AzerothDiagnostic } from './diagnostics.ts';
import { DECLARATION_KEYWORDS, SOURCE_KINDS } from './keyword-spec.ts';
import { visitStatementListExpressions } from './lower-reactive.ts';
import { declaredName, skipTrivia } from './parser.ts';

const SOURCE_WORDS: ReadonlySet<string> = SOURCE_KINDS;
// A comment may separate either word. The parsed statement establishes actual ownership.
const POSSIBLE_PAIR = new RegExp(`\\b(?:${ [...DECLARATION_KEYWORDS].join('|') })\\b\\s*(?:as\\b|satisfies\\b|/[/\\*])`);
const OPERATOR_NAME = /^(?:as|satisfies)\b/;

/** First parser error at or after a source offset. One sorted index serves the entire region. */
function nextError(errors: readonly number[], at: number): number
{
    let lo = 0;
    let hi = errors.length;
    while (lo < hi)
    {
        const mid = lo + Math.floor((hi - lo) / 2);
        if ((errors[mid] as number) < at)
        {
            lo = mid + 1;
        }
        else
        {
            hi = mid;
        }
    }
    return errors[lo] ?? Infinity;
}

/** A computed member name holds an expression, which can itself contain framework statements. */
function computedNameEnd(node: ts.Node, position: number): number | undefined
{
    if (position < node.pos || position >= node.end)
    {
        return undefined;
    }
    return ts.isComputedPropertyName(node) ? node.end : ts.forEachChild(node, child => computedNameEnd(child, position));
}

/** Locate malformed operator-name declarations left opaque by the parser's valid-declaration gate. */
export function diagnoseOperatorDeclarationTails(
    code: string, base: number, expression: boolean, out: AzerothDiagnostic[], componentBody = false
): void
{
    if (!POSSIBLE_PAIR.test(code) || !/\b(?:as|satisfies)\b/.test(code))
    {
        return;
    }
    let errors: number[] | undefined;
    const findings: AzerothDiagnostic[] = [];
    visitStatementListExpressions(code, expression, (statement, owner, { sourceFile, mapPos }, index) =>
    {
        const word = statement.getFirstToken(sourceFile);
        if (word === undefined || !ts.isIdentifier(word))
        {
            return;
        }
        const keyword = word.getText(sourceFile);
        const allowed = componentBody && ts.isSourceFile(owner) ? DECLARATION_KEYWORDS : SOURCE_WORDS;
        if (!allowed.has(keyword))
        {
            return;
        }
        const wordEnd = mapPos(word.end);
        const nameAt = skipTrivia(code, wordEnd);
        const name = OPERATOR_NAME.exec(code.slice(nameAt, nameAt + 'satisfies'.length + 1))?.[0];
        if (!name || declaredName(code, wordEnd, code.length, keyword === 'form') !== null)
        {
            return;
        }
        const tail = skipTrivia(code, nameAt + name.length);
        if (tail >= code.length)
        {
            return;
        }
        if (errors === undefined)
        {
            const parsed = sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] };
            errors = (parsed.parseDiagnostics ?? []).map(d => mapPos(d.start)).sort((a, b) => a - b);
        }
        let last = statement;
        let successor = owner.statements[index + 1];
        const cast = word.parent;
        if (ts.isAsExpression(cast) || ts.isSatisfiesExpression(cast))
        {
            // An error inside the operator's type, or a rejected token just after it
            // (as in `state as\nmark()`), implicates the declaration spelling. Errors
            // farther along can belong to valid framework blocks on the right of `&&`.
            // TypeScript also parses JSDoc's prefix `!T`, `?T` and `*` in TS files.
            const typeEnd = mapPos(cast.type.end);
            const afterType = skipTrivia(code, typeEnd);
            let error = nextError(errors, tail);
            while (error < typeEnd)
            {
                const computedEnd = computedNameEnd(cast.type, error - mapPos(0));
                if (computedEnd === undefined)
                {
                    break;
                }
                error = nextError(errors, mapPos(computedEnd));
            }
            const sameLineError = error === afterType && !/[\r\n\u2028\u2029]/.test(code.slice(typeEnd, afterType));
            const jsdoc = cast.type.kind === ts.SyntaxKind.JSDocAllType
                || ((ts.isJSDocNonNullableType(cast.type) || ts.isJSDocNullableType(cast.type)) && !cast.type.postfix);
            if (!jsdoc && error !== tail && error >= typeEnd && !sameLineError)
            {
                return;
            }
        }
        else
        {
            // With a newline before the name, ASI can create two separate statements.
            // Preserve that reading unless the joined access or comma list itself fails.
            if (statement.expression !== word || errors.length === 0)
            {
                return;
            }
            if (!successor || !ts.isExpressionStatement(successor) || mapPos(successor.getStart(sourceFile)) !== nameAt)
            {
                return;
            }
            last = successor;
            successor = owner.statements[index + 2];
            const after = skipTrivia(code, mapPos(last.expression.end));
            const list = ts.isBinaryExpression(last.expression) && last.expression.operatorToken.kind === ts.SyntaxKind.CommaToken;
            const join = code[tail] === '[' || code[tail] === '(' || code[tail] === ',';
            const joined = skipTrivia(code, tail + 1);
            if (!(list && code[after] === ':' && nextError(errors, after) === after)
                && !(join && nextError(errors, joined) === joined))
            {
                return;
            }
        }
        // TS can recover `as mark()` as one statement ending at `mark` and a
        // second beginning at `(`. Include that local recovery. An ASI boundary
        // at the end of this statement can precede a separate malformed declaration.
        let end = Math.min(code.length, mapPos(last.end));
        const boundary = skipTrivia(code, end);
        if (successor && code[end - 1] !== ';' && nextError(errors, boundary) === boundary
            && !/[\r\n\u2028\u2029]/.test(code.slice(end, mapPos(successor.getStart(sourceFile)))))
        {
            end = Math.min(code.length, mapPos(successor.end));
        }
        if (code[end - 1] === ';')
        {
            end--;
        }
        const text = code.slice(tail, end).trimEnd();
        const excerpt = text.length > 60 ? text.slice(0, 59) + '…' : text;
        findings.push({
            code: 'azeroth/malformed-declaration',
            severity: 'error',
            message: `\`${ keyword } ${ name }\` cannot include \`${ excerpt }\` as a declaration tail. End the declaration with \`;\` before a following statement or declare each binding separately.`,
            start: base + tail,
            end: base + tail + text.length
        });
    });
    findings.sort((a, b) => a.start - b.start);
    for (const finding of findings)
    {
        out.push(finding);
    }
}
