package com.azerothjs

import com.intellij.codeInsight.completion.CompletionParameters
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import com.intellij.platform.lsp.api.customization.LspCompletionSupport
import kotlin.io.path.exists

/**
 * Starts the AzerothJS language server for `.azeroth` files. The platform LSP
 * API (2023.2+) drives completion, hover, diagnostics, navigation, etc.
 */
class AzerothLspServerSupportProvider : LspServerSupportProvider {
    override fun fileOpened(
        project: Project,
        file: VirtualFile,
        serverStarter: LspServerSupportProvider.LspServerStarter,
    ) {
        if (file.extension == "azeroth") {
            serverStarter.ensureServerStarted(AzerothLspServerDescriptor(project))
        }
    }
}

private class AzerothLspServerDescriptor(project: Project) :
    ProjectWideLspServerDescriptor(project, "AzerothJS") {

    override fun isSupportedFile(file: VirtualFile) = file.extension == "azeroth"

    override fun createCommandLine(): GeneralCommandLine {
        return GeneralCommandLine("node", locateServer(), "--stdio")
    }

    /** Forwards the user's AzerothJS settings to the server (it has no
     *  `workspace/configuration` channel from the JetBrains client). */
    override fun createInitializationOptions(): Any = AzerothSettings.instance.toInitializationOptions()

    /**
     * Markup-aware completion prefix. JetBrains' default prefix stops at word
     * boundaries, so a hyphenated/colon attribute (`aria-label`, `data-`,
     * `xml:lang`) or a tag fragment would be matched against the wrong prefix
     * and the server's HTML items dropped. Extend the prefix over `-`, `:`,
     * `_`, `$` so those items match.
     */
    override val lspCompletionSupport: LspCompletionSupport = object : LspCompletionSupport() {
        override fun getCompletionPrefix(parameters: CompletionParameters, default: String): String {
            val text = parameters.editor.document.charsSequence
            var start = parameters.offset
            while (start > 0) {
                val c = text[start - 1]
                if (c.isLetterOrDigit() || c == '-' || c == ':' || c == '_' || c == '$') start-- else break
            }
            return text.subSequence(start, parameters.offset).toString()
        }
    }

    /**
     * Locates the AzerothJS language server bundled inside this plugin
     * (`<plugin>/server/server.js`, with its TypeScript copy beside it). Falls
     * back to a globally-installed `azeroth-language-server` on PATH.
     */
    private fun locateServer(): String {
        val pluginPath = PluginManagerCore.getPlugin(PluginId.getId("com.azerothjs.azeroth"))?.pluginPath
        val bundled = pluginPath?.resolve("server")?.resolve("server.js")
        if (bundled != null && bundled.exists()) {
            return bundled.toString()
        }
        return "azeroth-language-server"
    }
}
