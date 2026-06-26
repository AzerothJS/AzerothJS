// @vitest-environment node
//
// The definitive matrix for component PARAMETERS. A component parameter is ordinary TypeScript, so every
// natural function-parameter form must work identically end-to-end with no Azeroth-specific rules:
//   1. named + interface              component Button(props: ButtonProps)
//   2. destructured + interface       component Button({ variant, size }: ButtonProps)
//   3. destructured + defaults        component Button({ variant = "primary", size = "md" }: ButtonProps)
//   4. inline object type             component Button(props: { variant?: string; size?: string })
//   5. inline type + destructuring    component Button({ variant, size }: { variant?: string; size?: string })
//   6. inline type + destructure+def  component Button({ variant = "primary", ... }: { variant?: string; ... })
//
// This locks the three guarantees the spec calls out: inline object types and named interfaces behave
// IDENTICALLY; default values keep their runtime semantics (`?? default`); and destructuring keeps the
// projection binding (so types/hover/rename work) while the runtime rewrites to reactive `props.<name>`.
import { describe, it, expect } from 'vitest';
import { generateVirtualCode } from '@azerothjs/compiler';
import { generateModule } from '../src/codegen.ts';
import { parseModule } from '../src/parser.ts';
import { parseComponentParam } from '../src/ts-slice.ts';
import type { ComponentDecl } from '@azerothjs/compiler';

const project = (src: string): string => generateVirtualCode(src).code;
const gen = (src: string): string => generateModule(src).code;

/** Runs the parser then the TS-based parameter split, returning the recovered type/pattern text. */
function split(src: string): { type: string | null; pattern: string | null }
{
    const c = parseModule(src).items.find(i => i.kind === 'component') as ComponentDecl;
    const param = c.propsParam
        ? parseComponentParam(src.slice(c.propsParam.start, c.propsParam.end), c.propsParam.start)
        : { typeSpan: null, patternSpan: null };
    return {
        type: param.typeSpan ? src.slice(param.typeSpan.start, param.typeSpan.end) : null,
        pattern: param.patternSpan ? src.slice(param.patternSpan.start, param.patternSpan.end) : null
    };
}

const FORM = {
    named: 'interface BP { variant?: string; size?: string; }\ncomponent Button(props: BP) { <button class={props.variant}>{props.size}</button> }',
    destructuredNamed: 'interface BP { variant?: string; size?: string; }\ncomponent Button({ variant, size }: BP) { <button class={variant}>{size}</button> }',
    destructuredDefaults: 'interface BP { variant?: string; size?: string; }\ncomponent Button({ variant = "primary", size = "md" }: BP) { <button class={variant}>{size}</button> }',
    inline: 'component Button(props: { variant?: string; size?: string }) { <button class={props.variant}>{props.size}</button> }',
    inlineDestructured: 'component Button({ variant, size }: { variant?: string; size?: string }) { <button class={variant}>{size}</button> }',
    inlineDestructuredDefaults: 'component Button({ variant = "primary", size = "md" }: { variant?: string; size?: string }) { <button class={variant}>{size}</button> }'
};

describe('component params - parser split (standard TS, no special rules)', () =>
{
    it('1. named + interface: type only, no pattern', () =>
    {
        expect(split(FORM.named)).toEqual({ type: 'BP', pattern: null });
    });

    it('2. destructured + interface: both type and pattern', () =>
    {
        expect(split(FORM.destructuredNamed)).toEqual({ type: 'BP', pattern: '{ variant, size }' });
    });

    it('3. destructured + defaults: the defaults stay inside the pattern', () =>
    {
        expect(split(FORM.destructuredDefaults)).toEqual({ type: 'BP', pattern: '{ variant = "primary", size = "md" }' });
    });

    it('4. inline object type: the whole object type is the annotation', () =>
    {
        expect(split(FORM.inline)).toEqual({ type: '{ variant?: string; size?: string }', pattern: null });
    });

    it('5. inline type + destructuring: pattern plus inline type', () =>
    {
        expect(split(FORM.inlineDestructured)).toEqual({ type: '{ variant?: string; size?: string }', pattern: '{ variant, size }' });
    });

    it('6. inline type + destructuring + defaults', () =>
    {
        expect(split(FORM.inlineDestructuredDefaults)).toEqual({ type: '{ variant?: string; size?: string }', pattern: '{ variant = "primary", size = "md" }' });
    });

    it('a renaming destructure is not mistaken for the type separator', () =>
    {
        const src = 'component C({ a: local }: { a: number }) { <p>{local}</p> }';
        expect(split(src)).toEqual({ type: '{ a: number }', pattern: '{ a: local }' });
    });

    it('a default object literal in the pattern does not confuse the type split', () =>
    {
        const src = 'component C({ opts = { x: 1 } }: { opts?: { x: number } }) { <p>{opts.x}</p> }';
        expect(split(src)).toEqual({ type: '{ opts?: { x: number } }', pattern: '{ opts = { x: 1 } }' });
    });
});

