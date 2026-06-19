// The .azeroth processor: ESLint lints the whole component - script AND markup -
// by surfacing it verbatim as a virtual `*.azeroth/0_index.ts` block parsed by
// the plugin's wrapper parser. Reactivity-rule findings map back to the ORIGINAL
// source line, valid markup never surfaces as a syntax error, and style rules now
// reach the markup. Driven through the real ESLint flat-config pipeline.

import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import azeroth from '@azerothjs/eslint-plugin';
import { compile } from '@azerothjs/compiler';

function makeESLint(rules: Record<string, unknown> = {}, fix = false): ESLint
{
    return new ESLint({
        fix,
        overrideConfigFile: true,
        overrideConfig: [
            ...azeroth.configs.recommended,
            // The surfaced script is a virtual `*.azeroth/0_index.ts` block; a
            // `.ts`-matching config makes ESLint lint it (typescript-eslint does
            // this in a real project). Markup parsing comes from the recommended
            // config's `azeroth/markup-parsing` entry (the wrapper parser).
            { files: ['**/*.ts'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }, rules }
        ]
    });
}

describe('azeroth processor', () =>
{
    it('lints the script and maps a reactivity finding to the original line', async () =>
    {
        const component = `import { createSignal, createEffect } from '@azerothjs/core';

export default function Counter()
{
    const [count, setCount] = createSignal(0);

    createEffect(() =>
    {
        setCount(count() + 1);
    });

    return <div class="box">{count()}</div>;
}
`;
        const [result] = await makeESLint().lintText(component, { filePath: 'Counter.azeroth' });
        const selfWrite = result.messages.find(m => m.ruleId === 'azeroth/no-self-write-in-effect');

        expect(selfWrite).toBeDefined();
        expect(selfWrite!.line).toBe(9);
        expect(result.messages.some(m => m.fatal)).toBe(false);
    });

    it('does not report valid markup as a syntax error', async () =>
    {
        const clean = `import { createSignal } from '@azerothjs/core';

export default function Ok()
{
    const [n] = createSignal(0);
    return <p class="x">{n()}</p>;
}
`;
        const [result] = await makeESLint().lintText(clean, { filePath: 'Ok.azeroth' });
        expect(result.messages.filter(m => m.fatal)).toHaveLength(0);
    });

    it('does not flag an import used only in the markup as unused', async () =>
    {
        // With the markup surfaced (not masked), the parser sees `<Widget>` as a
        // use of the import, so no-unused-vars must NOT fire — the regression the
        // old masking + delegation guarded against.
        const component = `import Widget from './widget';

export default function Host()
{
    return <Widget />;
}
`;
        const [result] = await makeESLint({ 'no-unused-vars': 'error' })
            .lintText(component, { filePath: 'Host.azeroth' });
        const unused = result.messages.filter(m => (m.ruleId ?? '').includes('no-unused-vars'));
        expect(unused).toEqual([]);
    });

    it('lints style violations INSIDE the markup', async () =>
    {
        // A double-quoted string in a markup expression: with the markup surfaced
        // (not masked), the `quotes` rule now reaches it. (Attribute values are
        // exempted by the `quotes` rule itself, so the probe lives in a `{ }` hole.)
        const component = `export default function Bad()
{
    return <div>{"inside markup"}</div>;
}
`;
        const [result] = await makeESLint({ quotes: ['error', 'single'] })
            .lintText(component, { filePath: 'Bad.azeroth' });
        const quote = result.messages.find(m => m.ruleId === 'quotes');
        expect(quote).toBeDefined();
        expect(quote!.line).toBe(3);
    });

    it('runs a core (non-AzerothJS) rule inside a markup expression', async () =>
    {
        // Proves arbitrary core/third-party rules reach markup, not just the
        // plugin's own rules: `eqeqeq` is a stock ESLint rule.
        const component = `export default function C()
{
    const ok = 1;
    return <div>{ok == 1 ? 'y' : 'n'}</div>;
}
`;
        const [result] = await makeESLint({ eqeqeq: 'error' })
            .lintText(component, { filePath: 'C.azeroth' });
        const eqeqeq = result.messages.find(m => m.ruleId === 'eqeqeq');
        expect(eqeqeq).toBeDefined();
        expect(eqeqeq!.line).toBe(4);
    });

    it('applies auto-fixes inside markup, and the fixed source still compiles', async () =>
    {
        // The risk with a verbatim 1:1 block is a fix that lands in markup and
        // produces something the AzerothJS compiler rejects. Round-trip it: fix,
        // then compile, and assert both the fix landed and the result is valid.
        const component = `export default function Q()
{
    return <div class="x">{"a" == "b" ? "y" : "z"}</div>;
}
`;
        const [result] = await makeESLint({ quotes: ['error', 'single'], eqeqeq: 'error' }, true)
            .lintText(component, { filePath: 'Q.azeroth' });
        const fixed = result.output ?? component;
        // Fixes landed inside the markup hole (string quotes + strict equality);
        // the `class="x"` attribute value is left alone (quotes exempts JSX attrs).
        expect(fixed).toContain('\'a\' === \'b\'');
        expect(fixed).toContain('class="x"');
        // The auto-fixed component is still valid AzerothJS the compiler accepts.
        expect(() => compile(fixed)).not.toThrow();
    });

    it('recovers from a syntax error: reports it as fatal, never throws', async () =>
    {
        // Half-typed code must degrade like broken JS/TS - a fatal parse message,
        // not a crashed linter. (ESLint surfaces the parser throw per block.)
        const broken = `export default function Bad()
{
    const x = ;
    return <div>{x}</div>;
}
`;
        const [result] = await makeESLint().lintText(broken, { filePath: 'Broken.azeroth' });
        expect(result.messages.some(m => m.fatal)).toBe(true);
    });
});
