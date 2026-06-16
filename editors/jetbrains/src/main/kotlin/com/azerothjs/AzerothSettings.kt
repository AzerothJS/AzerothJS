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

        var completion: Boolean = true
        var hover: Boolean = true
        var definition: Boolean = true
        var typeDefinition: Boolean = true
        var references: Boolean = true
        var documentHighlight: Boolean = true
        var rename: Boolean = true
        var documentSymbol: Boolean = true
        var workspaceSymbol: Boolean = true
        var signatureHelp: Boolean = true
        var semanticTokens: Boolean = true
        var codeActions: Boolean = true
        var folding: Boolean = true
        var selectionRange: Boolean = true
        var onTypeFormatting: Boolean = true
        var linkedEditing: Boolean = true

        var parameterTypeHints: Boolean = true
        var variableTypeHints: Boolean = true
        var propertyDeclarationTypeHints: Boolean = true
        var functionLikeReturnTypeHints: Boolean = true
        var enumMemberValueHints: Boolean = true
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
        // Each feature is a sibling `azeroth.<feature>` key shaped { enable: bool };
        // parseSettings reads them via featureOn(<feature>), not a nested map.
        "completion" to mapOf("enable" to state.completion),
        "hover" to mapOf("enable" to state.hover),
        "definition" to mapOf("enable" to state.definition),
        "typeDefinition" to mapOf("enable" to state.typeDefinition),
        "references" to mapOf("enable" to state.references),
        "documentHighlight" to mapOf("enable" to state.documentHighlight),
        "rename" to mapOf("enable" to state.rename),
        "documentSymbol" to mapOf("enable" to state.documentSymbol),
        "workspaceSymbol" to mapOf("enable" to state.workspaceSymbol),
        "signatureHelp" to mapOf("enable" to state.signatureHelp),
        "semanticTokens" to mapOf("enable" to state.semanticTokens),
        "codeActions" to mapOf("enable" to state.codeActions),
        "folding" to mapOf("enable" to state.folding),
        "selectionRange" to mapOf("enable" to state.selectionRange),
        "onTypeFormatting" to mapOf("enable" to state.onTypeFormatting),
        "linkedEditing" to mapOf("enable" to state.linkedEditing),
        "inlayHints" to mapOf(
            "enabled" to state.inlayHints,
            "parameterNames" to if (state.parameterNameHints) "all" else "none",
            "parameterTypes" to state.parameterTypeHints,
            "variableTypes" to state.variableTypeHints,
            "propertyDeclarationTypes" to state.propertyDeclarationTypeHints,
            "functionLikeReturnTypes" to state.functionLikeReturnTypeHints,
            "enumMemberValues" to state.enumMemberValueHints,
        ),
    )

    companion object {
        val instance: AzerothSettings get() = service()
    }
}
