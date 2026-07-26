// @vitest-environment node
//
// Completeness guard for the keyword documentation registries. The hover/completion providers are
// driven entirely by language-data's KEYWORD_DOCS / KEYWORD_OPTIONS / KEYWORD_WITH_EXAMPLE, so a new
// reactive keyword added to the compiler without documentation would silently hover as nothing.
// The compiler's RUNTIME_FN table is the authoritative list of reactive keywords (its keys are the
// lowerable construct kinds), so tying the assertion to it makes this test fail the moment a keyword
// ships undocumented.

import { describe, it, expect } from 'vitest';
import { RUNTIME_FN, WRAPPER_FN, BUILTIN_COMPONENTS } from '@azerothjs/compiler';
import { keywordDocumentation, keywordOptions, keywordWithExample, BUILTIN_COMPONENT_MAP } from '../../src/language-service/language-data.ts';
import { keywordSnippetLabels, builtinSnippetNames } from '../../src/language-service/providers/completion.ts';

const REACTIVE_KEYWORDS = Object.keys(RUNTIME_FN);
const WRAPPER_KEYWORDS = Object.keys(WRAPPER_FN);

describe('keyword documentation completeness', () =>
{
    it('every reactive keyword the compiler lowers has hover documentation', () =>
    {
        for (const keyword of [...REACTIVE_KEYWORDS, ...WRAPPER_KEYWORDS, 'component'])
        {
            const doc = keywordDocumentation(keyword);
            expect(doc, `keyword '${ keyword }' has no hover documentation`).toBeTruthy();
            expect(doc!.length).toBeGreaterThan(20);
        }
    });

    it('every wrapper keyword has a completion snippet (the gap that let `mount` ship without one)', () =>
    {
        const labels = keywordSnippetLabels();
        for (const keyword of WRAPPER_KEYWORDS)
        {
            expect(labels, `wrapper keyword '${ keyword }' has no completion snippet`).toContain(keyword);
        }
    });

    it('every keyword that documents with-options also shows a usage example', () =>
    {
        for (const keyword of REACTIVE_KEYWORDS)
        {
            if (keywordOptions(keyword) !== undefined)
            {
                expect(keywordWithExample(keyword), `keyword '${ keyword }' documents options but no with-example`).toBeTruthy();
            }
        }
    });

    it('every with-option carries a type and a non-trivial doc', () =>
    {
        for (const keyword of REACTIVE_KEYWORDS)
        {
            for (const option of keywordOptions(keyword) ?? [])
            {
                expect(option.type, `${ keyword }.${ option.name } has no type`).toBeTruthy();
                expect(option.doc.length, `${ keyword }.${ option.name } doc too thin`).toBeGreaterThan(15);
            }
        }
    });
});

describe('built-in component completeness (welded to the compiler\'s canonical list)', () =>
{
    // The compiler's exported BUILTIN_COMPONENTS is the authoritative set of control-flow
    // built-ins. Every one must have LS hover docs AND a completion snippet body - the drift
    // guard that would have caught Dynamic/Outlet shipping without snippets.
    it('every compiler built-in has hover documentation (BUILTIN_COMPONENT_MAP)', () =>
    {
        for (const name of BUILTIN_COMPONENTS)
        {
            expect(BUILTIN_COMPONENT_MAP.has(name), `built-in '${ name }' has no hover doc entry`).toBe(true);
        }
    });

    it('every compiler built-in has a completion snippet body', () =>
    {
        const snippets = builtinSnippetNames();
        for (const name of BUILTIN_COMPONENTS)
        {
            expect(snippets, `built-in '${ name }' has no completion snippet body`).toContain(name);
        }
    });

    it('the LS documents no phantom built-in the compiler does not know', () =>
    {
        const canonical = new Set(BUILTIN_COMPONENTS);
        for (const name of BUILTIN_COMPONENT_MAP.keys())
        {
            expect(canonical.has(name), `LS documents '${ name }' but the compiler has no such built-in`).toBe(true);
        }
    });
});
