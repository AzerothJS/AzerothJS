package com.azerothjs.lang

import com.azerothjs.AzerothSemanticTokens
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighter
import com.intellij.openapi.options.colors.AttributesDescriptor
import com.intellij.openapi.options.colors.ColorDescriptor
import com.intellij.openapi.options.colors.ColorSettingsPage
import javax.swing.Icon

/**
 * Exposes the native lexer's highlight categories in
 * Settings > Editor > Color Scheme > AzerothJS, so users can recolour the base
 * layer. The LSP server's semantic tokens refine this on top at runtime.
 */
class AzerothColorSettingsPage : ColorSettingsPage
{
    override fun getDisplayName(): String = "AzerothJS"

    override fun getIcon(): Icon? = null

    override fun getHighlighter(): SyntaxHighlighter = AzerothSyntaxHighlighter()

    override fun getAttributeDescriptors(): Array<AttributesDescriptor> = DESCRIPTORS

    override fun getColorDescriptors(): Array<ColorDescriptor> = ColorDescriptor.EMPTY_ARRAY

    override fun getAdditionalHighlightingTagToDescriptorMap(): Map<String, TextAttributesKey>? = null

    override fun getDemoText(): String = """
        import { createSignal } from '@azerothjs/core';

        // A counter component
        export default function Counter(props: { start: number })
        {
            const [count, setCount] = createSignal(props.start);
            return (
                <button class="counter" onClick={() => setCount(count() + 1)}>
                    Count: {count()}
                </button>
            );
        }
    """.trimIndent()

    private companion object
    {
        private fun key(name: String): TextAttributesKey = TextAttributesKey.createTextAttributesKey("AZEROTH_$name")

        val DESCRIPTORS = arrayOf(
            AttributesDescriptor("Keyword", key("KEYWORD")),
            AttributesDescriptor("Identifier", key("IDENTIFIER")),
            AttributesDescriptor("String", key("STRING")),
            AttributesDescriptor("Number", key("NUMBER")),
            AttributesDescriptor("Line comment", key("LINE_COMMENT")),
            AttributesDescriptor("Block comment", key("BLOCK_COMMENT")),
            AttributesDescriptor("Braces", key("BRACES")),
            AttributesDescriptor("Parentheses", key("PARENS")),
            AttributesDescriptor("Brackets", key("BRACKETS")),
            AttributesDescriptor("Tag delimiter", key("TAG")),
            AttributesDescriptor("Operator", key("OPERATOR")),
            // Semantic (LSP) markup colours, refined on top of the lexer layer.
            AttributesDescriptor("Markup//Component tag", AzerothSemanticTokens.COMPONENT),
            AttributesDescriptor("Markup//Host element tag", AzerothSemanticTokens.TAG),
            AttributesDescriptor("Markup//Attribute name", AzerothSemanticTokens.ATTRIBUTE),
            AttributesDescriptor("Markup//Event handler", AzerothSemanticTokens.EVENT),
            AttributesDescriptor("Markup//Tag punctuation", AzerothSemanticTokens.DELIMITER),
            AttributesDescriptor("Variable, global & import binding", AzerothSemanticTokens.VARIABLE),
            AttributesDescriptor("Reactive declaration name", AzerothSemanticTokens.REACTIVE),
        )
    }
}
