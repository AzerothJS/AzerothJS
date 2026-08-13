// @vitest-environment node
//
// A `<select>`'s value must never bake into the static clone template.
//
// `value` is not a content attribute of `<select>` - the element has no such attribute at all -
// so a baked `value="de"` is inert markup AND leaves no runtime writer to apply the selection.
// That is the one manifestation of the select-value defect that no runtime fix can reach, which
// is why these assert the emitted STRING: they are what stops a future refactor re-baking it.
//
// The behavioural half lives in packages/azerothjs/tests/renderer/select-value.spec.ts.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';

describe('the compiler keeps a select value out of the static template', () =>
{
    it('a literal value emits a writer instead of baking an inert attribute', () =>
    {
        const generated = generateModule(
            'export default component S()\n{\n    <select value="de">\n        <option value="us">us</option>\n        <option value="de">de</option>\n    </select>\n}\n',
            'S.azeroth', {});
        const code = typeof generated === 'string' ? generated : generated.code;

        // Baked into the template there is NO writer left at all, and `value` is not a content
        // attribute of <select>, so the clone would carry an inert attribute forever.
        expect(code).toMatch(/<select(?![^>]*\svalue=)/);
        expect(code).toMatch(/setProp\(\s*\w+\s*,\s*'value'/);
    });

    it('the constant folder does not put it back', () =>
    {
        const generated = generateModule(
            "export default component S()\n{\n    <select value={ 'de' }>\n        <option value=\"us\">us</option>\n        <option value=\"de\">de</option>\n    </select>\n}\n",
            'S.azeroth', {});
        const code = typeof generated === 'string' ? generated : generated.code;

        // Without this the lowerer's fix is silently reverted and the test above still passes.
        expect(code).toMatch(/<select(?![^>]*\svalue=)/);
        expect(code).toMatch(/setProp\(\s*\w+\s*,\s*'value'/);
    });
});
