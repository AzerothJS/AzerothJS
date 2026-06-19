package com.azerothjs.lang

import com.intellij.codeInsight.highlighting.HighlightUsagesHandlerBase
import com.intellij.codeInsight.highlighting.HighlightUsagesHandlerFactory
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.util.Consumer

/**
 * "Highlight usages at caret" for `.azeroth`: when the caret is on a tag name,
 * highlight the matching open/close pair (so resting on `<span>` also highlights
 * its `</span>`). A native language routes this through PSI rather than the LSP
 * server, so the pairing is computed natively (see [AzerothTagMatcher]).
 */
class AzerothTagHighlightHandlerFactory : HighlightUsagesHandlerFactory {
    override fun createHighlightUsagesHandler(editor: Editor, file: PsiFile): HighlightUsagesHandlerBase<out PsiElement>? {
        if (file.language != AzerothLanguage) {
            return null
        }
        val ranges = AzerothTagMatcher.matchingTagRanges(editor.document.charsSequence, editor.caretModel.offset)
            ?: return null
        return AzerothTagHighlightHandler(editor, file, ranges)
    }
}

private class AzerothTagHighlightHandler(
    editor: Editor,
    file: PsiFile,
    private val ranges: List<TextRange>
) : HighlightUsagesHandlerBase<PsiElement>(editor, file) {

    // A non-empty target list is required for the handler to run; the file itself
    // stands in (the actual ranges to paint are supplied in computeUsages).
    override fun getTargets(): List<PsiElement> = listOf(myFile)

    override fun selectTargets(targets: List<PsiElement>, selectionConsumer: Consumer<in List<PsiElement>>) {
        selectionConsumer.consume(targets)
    }

    override fun computeUsages(targets: List<PsiElement>) {
        // Ranges were computed from the document at factory time; if the document
        // shrank since then, drop any that no longer fit so the editor never paints
        // past the end.
        val length = myEditor.document.textLength
        ranges.filterTo(myReadUsages) { it.startOffset >= 0 && it.endOffset <= length }
    }
}
