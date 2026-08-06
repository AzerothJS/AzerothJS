// Welds the completion dataset's binding-attribute entries to the semantics vocabulary.
// BINDING_ATTRS (azerothjs/semantics) is the single behavioral source; the language-data
// table is presentation over it - this test is what keeps a new binding attribute from
// landing in one without the other.
import { describe, it, expect } from 'vitest';
import { BINDING_ATTRS } from 'azerothjs/semantics';
import { BUILTIN_COMPONENT_MAP } from '../../src/language-service/language-data.ts';

describe('binding-attr dataset drift', () =>
{
    it('every vocabulary entry has a documented completion item', () =>
    {
        for (const [tag, attrs] of BINDING_ATTRS)
        {
            const data = BUILTIN_COMPONENT_MAP.get(tag);
            expect(data, `language-data is missing builtin '${ tag }'`).toBeDefined();

            for (const attr of attrs)
            {
                const prop = data?.props.find((p) => p.name === attr);
                expect(prop, `language-data '${ tag }' is missing binding attr '${ attr }'`).toBeDefined();
                expect(prop?.doc.length ?? 0).toBeGreaterThan(0);
            }
        }
    });

    it('no dataset entry claims a binding attr the vocabulary does not define', () =>
    {
        for (const [tag, data] of BUILTIN_COMPONENT_MAP)
        {
            for (const prop of data.props)
            {
                if (prop.name === 'let' || prop.name === 'index')
                {
                    expect(BINDING_ATTRS.get(tag)?.has(prop.name), `'${ tag }' documents '${ prop.name }' but the vocabulary does not define it`).toBe(true);
                }
            }
        }
    });
});
