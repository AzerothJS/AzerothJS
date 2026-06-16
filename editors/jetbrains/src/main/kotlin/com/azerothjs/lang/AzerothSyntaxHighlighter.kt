package com.azerothjs.lang

import com.intellij.lexer.Lexer
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as Colors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.openapi.fileTypes.SyntaxHighlighterFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.tree.IElementType

/**
 * Base colouring off the lexer tokens (keywords, strings, comments, numbers,
 * brackets, tag delimiters). The LSP server's semantic tokens refine components,
 * host tags, and event attributes on top, so this only needs to be a solid
 * foundation - not a full TypeScript+JSX theme.
 */
class AzerothSyntaxHighlighter : SyntaxHighlighterBase()
{
    override fun getHighlightingLexer(): Lexer = AzerothLexer()

    override fun getTokenHighlights(tokenType: IElementType): Array<TextAttributesKey> = pack(MAP[tokenType])

    companion object
    {
        private fun key(name: String, fallback: TextAttributesKey): TextAttributesKey =
            TextAttributesKey.createTextAttributesKey("AZEROTH_$name", fallback)

        private val MAP: Map<IElementType, TextAttributesKey> = mapOf(
            AzerothTypes.LINE_COMMENT to key("LINE_COMMENT", Colors.LINE_COMMENT),
            AzerothTypes.BLOCK_COMMENT to key("BLOCK_COMMENT", Colors.BLOCK_COMMENT),
            AzerothTypes.STRING to key("STRING", Colors.STRING),
            AzerothTypes.NUMBER to key("NUMBER", Colors.NUMBER),
            AzerothTypes.KEYWORD to key("KEYWORD", Colors.KEYWORD),
            AzerothTypes.IDENTIFIER to key("IDENTIFIER", Colors.IDENTIFIER),
            AzerothTypes.LBRACE to key("BRACES", Colors.BRACES),
            AzerothTypes.RBRACE to key("BRACES", Colors.BRACES),
            AzerothTypes.LPAREN to key("PARENS", Colors.PARENTHESES),
            AzerothTypes.RPAREN to key("PARENS", Colors.PARENTHESES),
            AzerothTypes.LBRACKET to key("BRACKETS", Colors.BRACKETS),
            AzerothTypes.RBRACKET to key("BRACKETS", Colors.BRACKETS),
            AzerothTypes.TAG_DELIMITER to key("TAG", Colors.MARKUP_TAG),
            AzerothTypes.OPERATOR to key("OPERATOR", Colors.OPERATION_SIGN)
        )
    }
}

class AzerothSyntaxHighlighterFactory : SyntaxHighlighterFactory()
{
    override fun getSyntaxHighlighter(project: Project?, virtualFile: VirtualFile?): SyntaxHighlighter = AzerothSyntaxHighlighter()
}
