// Welds the completion dataset's FACTORY props to the semantics vocabulary, the way
// binding-attr-data.spec.ts does for `let=`/`index=`. A factory prop is a lazy render
// function rather than a reactive value, so the compiler emits it differently
// (`isFactoryProp`); documenting one the vocabulary does not define, or describing a
// defined one as a plain value, is how the editor and the emitter start disagreeing.
import { describe, it, expect } from 'vitest';
import { FACTORY_ATTRS, isFactoryProp } from 'azerothjs/semantics';
import { BUILTIN_COMPONENT_MAP } from '../../src/language-service/language-data.ts';

describe('factory-prop dataset drift', () =>
{
    it('every documented prop whose NAME is a factory attr is a real factory on that tag', () =>
    {
        for (const [tag, data] of BUILTIN_COMPONENT_MAP)
        {
            for (const prop of data.props)
            {
                if (FACTORY_ATTRS.has(prop.name))
                {
                    expect(
                        isFactoryProp(tag, prop.name),
                        `language-data documents '${ tag }.${ prop.name }' but the vocabulary does not treat it as a factory`
                    ).toBe(true);
                }
            }
        }
    });

    it('a documented factory prop carries documentation, so completion never shows a bare name', () =>
    {
        for (const [tag, data] of BUILTIN_COMPONENT_MAP)
        {
            for (const prop of data.props.filter(p => FACTORY_ATTRS.has(p.name)))
            {
                expect(prop.doc.length, `'${ tag }.${ prop.name }' has no doc`).toBeGreaterThan(0);
            }
        }
    });

    it('the factory contract is per COMPONENT, never per prop name', () =>
    {
        // A user component with a prop that happens to be called `fallback` receives the
        // plain value - the asymmetry the vocabulary exists to encode.
        expect(isFactoryProp('Show', 'fallback')).toBe(true);
        expect(isFactoryProp('Card', 'fallback')).toBe(false);
        expect(isFactoryProp('Show', 'when')).toBe(false);
    });
});
