package com.azerothjs

import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.openapi.util.SystemInfo
import java.io.File

/**
 * Finds a Node.js executable to run the language server with.
 *
 * This is the single most important fix for "nothing works in JetBrains": a
 * JetBrains IDE launched from the OS launcher does NOT inherit a login shell's
 * PATH, so a bare `node` lookup fails for anyone who installed Node via a
 * version manager (nvm, fnm, volta, asdf) or Homebrew. VS Code works because it
 * inherits the integrated-terminal environment. We compensate by searching, in
 * order:
 *
 *   1. an explicit path set in the plugin settings,
 *   2. the process PATH (covers system-installer / Program Files installs),
 *   3. the well-known install locations of the common version managers.
 *
 * Returns an absolute path, or null when nothing is found (the caller then
 * notifies the user and points them at the settings field).
 */
object NodeLocator
{
    private val exe: String get() = if (SystemInfo.isWindows) "node.exe" else "node"

    /** Locates Node, or null. `override` is the user's configured path (may be blank). */
    fun locate(override: String?): String?
    {
        configured(override)?.let { return it }
        PathEnvironmentVariableUtil.findInPath(exe)?.let { if (it.canExecute() || SystemInfo.isWindows) return it.absolutePath }
        return commonLocations().firstOrNull { it.isFile }?.absolutePath
    }

    /** A user-provided path: accept a file directly, or a directory containing node. */
    private fun configured(override: String?): String?
    {
        val raw = override?.trim().orEmpty()
        if (raw.isEmpty())
            return null
        val file = File(raw)
        return when {
            file.isFile -> file.absolutePath
            file.isDirectory -> File(file, exe).takeIf { it.isFile }?.absolutePath
            else -> null
        }
    }

    /** Candidate node executables across the common managers/installers. */
    private fun commonLocations(): List<File>
    {
        val home = System.getProperty("user.home") ?: ""
        val candidates = mutableListOf<File?>()

        if (SystemInfo.isWindows)
        {
            System.getenv("ProgramFiles")?.let { candidates += File("$it\\nodejs\\node.exe") }
            System.getenv("ProgramFiles(x86)")?.let { candidates += File("$it\\nodejs\\node.exe") }
            System.getenv("LOCALAPPDATA")?.let { candidates += File("$it\\Volta\\bin\\node.exe") }
            candidates += File("$home\\scoop\\apps\\nodejs\\current\\node.exe")
            // nvm-windows keeps versioned dirs under %NVM_HOME% (or %APPDATA%\nvm).
            (System.getenv("NVM_HOME") ?: "$home\\AppData\\Roaming\\nvm").let { candidates += latestVersioned(File(it), "node.exe") }
            candidates += latestVersioned(File("$home\\AppData\\Roaming\\fnm\\node-versions"), "installation\\node.exe")
        }
        else
        {
            candidates += listOf(
                File("/usr/local/bin/$exe"),
                File("/opt/homebrew/bin/$exe"),
                File("/usr/bin/$exe"),
                File("$home/.volta/bin/$exe"),
                File("$home/.asdf/shims/$exe"),
            )
            candidates += latestVersioned(File("$home/.nvm/versions/node"), "bin/$exe")
            candidates += latestVersioned(File("$home/.fnm/node-versions"), "installation/bin/$exe")
            candidates += latestVersioned(File("$home/.local/share/fnm/node-versions"), "installation/bin/$exe")
        }
        return candidates.filterNotNull()
    }

    /**
     * Within a version-manager directory of `vXX.Y.Z` subfolders, the node
     * executable under the lexically-greatest subfolder (a good proxy for the
     * newest installed version), or null when the directory is absent/empty.
     */
    private fun latestVersioned(dir: File, relative: String): File?
    {
        if (!dir.isDirectory)
            return null
        // Newest version first - a NUMERIC compare, so v20.x ranks above v9.x (a
        // lexical sort would wrongly pick the older v9 because '9' > '2').
        val newestFirst = Comparator<File> { a, b -> compareVersion(version(b.name), version(a.name)) }
        return dir.listFiles { f -> f.isDirectory }
            ?.sortedWith(newestFirst)
            ?.map { File(it, relative) }
            ?.firstOrNull { it.isFile }
    }

    /** Numeric segments of a version dir name (`v20.11.0`/`20.11.0` -> [20,11,0]). */
    private fun version(name: String): List<Int> =
        name.removePrefix("v").split('.', '-', '+')
            .map { seg -> seg.takeWhile(Char::isDigit).toIntOrNull() ?: -1 }

    /** Element-wise compare of two numeric version keys (missing segments = 0). */
    private fun compareVersion(a: List<Int>, b: List<Int>): Int
    {
        for (i in 0 until maxOf(a.size, b.size)) {
            val c = a.getOrElse(i) { 0 }.compareTo(b.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }
}
