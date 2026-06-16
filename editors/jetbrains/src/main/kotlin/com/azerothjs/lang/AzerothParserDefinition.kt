package com.azerothjs.lang

import com.intellij.extapi.psi.ASTWrapperPsiElement
import com.intellij.extapi.psi.PsiFileBase
import com.intellij.lang.ASTNode
import com.intellij.lang.ParserDefinition
import com.intellij.lang.PsiBuilder
import com.intellij.lang.PsiParser
import com.intellij.lexer.Lexer
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.project.Project
import com.intellij.psi.FileViewProvider
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType
import com.intellij.psi.tree.IFileElementType
import com.intellij.psi.tree.TokenSet

/** Marks the file's root node. */
val AZEROTH_FILE: IFileElementType = IFileElementType(AzerothLanguage)

/**
 * A deliberately flat parser: it wraps the lexer's token stream under a single
 * root node. Bracket matching, brace-aware editing, and syntax highlighting all
 * run off the lexer tokens, not a syntax tree, so there is no need to build one
 * here (and no need to re-implement TypeScript's grammar). The LSP server owns
 * the actual structural intelligence.
 */
class AzerothParserDefinition : ParserDefinition
{
    override fun createLexer(project: Project?): Lexer = AzerothLexer()

    override fun createParser(project: Project?): PsiParser = object : PsiParser
    {
        override fun parse(root: IElementType, builder: PsiBuilder): ASTNode
        {
            val mark = builder.mark()
            while (!builder.eof())
            {
                builder.advanceLexer()
            }
            mark.done(root)
            return builder.treeBuilt
        }
    }

    override fun getFileNodeType(): IFileElementType = AZEROTH_FILE
    override fun getCommentTokens(): TokenSet = COMMENTS
    override fun getStringLiteralElements(): TokenSet = STRINGS
    override fun getWhitespaceTokens(): TokenSet = WHITESPACE
    override fun createElement(node: ASTNode): PsiElement = ASTWrapperPsiElement(node)
    override fun createFile(viewProvider: FileViewProvider): PsiFile = AzerothPsiFile(viewProvider)

    companion object
    {
        private val COMMENTS = TokenSet.create(AzerothTypes.LINE_COMMENT, AzerothTypes.BLOCK_COMMENT)
        private val STRINGS = TokenSet.create(AzerothTypes.STRING)
        private val WHITESPACE = TokenSet.create(TokenType.WHITE_SPACE)
    }
}

class AzerothPsiFile(viewProvider: FileViewProvider) : PsiFileBase(viewProvider, AzerothLanguage)
{
    override fun getFileType(): FileType = AzerothFileType
    override fun toString(): String = "AzerothJS File"
}
