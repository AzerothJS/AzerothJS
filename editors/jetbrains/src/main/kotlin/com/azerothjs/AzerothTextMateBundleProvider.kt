package com.azerothjs

import com.intellij.openapi.application.PathManager
import org.jetbrains.plugins.textmate.api.TextMateBundleProvider
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * Contributes a TextMate bundle so JetBrains' TextMate engine colours `.azeroth`
 * files exactly like `.tsx` (the AzerothJS grammar embeds `source.tsx`, and the
 * real TypeScript/React grammars are bundled so the include resolves). This
 * gives full HTML/JSX/TS highlighting without running a TypeScript parser that
 * would mis-report AzerothJS-specific constructs — the LSP server provides the
 * accurate intelligence.
 *
 * The grammar files ship inside the plugin jar; they are extracted once to the
 * IDE system directory because a bundle must be a real filesystem path.
 */
class AzerothTextMateBundleProvider : TextMateBundleProvider {
    override fun getBundles(): List<TextMateBundleProvider.PluginBundle> {
        val dir = extractBundle() ?: return emptyList()
        return listOf(TextMateBundleProvider.PluginBundle("AzerothJS", dir))
    }

    private fun extractBundle(): Path? {
        val target = Path.of(PathManager.getSystemPath(), "azeroth", "textmate")
        Files.createDirectories(target)
        val files = listOf(
            "package.json",
            "language-configuration.json",
            "azeroth.tmLanguage.json",
            "TypeScriptReact.tmLanguage.json",
            "TypeScript.tmLanguage.json",
        )
        for (name in files) {
            val stream = javaClass.getResourceAsStream("/textmate/$name") ?: return null
            stream.use { Files.copy(it, target.resolve(name), StandardCopyOption.REPLACE_EXISTING) }
        }
        return target
    }
}
