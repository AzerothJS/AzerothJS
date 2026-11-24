/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import * as ts from 'typescript';
import { rewritePropDefault } from './rewrite.ts';
import { parsePropsPattern } from './ts-slice.ts';
import { isPropDefaultWrite } from './prop-default-write.ts';
import type { Span } from './types.ts';
import type { ComponentDecl } from './ast.ts';

interface PropPattern
{
    propReceiver: string;
    propAliases: Map<string, string>;
    propCaptures: Map<string, string>;
    propDefaultWrites: Array<Span & { name: string }>;
}

/** Choose local names that cannot shadow authored spellings, including Unicode escapes. */
export function componentPropNames(source: string, component: ComponentDecl): { propReceiver: string; fresh: (stem: string) => string }
{
    const authored = source.slice(component.start, component.end).replace(/\\u(?:\{([\da-f]+)\}|([\da-f]{4}))/gi,
        (spelling: string, braced: string | undefined, fixed: string | undefined): string =>
        {
            const value = Number.parseInt(braced ?? fixed ?? '', 16);
            return value <= 127 ? String.fromCharCode(value) : spelling;
        });
    const next = new Map<string, number>();
    const fresh = (stem: string): string =>
    {
        let count = next.get(stem) ?? 0;
        let name: string;
        do
        {
            name = count === 0 ? stem : stem + String(count);
            count++;
        } while (authored.includes(name));
        next.set(stem, count);
        return name;
    };

    return { propReceiver: /\bprops\b/.test(authored) ? fresh('__azProps') : 'props', fresh };
}

/** Defaults live in the parameter environment, outside the component body and its row callbacks. */
export function componentPropAliases(source: string, component: ComponentDecl, pattern: Span): PropPattern
{
    const { propReceiver, fresh } = componentPropNames(source, component);
    const propCaptures = new Map<string, string>();
    const propDefaultWrites: PropPattern['propDefaultWrites'] = [];
    const defaults: Array<{ name: string; raw: string; earlier: number; start: number }> = [];
    function containsName(node: ts.Node): boolean
    {
        return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword
            || ts.forEachChild(node, child => containsName(child) || undefined) === true;
    }

    // First assign the spelling of every alias, without expanding its initializer into its users.
    const propAliases = parsePropsPattern(source.slice(pattern.start, pattern.end), propReceiver, (expr, earlier, offset) =>
    {
        const raw = expr.getText();
        if (!containsName(expr))
        {
            return raw;
        }
        const name = fresh('__azDefault');
        defaults.push({ name, raw, earlier, start: pattern.start + offset });
        return name + '()';
    });
    const bindings = new Map<string, { read: string; order: number; reader?: string; usedEarly?: boolean }>(
        Array.from(propAliases, ([name, read], order) => [name, { read, order }]));
    const lowered = defaults.map(fallback =>
    {
        const expression = rewritePropDefault(fallback.raw, propAliases, id =>
        {
            const binding = bindings.get(id.text);
            if (!binding)
            {
                return id.getText();
            }
            if (isPropDefaultWrite(id))
            {
                // The expression parser surrounds this source slice with one opening parenthesis.
                propDefaultWrites.push({ name: id.text, start: fallback.start + id.getStart() - 1, end: fallback.start + id.end - 1 });
                return id.getText();
            }
            binding.usedEarly ||= binding.order >= fallback.earlier;
            binding.reader ??= fresh('__azRead');
            // Read the value of a sibling without making the props object its call receiver.
            // Parentheses preserve the binding of new, optional calls and tagged templates.
            return `(${ binding.reader }())`;
        });
        return { ...fallback, expression };
    });

    // A later property is unavailable while any earlier initializer is evaluating, even
    // when a previously returned closure performs the read. Ordinary backwards-only
    // patterns need no bookkeeping. The caller's binding owner tracks property access.
    const scope = Array.from(bindings.values()).some(binding => binding.usedEarly) ? fresh('__azParamScope') : undefined;
    if (scope)
    {
        propCaptures.set(scope, `{ before: ${ bindings.size } }`);
    }
    for (const { read, order, reader } of bindings.values())
    {
        if (reader)
        {
            const check = scope ? `if (${ scope }.before <= ${ order }) throw new globalThis.ReferenceError("Cannot access a prop before initialization"); ` : '';
            propCaptures.set(reader, `() => { ${ check }return (${ read }); }`);
        }
    }
    const previous = scope ? fresh('__azBefore') : '';
    for (const { name, earlier, expression } of lowered)
    {
        const expr = `(${ expression })`;
        if (scope)
        {
            propCaptures.set(name, `() => { const ${ previous } = ${ scope }.before; `
                + `if (${ previous } > ${ earlier }) ${ scope }.before = ${ earlier }; `
                + `try { return ${ expr }; } finally { ${ scope }.before = ${ previous }; } }`);
        }
        else
        {
            propCaptures.set(name, `() => ${ expr }`);
        }
    }
    return { propReceiver, propAliases, propCaptures, propDefaultWrites };
}
