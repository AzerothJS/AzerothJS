package com.azerothjs

import com.intellij.codeInsight.editorActions.TypedHandlerDelegate
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile

/**
 * Tag auto-closing for `.azeroth` files: typing the `>` of an opening tag
 * (`<div>`) inserts the matching `</div>` and leaves the caret between them.
 * (VS Code does this via a custom LSP request; JetBrains drives it natively
 * through a typed handler.)
 */
class AzerothTypedHandler : TypedHandlerDelegate() {
    override fun charTyped(c: Char, project: Project, editor: Editor, file: PsiFile): Result {
        // Tag auto-close runs natively (not via the LSP server), so it must honour
        // the `autoClosingTags` setting itself - the server's gate never sees it.
        if (c != '>' || file.virtualFile?.extension != "azeroth" || !AzerothSettings.instance.data.autoClosingTags) {
            return Result.CONTINUE
        }
        val closing = closingTagFor(editor.document.charsSequence, editor.caretModel.offset)
            ?: return Result.CONTINUE
        // Insert at the caret; the caret stays before the inserted closing tag.
        editor.document.insertString(editor.caretModel.offset, closing)
        return Result.STOP
    }

    /** `</name>` when the `>` just before `offset` closes an open tag, else null. */
    private fun closingTagFor(text: CharSequence, offset: Int): String? {
        if (offset < 1 || text[offset - 1] != '>') return null
        if (offset >= 2 && text[offset - 2] == '/') return null   // self-closing

        // Walk back to the tag's `<`, bailing if a `>` (a `=>` or prior tag) or
        // a `{` (attribute expression) is hit first — those cases are skipped to
        // avoid inserting a wrong tag.
        var i = offset - 2
        while (i >= 0 && text[i] != '<' && text[i] != '>' && text[i] != '{' && text[i] != '}') i--
        if (i < 0 || text[i] != '<' || (i + 1 < text.length && text[i + 1] == '/')) return null

        var j = i + 1
        val name = StringBuilder()
        while (j < offset && (text[j].isLetterOrDigit() || text[j] == '-' || text[j] == '.' || text[j] == '_')) {
            name.append(text[j]); j++
        }
        val tag = name.toString()
        if (tag.isEmpty() || tag.lowercase() in VOID_ELEMENTS) return null
        return "</$tag>"
    }

    private companion object {
        val VOID_ELEMENTS = setOf(
            "area", "base", "br", "col", "embed", "hr", "img", "input",
            "link", "meta", "param", "source", "track", "wbr",
        )
    }
}
