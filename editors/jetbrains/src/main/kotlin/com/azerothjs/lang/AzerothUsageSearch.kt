package com.azerothjs.lang

import com.intellij.codeInsight.daemon.ImplicitUsageProvider
import com.intellij.lang.findUsages.FindUsagesProvider
import com.intellij.lang.cacheBuilder.DefaultWordsScanner
import com.intellij.lang.cacheBuilder.WordsScanner
import com.intellij.openapi.application.QueryExecutorBase
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.PsiReference
import com.intellij.psi.PsiReferenceBase
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.PsiSearchHelper
import com.intellij.psi.search.UsageSearchContext
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.tree.TokenSet
import com.intellij.util.Processor
import java.nio.file.Paths

/**
 * Makes usages INSIDE `.azeroth` files visible to WebStorm's PSI-based usage analysis.
 *
 * WHY: the "unused" inspections ("Unused export specifier", "Unused constant ...") and Find Usages
 * run on the platform's word/reference indices, NOT on tsserver or the AzerothJS LSP. The plugin's
 * `.azeroth` PSI is a flat token stream with no references, so a `.ts` symbol used only from
 * `.azeroth` files looked unused. Three pieces close the gap, sharing ONE verified scanner:
 *
 *  - [AzerothFindUsagesProvider]: a words scanner so `.azeroth` identifiers enter the word index
 *    with CODE context (identifiers) vs comment/string contexts - without it the index has no
 *    usable entries for `.azeroth` at all.
 *  - [AzerothImplicitUsageProvider]: consulted by the JS unused-symbols pass per candidate; answers
 *    "used" ONLY when a verified `.azeroth` usage exists, so genuinely unused symbols stay flagged.
 *  - [AzerothTsReferencesSearcher]: feeds Find Usages so the `.azeroth` occurrences are listed and
 *    clickable.
 *
 * Verification (see [AzerothUsageScan.processUsages]): the occurrence must be an IDENTIFIER token
 * (never string/comment text), and its file must IMPORT that name - for a relative specifier the
 * module must resolve back to the searched symbol's file, so a same-named symbol from another
 * module does not mask a genuinely unused one. Non-relative specifiers (path aliases) cannot be
 * resolved without the consumer's tsconfig, so they pass on the name match alone - a deliberate,
 * small over-approximation.
 */
object AzerothUsageScan
{
    /** Source extensions whose symbols can be used from `.azeroth` files. */
    private val TS_EXTENSIONS = setOf("ts", "tsx", "mts", "cts", "js", "mjs", "cjs")

    private val IDENTIFIER_REGEX = Regex("^[A-Za-z_$][A-Za-z0-9_$]*$")

    /** True when `element` is a named TS/JS symbol worth scanning `.azeroth` files for. */
    fun isSearchableSymbol(element: PsiElement): Boolean
    {
        val name = (element as? PsiNamedElement)?.name ?: return false
        if (name.length < 2 || !IDENTIFIER_REGEX.matches(name))
        {
            return false
        }
        val extension = element.containingFile?.virtualFile?.extension ?: return false
        return extension in TS_EXTENSIONS
    }

    /**
     * Runs `processor` for every verified usage of `element`'s name inside the project's `.azeroth`
     * files (leaf identifier token + start offset of the occurrence within it). Candidate discovery
     * goes through the word index (no eager file scans); file content is consulted only for files
     * the index already matched. Returning false from `processor` stops the scan.
     */
    fun processUsages(element: PsiElement, processor: (leaf: PsiElement, startInLeaf: Int) -> Boolean): Boolean
    {
        val name = (element as? PsiNamedElement)?.name ?: return true
        val project = element.project
        val targetFile = element.containingFile?.virtualFile
        val scope = GlobalSearchScope.getScopeRestrictedByFileTypes(
            GlobalSearchScope.projectScope(project),
            AzerothFileType
        )
        // Cache the per-file import verification across the occurrences of one scan.
        val fileVerdicts = HashMap<String, Boolean>()
        return PsiSearchHelper.getInstance(project).processElementsWithWord(
            { occurrence, offsetInElement ->
                if (occurrence.node?.elementType !== AzerothTypes.IDENTIFIER)
                {
                    return@processElementsWithWord true
                }
                val file = occurrence.containingFile ?: return@processElementsWithWord true
                val filePath = file.virtualFile?.path ?: return@processElementsWithWord true
                val imported = fileVerdicts.getOrPut(filePath)
                {
                    fileImportsName(file.text, name, filePath, targetFile?.path)
                }
                if (!imported)
                {
                    return@processElementsWithWord true
                }
                processor(occurrence, offsetInElement)
            },
            scope,
            name,
            UsageSearchContext.IN_CODE,
            true
        )
    }

    /** True when at least one verified `.azeroth` usage of `element` exists. */
    fun hasUsage(element: PsiElement): Boolean
    {
        var found = false
        processUsages(element)
        { _, _ ->
            found = true
            false
        }
        return found
    }

