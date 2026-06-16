package com.azerothjs.lang

import com.intellij.lang.BracePair
import com.intellij.lang.PairedBraceMatcher
import com.intellij.psi.PsiFile
import com.intellij.psi.tree.IElementType

/**
 * Pairs the three real bracket kinds. Because the lexer already emits braces
 * inside strings, comments, and template interpolations as part of those tokens
 * (never as LBRACE/RBRACE), the matcher only ever sees code brackets - so a
 * closing `}` highlights its true opener instead of leaking onto an outer block,
 * which was the JetBrains TextMate behaviour we are replacing.
 */
class AzerothBraceMatcher : PairedBraceMatcher
{
    override fun getPairs(): Array<BracePair> = PAIRS

    override fun isPairedBracesAllowedBeforeType(lbraceType: IElementType, contextType: IElementType?): Boolean = true

    override fun getCodeConstructStart(file: PsiFile?, openingBraceOffset: Int): Int = openingBraceOffset

    companion object
    {
        private val PAIRS = arrayOf(
            BracePair(AzerothTypes.LBRACE, AzerothTypes.RBRACE, true),
            BracePair(AzerothTypes.LPAREN, AzerothTypes.RPAREN, false),
            BracePair(AzerothTypes.LBRACKET, AzerothTypes.RBRACKET, false)
        )
    }
}
