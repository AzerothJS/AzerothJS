package com.azerothjs

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project

/**
 * Surfaces language-server problems to the user instead of failing silently -
 * the JetBrains plugin's historical weakness was that when the server didn't
 * start (almost always: Node.js not on the IDE's PATH) nothing happened and
 * nothing was reported. Every startup failure now produces a balloon with a
 * direct link to the settings page, and a log line for bug reports.
 */
object AzerothNotifier {
    val log: Logger = Logger.getInstance("com.azerothjs")

    private const val GROUP = "AzerothJS"

    /** Shown when no Node.js executable could be located. */
    fun nodeNotFound(project: Project?) {
        notify(
            project,
            NotificationType.ERROR,
            "AzerothJS: Node.js not found",
            "The AzerothJS language server needs Node.js, but none was found on PATH or in the usual locations. " +
                "Set the Node path in Settings → Languages &amp; Frameworks → AzerothJS, then restart the language server.",
            openSettings = true,
        )
    }

    /** Shown when the bundled/served server.js is missing. */
    fun serverMissing(project: Project?, detail: String) {
        notify(
            project,
            NotificationType.ERROR,
            "AzerothJS: language server not found",
            "Could not locate the AzerothJS language server. $detail",
        )
    }

    /** Shown for an otherwise-unexpected startup failure. */
    fun startupFailed(project: Project?, detail: String) {
        notify(
            project,
            NotificationType.ERROR,
            "AzerothJS: language server failed to start",
            detail,
        )
    }

    private fun notify(
        project: Project?,
        type: NotificationType,
        title: String,
        content: String,
        openSettings: Boolean = false,
    ) {
        log.warn("$title — $content")
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP)
            .createNotification(title, content, type)
        if (openSettings) {
            notification.addAction(object : AnAction("Open AzerothJS Settings") {
                override fun actionPerformed(e: AnActionEvent) {
                    ShowSettingsUtil.getInstance().showSettingsDialog(project, "AzerothJS")
                }
            })
        }
        notification.notify(project)
    }
}
