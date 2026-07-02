// @vitest-environment node
//
// Completeness guard for the keyword documentation registries. The hover/completion providers are
// driven entirely by language-data's KEYWORD_DOCS / KEYWORD_OPTIONS / KEYWORD_WITH_EXAMPLE, so a new
// reactive keyword added to the compiler without documentation would silently hover as nothing.
// The compiler's RUNTIME_FN table is the authoritative list of reactive keywords (its keys are the
// lowerable construct kinds), so tying the assertion to it makes this test fail the moment a keyword
// ships undocumented.

import { describe, it, expect } from 'vitest';
import { RUNTIME_FN } from '@azerothjs/compiler';
import { keywordDocumentation, keywordOptions, keywordWithExample } from '../src/language-data.ts';

const REACTIVE_KEYWORDS = Object.keys(RUNTIME_FN);

describe('keyword documentation completeness', () =>
{
    it('every reactive keyword the compiler lowers has hover documentation', () =>
    {
        for (const keyword of [...REACTIVE_KEYWORDS, 'component'])
        {
            const doc = keywordDocumentation(keyword);
            expect(doc, `keyword '${ keyword }' has no hover documentation`).toBeTruthy();
            expect(doc!.length).toBeGreaterThan(20);
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
