// @vitest-environment node
//
// The two editor artifacts that CANNOT import the semantics module - the TextMate grammar
// (regex source) and the JetBrains Kotlin handler - carry guarded copies of language facts.
// This spec is the guard: it re-reads both files and fails the moment a copy drifts from
// `azerothjs/semantics`, so "do not copy tables" holds in spirit where it cannot hold in code.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hostEventType, VOID_ELEMENTS, BUILTIN_COMPONENTS } from 'azerothjs/semantics';

const here = path.dirname(fileURLToPath(import.meta.url));
const grammar = readFileSync(path.join(here, '..', 'syntaxes', 'azeroth.tmLanguage.json'), 'utf8');
const kotlinHandler = readFileSync(
    path.join(here, '..', '..', '..', 'editors', 'jetbrains', 'src', 'main', 'kotlin', 'com', 'azerothjs', 'AzerothTypedHandler.kt'),
    'utf8');

describe('TextMate grammar agrees with the semantics vocabulary', () =>
{
    it('the builtin-component alternation is exactly BUILTIN_COMPONENTS', () =>
    {
        const match = /\(<\)\(([A-Za-z|]+)\)\\\\b/.exec(grammar);
        expect(match).not.toBeNull();
        expect(match![1]!.split('|')).toEqual([...BUILTIN_COMPONENTS]);
    });

    it('every name the event pattern highlights IS handler-form under the classifier', () =>
    {
        // The grammar pattern is \b(on[A-Z][\w]*)(?=\s*=). It may highlight LESS than the
        // classifier accepts (regex has no case tables), but it must never highlight a name
        // the language does not treat as an event.
        expect(grammar).toContain('on[A-Z][\\\\w]*');
        for (const sample of ['onClick', 'onX2Y', 'onMarketResolved'])
        {
            expect(hostEventType(sample)).not.toBeNull();
        }
    });
});

describe('JetBrains handler agrees with the semantics vocabulary', () =>
{
    it('its VOID_ELEMENTS set is exactly the semantics set', () =>
    {
        const block = /VOID_ELEMENTS = setOf\(([^)]*)\)/.exec(kotlinHandler);
        expect(block).not.toBeNull();
        const listed = [...block![1]!.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
        expect(new Set(listed)).toEqual(new Set(VOID_ELEMENTS));
        expect(listed).toHaveLength(VOID_ELEMENTS.size);
    });
});
