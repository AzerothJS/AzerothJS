// @vitest-environment node
//
// Real-execution coverage for ts-slice: expression/statement/declaration slice
// parsing with the slice->source position mapper, the equal-length keyword
// substitution that preserves offsets, and error tolerance (never throws).
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import {
    parseExpressionSlice,
    parseStatementsSlice,
    parseDeclarationSlice
} from '../src/ts-slice.ts';
import { parseModule } from '@azerothjs/compiler';
import type { ComponentDecl, StateDecl, DerivedDecl } from '@azerothjs/compiler';

describe('parseExpressionSlice', () =>
{
    it('wraps the code in parens so a leading brace reads as an object literal', () =>
    {
        const { sourceFile } = parseExpressionSlice('{ a: 1 }', 0);
        expect(sourceFile.text).toBe('({ a: 1 })');
        const stmt = sourceFile.statements[0]!;
        expect(ts.isExpressionStatement(stmt)).toBe(true);
        const expr = (stmt as ts.ExpressionStatement).expression;
        const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
        expect(ts.isObjectLiteralExpression(inner)).toBe(true);
    });

    it('mapPos translates a slice index back to the source offset (accounts for the "(" shift)', () =>
    {
        const { mapPos } = parseExpressionSlice('count + 1', 10);
        // Slice index 1 ('c' of count) maps to source offset 10.
        expect(mapPos(1)).toBe(10);
        expect(mapPos(0)).toBe(9);
    });

    it('is error-tolerant on malformed expressions (never throws)', () =>
    {
        expect(() => parseExpressionSlice('a + + + )(', 0)).not.toThrow();
    });
});

describe('parseStatementsSlice', () =>
{
    it('parses a statement list verbatim with an identity-shifted mapPos', () =>
    {
        const { sourceFile, mapPos } = parseStatementsSlice('log(n);', 5);
        expect(sourceFile.text).toBe('log(n);');
        expect(mapPos(0)).toBe(5);
        expect(mapPos(3)).toBe(8);
        expect(sourceFile.statements).toHaveLength(1);
    });

    it('parses multiple statements', () =>
    {
        const { sourceFile } = parseStatementsSlice('const a = 1; b();', 0);
        expect(sourceFile.statements).toHaveLength(2);
    });
});

describe('parseDeclarationSlice', () =>
{
    function declOf(src: string): { source: string; decl: StateDecl | DerivedDecl }
    {
        const c = parseModule(src).items.find(i => i.kind === 'component') as ComponentDecl;
        const decl = c.body.find(b => b.kind === 'state' || b.kind === 'derived') as StateDecl | DerivedDecl;
        return { source: src, decl };
    }

    it('parses a state declaration: name + initializer, with offsets preserved', () =>
    {
        const { source, decl } = declOf('component C { state count = 1 + 2; <p>{count}</p> }');
        const parsed = parseDeclarationSlice(source, decl);
        expect(parsed).not.toBeNull();
        expect(parsed!.name).toBe('count');
        expect(parsed!.initializer).toBeDefined();
        expect(parsed!.initializer!.getText(parsed!.sourceFile)).toBe('1 + 2');
        // The equal-length `state`->`let  ` substitution keeps the initializer's
        // source slice byte-aligned with the original.
        const start = parsed!.mapPos(parsed!.initializer!.getStart(parsed!.sourceFile));
        const end = parsed!.mapPos(parsed!.initializer!.getEnd());
        expect(source.slice(start, end)).toBe('1 + 2');
    });

    it('captures a type annotation when present', () =>
    {
        const { source, decl } = declOf('component C { state n: number = 0; <p>{n}</p> }');
        const parsed = parseDeclarationSlice(source, decl);
        expect(parsed!.type).toBeDefined();
        expect(parsed!.type!.getText(parsed!.sourceFile)).toBe('number');
    });

    it('parses a derived declaration via the `const  ` substitution', () =>
    {
        const { source, decl } = declOf('component C { derived d = 2 * 3; <p>{d}</p> }');
        const parsed = parseDeclarationSlice(source, decl);
        expect(parsed!.name).toBe('d');
        expect(parsed!.initializer!.getText(parsed!.sourceFile)).toBe('2 * 3');
    });
});
