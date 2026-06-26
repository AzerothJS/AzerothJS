package com.azerothjs

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import com.intellij.platform.lsp.api.customization.LspCustomization
import com.intellij.platform.lsp.api.customization.LspSemanticTokensCustomizer
import org.eclipse.lsp4j.ConfigurationItem
import kotlin.io.path.exists

private const val PLUGIN_ID = "com.azerothjs.azeroth"
private const val EXTENSION = "azeroth"

/**
 * Starts the AzerothJS language server for `.azeroth` files. The platform LSP
 * API drives completion, hover, diagnostics, navigation, rename, signature help,
 * semantic highlighting, formatting, folding, inlay hints, color, and code
 * actions - all from the same bundled `server.js` VS Code runs, so the two
 * editors stay at feature parity.
 */
class AzerothLspServerSupportProvider : LspServerSupportProvider
{
    override fun fileOpened(
        project: Project,
        file: VirtualFile,
        serverStarter: LspServerSupportProvider.LspServerStarter,
    )
    {
        if (file.extension == EXTENSION)
        {
            serverStarter.ensureServerStarted(AzerothLspServerDescriptor(project))
        }
    }
}

/**
 * The project-wide descriptor. Inheriting [ProjectWideLspServerDescriptor] turns
 * on the platform's default feature set (completion, hover, diagnostics,
 * go-to-definition/type-definition, references, rename, semantic tokens, code
 * actions, formatting, folding, ...) for any server that advertises them, which
 * ours does - so the descriptor's real responsibilities are: launch Node
 * reliably, forward settings, and answer the server's `workspace/configuration`
 * requests for live config updates.
 */
private class AzerothLspServerDescriptor(project: Project) : ProjectWideLspServerDescriptor(project, "AzerothJS") {

    override fun isSupportedFile(file: VirtualFile): Boolean = file.extension == EXTENSION

    /**
     * Customizes the platform's LSP feature set. The defaults already enable
     * completion/hover/diagnostics/navigation/etc., so the only change is the
     * semantic-token colour mapping: the server's markup token types
     * (component, tag, attribute, event, delimiter) aren't standard LSP types
     * and would otherwise render with no colour.
     */
    override val lspCustomization: LspCustomization = object : LspCustomization()
    {
        override val semanticTokensCustomizer: LspSemanticTokensCustomizer = AzerothSemanticTokens()
    }

    /**
     * Builds the launch command, resolving Node and the bundled server robustly.
     * On failure it notifies the user (with a link to the settings) and throws so
     * the platform records the cause in the LSP console rather than failing mute.
     */
    override fun createCommandLine(): GeneralCommandLine
    {
        val server = locateServer()
        if (server == null)
        {
            AzerothNotifier.serverMissing(project, "Reinstall the AzerothJS plugin so its bundled server is present.")
            throw ExecutionException("AzerothJS language server (server.js) not found in the plugin or on PATH.")
        }

        val node = NodeLocator.locate(AzerothSettings.instance.data.nodePath)
        if (node == null)
        {
            AzerothNotifier.nodeNotFound(project)
            throw ExecutionException("Node.js executable not found. Set it in Settings > Languages & Frameworks > AzerothJS.")
        }

        AzerothNotifier.log.info("Starting AzerothJS language server: $node $server --stdio")
        return GeneralCommandLine(node, server, "--stdio").apply {
            // Resolve `require('typescript')` against the server's bundled copy.
            withWorkDirectory(java.io.File(server).parent)
            withCharset(Charsets.UTF_8)
        }
    }

    /** Initial settings, forwarded as initializationOptions (no config channel at startup). */
    override fun createInitializationOptions(): Any = AzerothSettings.instance.toInitializationOptions()

    /**
     * Answers the server's `workspace/configuration` requests so settings changes
     * apply without a full restart: every section resolves to the same
     * `azeroth.*` tree the init options carry. The server reads `azeroth.<x>` from
     * the returned map, so an unsectioned request gets the whole tree.
     */
    override fun getWorkspaceConfiguration(item: ConfigurationItem): Any?
    {
        val options = AzerothSettings.instance.toInitializationOptions()
        val section = item.section?.removePrefix("azeroth.")?.removePrefix("azeroth")?.trim('.')
        return if (section.isNullOrEmpty()) options else options[section] ?: options
    }

    /**
     * The bundled server (`<plugin>/server/server.js`, with its TypeScript copy
     * beside it), falling back to a globally-installed `azeroth-language-server`.
     * Returns null when neither is present.
     */
    private fun locateServer(): String?
    {
        val pluginPath = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.pluginPath
        val bundled = pluginPath?.resolve("server")?.resolve("server.js")
        if (bundled != null && bundled.exists())
        {
            return bundled.toString()
        }
        // PATH fallback: a globally-installed CLI shim.
        return com.intellij.execution.configurations.PathEnvironmentVariableUtil
            .findInPath(if (com.intellij.openapi.util.SystemInfo.isWindows) "azeroth-language-server.cmd" else "azeroth-language-server")
            ?.absolutePath
    }
}
