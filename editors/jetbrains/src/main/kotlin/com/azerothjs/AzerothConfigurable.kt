package com.azerothjs

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel

/**
 * The AzerothJS settings page (Settings > Languages & Frameworks > AzerothJS).
 * Toggles are persisted in [AzerothSettings] and sent to the language server on
 * its next start, so changes take effect after restarting the LSP server (the
 * status widget) or the IDE.
 */
class AzerothConfigurable : BoundConfigurable("AzerothJS")
{
    private val s = AzerothSettings.instance.data

    override fun createPanel(): DialogPanel = panel
    {
        group("Language server")
        {
            row("Node.js path:")
            {
                textFieldWithBrowseButton(
                    FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor()
                        .withTitle("Select Node.js Executable"),
                )
                    .bindText(s::nodePath)
                    .columns(40)
                    .comment("Leave blank to auto-detect from PATH and common version managers (nvm, fnm, volta, Homebrew). Restart the language server after changing.")
            }
        }
        group("Suggestions")
        {
            row { checkBox("Auto-import suggestions").bindSelected(s::autoImports) }
            row { checkBox("Built-in component snippets").bindSelected(s::componentSnippets) }
        }
        group("Inlay hints")
        {
            row { checkBox("Enable inlay hints").bindSelected(s::inlayHints) }
            row { checkBox("Parameter-name hints").bindSelected(s::parameterNameHints) }
            row { checkBox("Parameter-type hints").bindSelected(s::parameterTypeHints) }
            row { checkBox("Variable-type hints").bindSelected(s::variableTypeHints) }
            row { checkBox("Property-declaration-type hints").bindSelected(s::propertyDeclarationTypeHints) }
            row { checkBox("Function return-type hints").bindSelected(s::functionLikeReturnTypeHints) }
            row { checkBox("Enum-member-value hints").bindSelected(s::enumMemberValueHints) }
        }
        group("Intelligence")
        {
            row { checkBox("Completion").bindSelected(s::completion) }
            row { checkBox("Hover").bindSelected(s::hover) }
            row { checkBox("Signature help").bindSelected(s::signatureHelp) }
            row { checkBox("Code actions").bindSelected(s::codeActions) }
            row { checkBox("Semantic tokens").bindSelected(s::semanticTokens) }
            row { checkBox("Code lens").bindSelected(s::codeLens) }
        }
        group("Navigation")
        {
            row { checkBox("Go to definition").bindSelected(s::definition) }
            row { checkBox("Go to type definition").bindSelected(s::typeDefinition) }
            row { checkBox("Find references").bindSelected(s::references) }
            row { checkBox("Document highlight").bindSelected(s::documentHighlight) }
            row { checkBox("Call hierarchy").bindSelected(s::callHierarchy) }
            row { checkBox("Document links").bindSelected(s::documentLinks) }
        }
        group("Editing")
        {
            row { checkBox("Folding ranges").bindSelected(s::folding) }
            row { checkBox("Selection ranges").bindSelected(s::selectionRange) }
            row { checkBox("On-type formatting").bindSelected(s::onTypeFormatting) }
            row { checkBox("Linked editing").bindSelected(s::linkedEditing) }
            row { checkBox("Auto-close tags").bindSelected(s::autoClosingTags) }
            row { checkBox("Color swatches").bindSelected(s::documentColor) }
        }
        group("Refactoring")
        {
            row { checkBox("Rename").bindSelected(s::rename) }
        }
        group("Symbols")
        {
            row { checkBox("Document symbols").bindSelected(s::documentSymbol) }
            row { checkBox("Workspace symbols").bindSelected(s::workspaceSymbol) }
        }
        group("Diagnostics & formatting")
        {
            row { checkBox("Report diagnostics").bindSelected(s::diagnostics) }
            row { checkBox("Enable formatting").bindSelected(s::format) }
        }
    }
}
