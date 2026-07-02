package com.azerothjs

import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as Colors
import com.intellij.openapi.editor.XmlHighlighterColors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.platform.lsp.api.customization.LspSemanticTokensSupport
import com.intellij.psi.PsiFile
import com.intellij.ui.JBColor
import java.awt.Font

/**
 * Maps the AzerothJS language server's semantic-token legend to editor colors.
 *
 * The server emits markup-specific token types - `component`, `tag`,
 * `attribute`, `event`, `delimiter` - that are NOT part of the standard LSP
 * semantic-token set. JetBrains' default support only colors the standard types,
 * so these came back unmapped and rendered with no colour at all (the reported
 * bug). We map them here to dedicated, themeable keys (with sensible markup-
 * colour fallbacks) and delegate every standard type (class, function, variable,
 * property, ...) to the platform default so plain TypeScript still colours
 * normally.
 */
class AzerothSemanticTokens : LspSemanticTokensSupport()
{
    /**
     * Request semantic tokens for `.azeroth` files. The platform default only
     * asks for plain-text and TextMate files, so a custom-language file like
     * ours would never get semantic highlighting - which is exactly why
     * components, tags, attributes, and events showed up with no colour even
     * though the server emits the tokens. Returning true here turns the request
     * back on; everything else (the colour mapping below) then takes effect.
     */
    override fun shouldAskServerForSemanticTokens(psiFile: PsiFile): Boolean = true

    override fun getTextAttributesKey(tokenType: String, modifiers: List<String>): TextAttributesKey? =
        when
        {
            // The name declared by a reactive keyword (`state count`, `form login`, ...): a
            // dedicated key so a component's reactive surface reads distinctly from plain
            // variables, mirroring the VS Code mapping of `variable.reactive`.
            "reactive" in modifiers -> REACTIVE
            else -> SEMANTIC_KEYS[tokenType] ?: super.getTextAttributesKey(tokenType, modifiers)
        }

    /**
     * Advertise our markup token types alongside the standard set, so the client
     * capability lists them and the server's tokens are never dropped by a
     * legend intersection before they reach [getTextAttributesKey]. `variable` is
     * already a standard type, so it's filtered out here to avoid a duplicate.
     */
    override val tokenTypes: List<String> =
        super.tokenTypes + SEMANTIC_KEYS.keys.filterNot { it in super.tokenTypes }

    companion object
    {
        private fun key(name: String, fallback: TextAttributesKey): TextAttributesKey =
            TextAttributesKey.createTextAttributesKey("AZEROTH_SEM_$name", fallback)

        /** A user component tag (`<Counter>`), coloured like a class. */
        val COMPONENT: TextAttributesKey = key("COMPONENT", Colors.CLASS_NAME)

        /** A host element tag name (`div` in `<div>`); coloured like an HTML tag. */
        val TAG: TextAttributesKey = key("TAG", XmlHighlighterColors.HTML_TAG_NAME)

        /** An attribute name (`class`, `value`); coloured like an HTML attribute. */
        val ATTRIBUTE: TextAttributesKey = key("ATTRIBUTE", XmlHighlighterColors.HTML_ATTRIBUTE_NAME)

        /** An event handler attribute (`onClick`). */
        val EVENT: TextAttributesKey = key("EVENT", Colors.METADATA)

        /** Tag punctuation (`<`, `>`, `/`). */
        val DELIMITER: TextAttributesKey = key("DELIMITER", XmlHighlighterColors.HTML_TAG_NAME)

        /**
         * A variable / identifier reference: locals (`const shareUrl`), globals
         * (`window`, `navigator`), and import binding names (`ShareModal`,
         * `createSignal`). WebStorm's default scheme paints these in the plain
         * editor foreground - identical to how it shows `.ts` - so they read as
         * uncoloured. We give `.azeroth` an explicit VS Code-style variable colour
         * (navy on light themes, light-blue on dark) so they stand out like the
         * rest of the syntax. It's the fallback default only: themeable via the
         * colour settings page, and the standard `variable` type still falls back
         * here so locals and imports colour consistently.
         */
        val VARIABLE: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "AZEROTH_SEM_VARIABLE",
            TextAttributes(JBColor(0x001080, 0x9CDCFE), null, null, null, Font.PLAIN)
        )

        /**
         * The name declared by a reactive keyword (`state count`, `derived total`, `form login`).
         * Bold constant-like colouring (teal on light, aqua on dark - the classic "constant"
         * palette) so the reactive surface of a component is scannable at a glance. Themeable via
         * the colour settings page.
         */
        val REACTIVE: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "AZEROTH_SEM_REACTIVE",
            TextAttributes(JBColor(0x0070C1, 0x4FC1FF), null, null, null, Font.BOLD)
        )

        /** Server token-type name -> our key. Other standard types fall through to super. */
        private val SEMANTIC_KEYS: Map<String, TextAttributesKey> = mapOf(
            "component" to COMPONENT,
            "tag" to TAG,
            "attribute" to ATTRIBUTE,
            "event" to EVENT,
            "delimiter" to DELIMITER,
            "variable" to VARIABLE,
        )
    }
}
