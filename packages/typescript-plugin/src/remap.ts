// Result-span remapping for the tsserver plugin. The host decoration (decorate.ts) serves each
// `.azeroth` file's COMPILED virtual TypeScript as its content, so every span tsserver computes for
// a `.azeroth` file is a VIRTUAL offset. The editor, however, renders spans against the on-disk
// `.azeroth` source - so unmapped results point at the wrong text: Find References shows garbage
// ranges, Go To Definition lands mid-identifier, and a cross-file Rename would EDIT WRONG RANGES in
// `.azeroth` files. This proxy translates every span that lands in a `.azeroth` file back to source
// offsets through the projection's own {@link CodeMapping}; spans inside generated-only scaffolding
// (no source equivalent) are dropped rather than misreported.

import type tsModule from 'typescript';
import type { VirtualAzerothFiles } from './decorate.ts';

/** True for a file name that is a real `.azeroth` source file. */
function isAzerothFile(fileName: string): boolean
{
    return fileName.endsWith('.azeroth');
}

/**
 * Wraps `service` in a proxy whose navigation results are safe to show against `.azeroth` SOURCE
 * text. Only span-producing, cross-file methods are overridden; everything else passes through.
 *
 * @param service - The language service tsserver created (already host-decorated).
 * @param virtual - Mapping access shared with the host decoration.
 * @returns The proxied language service to hand back to tsserver.
 */
export function remapLanguageService(
    service: tsModule.LanguageService,
    virtual: VirtualAzerothFiles
): tsModule.LanguageService
{
    /**
     * A `TextSpan` in `fileName` translated to source coordinates; null when the span has no source
     * equivalent (generated-only scaffolding) and the surrounding entry must be dropped.
     */
    const remapSpan = (fileName: string, span: tsModule.TextSpan): tsModule.TextSpan | null =>
    {
        if (!isAzerothFile(fileName))
        {
            return span;
        }
        const mapping = virtual.mappingFor(fileName);
        if (mapping === undefined)
        {
            return null;
        }
        const mapped = mapping.toOriginalRange(span.start, span.start + span.length);
        return mapped === null ? null : { start: mapped.start, length: mapped.end - mapped.start };
    };

    /**
     * Remaps the `textSpan`/`contextSpan` of any DocumentSpan-shaped entry (ReferenceEntry,
     * RenameLocation, DefinitionInfo, ImplementationLocation, HighlightSpan). Returns null when the
     * primary span cannot be mapped; an unmappable contextSpan is dropped alone since it is only a
     * presentation hint.
     */
    const remapDocumentSpan = <T extends { fileName: string; textSpan: tsModule.TextSpan; contextSpan?: tsModule.TextSpan }>(entry: T): T | null =>
    {
        const textSpan = remapSpan(entry.fileName, entry.textSpan);
        if (textSpan === null)
        {
            return null;
        }
        const contextSpan = entry.contextSpan === undefined ? undefined : remapSpan(entry.fileName, entry.contextSpan) ?? undefined;
        return { ...entry, textSpan, contextSpan };
    };

    const mapEntries = <T extends { fileName: string; textSpan: tsModule.TextSpan; contextSpan?: tsModule.TextSpan }>(
        entries: readonly T[] | undefined
    ): T[] | undefined => (entries === undefined ? undefined : entries
            .map(remapDocumentSpan)
            .filter((entry): entry is T => entry !== null));

    // Built as a plain record because the members are enumerated at runtime; the
    // assertion below is the one place the record is blessed as a LanguageService.
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(service) as (keyof tsModule.LanguageService)[])
    {
        const member = service[key];
        record[key] = typeof member === 'function' ? (member as (...a: unknown[]) => unknown).bind(service) : member;
    }
    const proxy = record as unknown as tsModule.LanguageService;

    proxy.findReferences = (fileName, position) =>
    {
        const symbols = service.findReferences(fileName, position);
        if (symbols === undefined)
        {
            return undefined;
        }
        return symbols
            .map((symbol): tsModule.ReferencedSymbol | null =>
            {
                const definition = remapDocumentSpan(symbol.definition);
                if (definition === null)
                {
                    return null;
                }
                return { definition, references: mapEntries(symbol.references) ?? [] };
            })
            .filter((symbol): symbol is tsModule.ReferencedSymbol => symbol !== null);
    };

    proxy.getReferencesAtPosition = (fileName, position) =>
        mapEntries(service.getReferencesAtPosition(fileName, position));

    proxy.getDefinitionAndBoundSpan = (fileName, position) =>
    {
        const result = service.getDefinitionAndBoundSpan(fileName, position);
        if (result === undefined)
        {
            return undefined;
        }
        // `textSpan` (the bound span) is in the QUERY file - the caller's coordinates - so it is
        // remapped only when the query itself targets a `.azeroth` file.
        const bound = remapSpan(fileName, result.textSpan);
        const textSpan = bound ?? result.textSpan;
        const definitions = mapEntries(result.definitions);
        return definitions === undefined ? { textSpan } : { definitions, textSpan };
    };

    proxy.getDefinitionAtPosition = (fileName, position) =>
        mapEntries(service.getDefinitionAtPosition(fileName, position));

    proxy.getTypeDefinitionAtPosition = (fileName, position) =>
        mapEntries(service.getTypeDefinitionAtPosition(fileName, position));

    proxy.getImplementationAtPosition = (fileName, position) =>
        mapEntries(service.getImplementationAtPosition(fileName, position));

    // tsserver still invokes the legacy boolean overload on some code paths; a
    // pass-through proxy must forward whichever call shape arrives, so it cannot
    // migrate to the preferences-object overload the deprecation points at.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- pass-through must forward tsserver's legacy boolean-overload call shape
    proxy.findRenameLocations = ((fileName: string, position: number, findInStrings: boolean, findInComments: boolean, preferences?: tsModule.UserPreferences | boolean) =>
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- same legacy overload, forwarded verbatim
        mapEntries((service.findRenameLocations as (...args: unknown[]) => readonly tsModule.RenameLocation[] | undefined)(
            fileName, position, findInStrings, findInComments, preferences
        )));

    proxy.getDocumentHighlights = (fileName, position, filesToSearch) =>
    {
        const highlights = service.getDocumentHighlights(fileName, position, filesToSearch);
        if (highlights === undefined)
        {
            return undefined;
        }
        return highlights
            .map((doc): tsModule.DocumentHighlights | null =>
            {
                if (!isAzerothFile(doc.fileName))
                {
                    return doc;
                }
                const spans = doc.highlightSpans
                    .map((span): tsModule.HighlightSpan | null =>
                    {
                        const textSpan = remapSpan(doc.fileName, span.textSpan);
                        if (textSpan === null)
                        {
                            return null;
                        }
                        const { contextSpan, ...rest } = span;
                        const remappedContext = contextSpan === undefined ? undefined : remapSpan(doc.fileName, contextSpan) ?? undefined;
                        return remappedContext === undefined ? { ...rest, textSpan } : { ...rest, textSpan, contextSpan: remappedContext };
                    })
                    .filter((span): span is tsModule.HighlightSpan => span !== null);
                return spans.length === 0 ? null : { ...doc, highlightSpans: spans };
            })
            .filter((doc): doc is tsModule.DocumentHighlights => doc !== null);
    };

    return proxy;
}
