package com.azerothjs.lang

import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.psi.tree.IElementType
import javax.swing.Icon

/** The native AzerothJS language. `.azeroth` is a TypeScript module with
 *  AzerothJS markup; the native lexer/brace-matcher give correct in-editor
 *  bracket matching (a generic matcher mispairs around the template-literal
 *  `${ }` braces), while the LSP server still supplies the semantic
 *  intelligence on top. */
object AzerothLanguage : Language("AzerothJS")

object AzerothFileType : LanguageFileType(AzerothLanguage)
{
    override fun getName(): String = "AzerothJS"
    override fun getDescription(): String = "AzerothJS single-file component"
    override fun getDefaultExtension(): String = "azeroth"
    override fun getIcon(): Icon? = null
}

/** Token kinds the lexer emits. Brace/paren/bracket tokens are distinct so the
 *  brace matcher can pair them; strings/comments swallow any braces inside them
 *  so those never count toward matching. */
class AzerothTokenType(debugName: String) : IElementType(debugName, AzerothLanguage)

object AzerothTypes
{
    @JvmField val LINE_COMMENT = AzerothTokenType("AZEROTH_LINE_COMMENT")
    @JvmField val BLOCK_COMMENT = AzerothTokenType("AZEROTH_BLOCK_COMMENT")
    @JvmField val STRING = AzerothTokenType("AZEROTH_STRING")
    @JvmField val NUMBER = AzerothTokenType("AZEROTH_NUMBER")
    @JvmField val KEYWORD = AzerothTokenType("AZEROTH_KEYWORD")
    @JvmField val IDENTIFIER = AzerothTokenType("AZEROTH_IDENTIFIER")
    @JvmField val LBRACE = AzerothTokenType("AZEROTH_LBRACE")
    @JvmField val RBRACE = AzerothTokenType("AZEROTH_RBRACE")
    @JvmField val LPAREN = AzerothTokenType("AZEROTH_LPAREN")
    @JvmField val RPAREN = AzerothTokenType("AZEROTH_RPAREN")
    @JvmField val LBRACKET = AzerothTokenType("AZEROTH_LBRACKET")
    @JvmField val RBRACKET = AzerothTokenType("AZEROTH_RBRACKET")
    @JvmField val TAG_DELIMITER = AzerothTokenType("AZEROTH_TAG_DELIMITER")
    @JvmField val OPERATOR = AzerothTokenType("AZEROTH_OPERATOR")
    @JvmField val OTHER = AzerothTokenType("AZEROTH_OTHER")
}
