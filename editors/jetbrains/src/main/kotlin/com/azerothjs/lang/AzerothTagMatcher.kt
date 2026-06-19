package com.azerothjs.lang

import com.intellij.openapi.util.TextRange

/**
 * Pairs opening and closing markup tags so the editor can highlight the matching
 * tag when the caret is on a tag name (caret on `<span>` -> also highlight its
 * `</span>`, even when same-named spans are nested). Self-contained text
 * scanning: the language server does the same pairing for LSP clients, but a
 * JetBrains native language routes "highlight usages at caret" through PSI, which
 * never reaches the server - so the matching is reproduced natively here.
 *
 * It is deliberately conservative: a tag opener is only recognised when `<` (or
 * `</`) is immediately followed by a name, which keeps a comparison like `a < b`
 * from being mistaken for a tag. Strings and comments are skipped so a `<` inside
 * them is ignored. When no clean match exists it returns null (no highlight)
 * rather than guessing.
 */
object AzerothTagMatcher {
    private enum class Kind { OPEN, CLOSE, SELF }

    private class Tag(val name: String, val nameStart: Int, val nameEnd: Int, val kind: Kind)

    // Tag-pair highlighting is a convenience and runs on the EDT, so skip the
    // O(n) full-document scan on very large files rather than risk a UI stall (a
    // `.azeroth` component is normally a few KB).
    private const val MAX_SCAN_LENGTH = 500_000

    /** The open+close tag-name ranges to highlight for the caret, or null. */
    fun matchingTagRanges(text: CharSequence, offset: Int): List<TextRange>? {
        if (text.length > MAX_SCAN_LENGTH) {
            return null
        }
        val tags = scan(text)
        val onTag = tags.firstOrNull { offset >= it.nameStart && offset <= it.nameEnd && it.kind != Kind.SELF }
            ?: return null

        // Stack-based pairing: each close matches the nearest still-open same name.
        val pair = HashMap<Tag, Tag>()
        val stack = ArrayDeque<Tag>()
        for (t in tags) {
            when (t.kind) {
                Kind.OPEN -> stack.addLast(t)
                Kind.SELF -> {}
                Kind.CLOSE -> {
                    while (stack.isNotEmpty() && stack.last().name != t.name) {
                        stack.removeLast()
                    }
                    if (stack.isNotEmpty()) {
                        val open = stack.removeLast()
                        pair[open] = t
                        pair[t] = open
                    }
                }
            }
        }

        val other = pair[onTag] ?: return null
        return listOf(TextRange(onTag.nameStart, onTag.nameEnd), TextRange(other.nameStart, other.nameEnd))
    }

    /** All open/close/self-closing tags in the text, skipping strings and comments. */
    private fun scan(text: CharSequence): List<Tag> {
        val tags = ArrayList<Tag>()
        var i = 0
        val n = text.length
        while (i < n) {
            val c = text[i]
            i = when {
                c == '/' && i + 1 < n && text[i + 1] == '/' -> skipLineComment(text, i)
                c == '/' && i + 1 < n && text[i + 1] == '*' -> skipBlockComment(text, i)
                c == '"' || c == '\'' || c == '`' -> skipString(text, i)
                c == '<' -> readTag(text, i, tags)
                else -> i + 1
            }
        }
        return tags
    }

    /** Reads a tag at `lt` (a `<`), appends it if it is one, returns the next index. */
    private fun readTag(text: CharSequence, lt: Int, out: MutableList<Tag>): Int {
        val n = text.length
        val closing = lt + 1 < n && text[lt + 1] == '/'
        // An OPENING `<` directly after an operand (`a<b`, `arr[i]<x`, `f()<g`) is a
        // comparison/generic, not a tag. Closings (`</name>`) are unambiguous.
        if (!closing && followsOperand(text, lt)) {
            return lt + 1
        }
        var nameStart = if (closing) lt + 2 else lt + 1
        if (nameStart >= n || !isNameStart(text[nameStart])) {
            return lt + 1 // `<>`, `</>`, `a < b`, or `<` operator - not a named tag
        }
        var nameEnd = nameStart
        while (nameEnd < n && isNamePart(text[nameEnd])) {
            nameEnd++
        }
        val name = text.subSequence(nameStart, nameEnd).toString()

        // Walk to the tag's `>`, skipping quoted attribute values and `{ }` holes,
        // tracking whether it self-closes (`/>`).
        var i = nameEnd
        var selfClose = false
        while (i < n) {
            val ch = text[i]
            when {
                ch == '>' -> { i++; break }
                ch == '/' && i + 1 < n && text[i + 1] == '>' -> { selfClose = true; i += 2; break }
                ch == '"' || ch == '\'' || ch == '`' -> i = skipString(text, i)
                ch == '{' -> i = skipBraces(text, i)
                else -> i++
            }
        }
        val kind = if (closing) Kind.CLOSE else if (selfClose) Kind.SELF else Kind.OPEN
        out.add(Tag(name, nameStart, nameEnd, kind))
        return i
    }

    /** Index past a `"`/`'`/`` ` `` string starting at `q` (single-line, escape-aware). */
    private fun skipString(text: CharSequence, q: Int): Int {
        val quote = text[q]
        var j = q + 1
        val n = text.length
        while (j < n && text[j] != quote && text[j] != '\n') {
            if (text[j] == '\\') j++
            j++
        }
        return (j + 1).coerceAtMost(n)
    }

    /** Index past a balanced `{ ... }` starting at `brace` (skips nested strings/braces). */
    private fun skipBraces(text: CharSequence, brace: Int): Int {
        var depth = 0
        var i = brace
        val n = text.length
        while (i < n) {
            val ch = text[i]
            when {
                ch == '"' || ch == '\'' || ch == '`' -> { i = skipString(text, i); continue }
                ch == '{' -> depth++
                ch == '}' -> { depth--; if (depth == 0) return i + 1 }
            }
            i++
        }
        return i
    }

    private fun skipLineComment(text: CharSequence, at: Int): Int {
        var i = at
        val n = text.length
        while (i < n && text[i] != '\n') i++
        return i
    }

    private fun skipBlockComment(text: CharSequence, at: Int): Int {
        var i = at + 2
        val n = text.length
        while (i + 1 < n && !(text[i] == '*' && text[i + 1] == '/')) i++
        return (i + 2).coerceAtMost(n)
    }

    /**
     * Whether the `<` at `lt` IMMEDIATELY follows an operand - an identifier,
     * digit, `)` or `]` with no space between. Such a `<` is a comparison or
     * generic (`a<b`, `createSignal<Todo>`, `f()<g`), not a tag. Whitespace is
     * NOT skipped on purpose: `return <div>` and `a < b` keep a space before `<`,
     * so they are unaffected (and `a < b` is already rejected because a space, not
     * a name, follows the `<`).
     */
    private fun followsOperand(text: CharSequence, lt: Int): Boolean {
        if (lt == 0) {
            return false
        }
        val c = text[lt - 1]
        return c.isLetterOrDigit() || c == '_' || c == '$' || c == ')' || c == ']'
    }

    private fun isNameStart(c: Char): Boolean = c.isLetter() || c == '_'
    private fun isNamePart(c: Char): Boolean = c.isLetterOrDigit() || c == '_' || c == '-' || c == '.'
}
