package com.azerothjs

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

/**
 * Persisted AzerothJS settings, edited via [AzerothConfigurable] and forwarded
 * to the language server as LSP initializationOptions (see the descriptor's
 * createInitializationOptions). All features default to on.
 */
@Service(Service.Level.APP)
@State(name = "AzerothSettings", storages = [Storage("azeroth.xml")])
class AzerothSettings : PersistentStateComponent<AzerothSettings.State> {
    class State {
        var diagnostics: Boolean = true
        var format: Boolean = true
        var autoImports: Boolean = true
        var componentSnippets: Boolean = true
        var inlayHints: Boolean = true
        var parameterNameHints: Boolean = true
    }

    private var state = State()

    override fun getState(): State = state

    override fun loadState(s: State) {
        state = s
    }

    /** The mutable state, for UI binding. */
    val data: State get() = state

    /** The settings shaped as the server's `azeroth.*` config tree. */
    fun toInitializationOptions(): Map<String, Any> = mapOf(
        "diagnostics" to mapOf("enable" to state.diagnostics),
        "format" to mapOf("enable" to state.format),
        "suggest" to mapOf(
            "autoImports" to state.autoImports,
            "componentSnippets" to state.componentSnippets,
        ),
        "inlayHints" to mapOf(
            "enabled" to state.inlayHints,
            "parameterNames" to if (state.parameterNameHints) "all" else "none",
        ),
    )

    companion object {
        val instance: AzerothSettings get() = service()
    }
}