describe('component params - projection (named interface == inline object type)', () =>
{
    it('all forms project to a single DEFAULTED `props` parameter', () =>
    {
        for (const src of Object.values(FORM))
        {
            expect(project(src)).toMatch(/function Button\(props: .+ = \(undefined as unknown as .+\)\) \{/);
        }
    });

    it('every destructuring form projects a `const { ... } = props;` typing binding', () =>
    {
        expect(project(FORM.destructuredNamed)).toContain('const { variant, size } = props;');
        expect(project(FORM.destructuredDefaults)).toContain('const { variant = "primary", size = "md" } = props;');
        expect(project(FORM.inlineDestructured)).toContain('const { variant, size } = props;');
        expect(project(FORM.inlineDestructuredDefaults)).toContain('const { variant = "primary", size = "md" } = props;');
    });

    it('a non-destructuring form projects NO binding statement', () =>
    {
        expect(project(FORM.named)).not.toContain('= props;');
        expect(project(FORM.inline)).not.toContain('= props;');
    });

    it('inline object type and named interface differ ONLY in the type text', () =>
    {
        const named = project(FORM.named).replace(/: BP\b/g, ': T').replace(/as BP\b/g, 'as T');
        const inline = project(FORM.inline)
            .replace(/: \{ variant\?: string; size\?: string \}/g, ': T')
            .replace(/as \{ variant\?: string; size\?: string \}/g, 'as T');
        // The named form carries an extra `interface BP {...}` line; compare just the function body.
        const body = (code: string): string => code.slice(code.indexOf('function Button'));
        expect(body(inline)).toBe(body(named));
    });
});

describe('component params - codegen runtime semantics', () =>
{
    it('the runtime function ALWAYS takes a single `props` object (no destructuring at runtime)', () =>
    {
        for (const src of Object.values(FORM))
        {
            expect(gen(src)).toContain('function Button(props)');
        }
    });

    it('destructured names rewrite to reactive `props.<name>` reads (no snapshot binding)', () =>
    {
        for (const src of [FORM.destructuredNamed, FORM.inlineDestructured])
        {
            const code = gen(src);
            expect(code).toContain('props.variant');
            expect(code).toContain('props.size');
            // A `const { ... } = props` snapshot would lose reactivity - it must NOT be emitted.
            expect(code).not.toContain('= props;');
        }
    });

    it('defaults preserve runtime semantics: `props.<name> ?? <default>`', () =>
    {
        for (const src of [FORM.destructuredDefaults, FORM.inlineDestructuredDefaults])
        {
            const code = gen(src);
            expect(code).toContain('(props.variant ?? "primary")');
            expect(code).toContain('(props.size ?? "md")');
        }
    });

    it('inline object type and named interface produce IDENTICAL runtime functions', () =>
    {
        // The named form carries an extra `interface BP {...}` line; the generated FUNCTION is identical.
        const fn = (code: string): string => code.slice(code.indexOf('function Button'));
        expect(fn(gen(FORM.inline))).toBe(fn(gen(FORM.named)));
        expect(fn(gen(FORM.inlineDestructured))).toBe(fn(gen(FORM.destructuredNamed)));
        expect(fn(gen(FORM.inlineDestructuredDefaults))).toBe(fn(gen(FORM.destructuredDefaults)));
    });
});
