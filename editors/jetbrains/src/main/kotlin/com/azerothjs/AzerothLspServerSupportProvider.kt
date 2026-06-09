package com.azerothjs

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
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

    // Note: the platform LSP API in this IDE build (242) exposes no completion-
    // prefix customization hook (LspCompletionSupport has no getCompletionPrefix),
    // so the server's completion uses the IDE's default prefix. Hyphenated/colon
    // attributes (aria-label, data-, xml:lang) still complete via the server;
    // only the client-side prefix matching uses platform defaults.

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