    /**
     * True when the `.azeroth` source imports `name`, and - for a RELATIVE specifier - the imported
     * module resolves back to `targetPath` (the searched symbol's file). Text-level on purpose: the
     * flat `.azeroth` PSI has no import tree, and this runs only on files the word index already
     * matched.
     */
    private fun fileImportsName(source: String, name: String, azerothPath: String, targetPath: String?): Boolean
    {
        val importRegex = Regex(
            """import\s+(?:type\s+)?([^;'"]*?\b${ Regex.escape(name) }\b[^;'"]*?)\s+from\s+['"]([^'"]+)['"]"""
        )
        for (match in importRegex.findAll(source))
        {
            val specifier = match.groupValues[2]
            if (!specifier.startsWith('.'))
            {
                // A path alias cannot be resolved without the consumer's tsconfig - accept the
                // name match (documented over-approximation).
                return true
            }
            if (targetPath == null || relativeSpecifierResolvesTo(azerothPath, specifier, targetPath))
            {
                return true
            }
        }
        return false
    }

    /** True when `specifier`, resolved against the `.azeroth` file's directory, names `targetPath`. */
    private fun relativeSpecifierResolvesTo(azerothPath: String, specifier: String, targetPath: String): Boolean
    {
        val base = Paths.get(azerothPath).parent ?: return false
        val resolved = base.resolve(specifier).normalize().toString().replace('\\', '/')
        val target = targetPath.replace('\\', '/')
        if (target == resolved)
        {
            return true
        }
        for (candidate in sequenceOf("$resolved.ts", "$resolved.tsx", "$resolved.js", "$resolved.mts",
            "$resolved/index.ts", "$resolved/index.tsx", "$resolved/index.js"))
        {
            if (target == candidate)
            {
                return true
            }
        }
        return false
    }
}

/**
 * Word-indexes `.azeroth` files so their identifiers are searchable with CODE context (comments and
 * strings get their own contexts and are excluded from code searches). Without this scanner the
 * word index has nothing useful for `.azeroth` and every index-driven feature - the unused-symbol
 * inspections above all - is blind to the files.
 */
class AzerothFindUsagesProvider : FindUsagesProvider
{
    override fun getWordsScanner(): WordsScanner = DefaultWordsScanner(
        AzerothLexer(),
        TokenSet.create(AzerothTypes.IDENTIFIER),
        TokenSet.create(AzerothTypes.LINE_COMMENT, AzerothTypes.BLOCK_COMMENT),
        TokenSet.create(AzerothTypes.STRING)
    )

    override fun canFindUsagesFor(psiElement: PsiElement): Boolean = false
    override fun getHelpId(psiElement: PsiElement): String? = null
    override fun getType(element: PsiElement): String = ""
    override fun getDescriptiveName(element: PsiElement): String = ""
    override fun getNodeText(element: PsiElement, useFullName: Boolean): String = ""
}

/**
 * Tells the JS unused-symbols pass that a `.ts` symbol with a VERIFIED `.azeroth` usage is used.
 * The pass consults this extension point per candidate (its own reference search runs in a
 * tsconfig-derived scope that `.azeroth` files are not part of, so this provider is the reliable
 * channel). It answers true ONLY on a verified usage: genuinely unused exports stay flagged.
 */
class AzerothImplicitUsageProvider : ImplicitUsageProvider
{
    override fun isImplicitUsage(element: PsiElement): Boolean =
        AzerothUsageScan.isSearchableSymbol(element) && AzerothUsageScan.hasUsage(element)

    override fun isImplicitRead(element: PsiElement): Boolean = false
    override fun isImplicitWrite(element: PsiElement): Boolean = false
}

/** A usage of a `.ts` symbol at an identifier occurrence inside a `.azeroth` file. */
private class AzerothWordReference(
    element: PsiElement,
    range: TextRange,
    private val target: PsiElement
) : PsiReferenceBase<PsiElement>(element, range, true)
{
    override fun resolve(): PsiElement = target
}

/**
 * Feeds Find Usages (and any other ReferencesSearch consumer) the `.azeroth` occurrences of a
 * TS/JS symbol, so "Find Usages" on `setSeo` or a barrel export specifier lists the `.azeroth`
 * files and clicks through to the exact identifier.
 */
class AzerothTsReferencesSearcher : QueryExecutorBase<PsiReference, ReferencesSearch.SearchParameters>(true)
{
    override fun processQuery(queryParameters: ReferencesSearch.SearchParameters, consumer: Processor<in PsiReference>)
    {
        val element = queryParameters.elementToSearch
        if (!AzerothUsageScan.isSearchableSymbol(element))
        {
            return
        }
        val name = (element as PsiNamedElement).name ?: return
        AzerothUsageScan.processUsages(element)
        { leaf, startInLeaf ->
            consumer.process(AzerothWordReference(leaf, TextRange(startInLeaf, startInLeaf + name.length), element))
        }
    }
}
