package com.azerothjs

import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.panel

/**
 * The AzerothJS settings page (Settings → Languages & Frameworks → AzerothJS).
 * Toggles are persisted in [AzerothSettings] and sent to the language server on
 * its next start, so changes take effect after restarting the LSP server (the
 * status widget) or the IDE.
 */
class AzerothConfigurable : BoundConfigurable("AzerothJS") {
    private val s = AzerothSettings.instance.data

    override fun createPanel(): DialogPanel = panel {
        group("Suggestions") {
            row { checkBox("Auto-import suggestions").bindSelected(s::autoImports) }
            row { checkBox("Built-in component snippets").bindSelected(s::componentSnippets) }
        }
        group("Inlay hints") {
            row { checkBox("Enable inlay hints").bindSelected(s::inlayHints) }
            row { checkBox("Parameter-name hints").bindSelected(s::parameterNameHints) }
        }
        group("Diagnostics & formatting") {
            row { checkBox("Report diagnostics").bindSelected(s::diagnostics) }
            row { checkBox("Enable formatting").bindSelected(s::format) }
        }
    }
}
