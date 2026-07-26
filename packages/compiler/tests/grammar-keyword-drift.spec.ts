// @vitest-environment node
//
// Welds the editor grammars' keyword lists to the compiler's canonical tables. The TextMate
// grammar (JSON) and the JetBrains lexer (Kotlin) cannot import keyword-spec.ts, so this test
// is what keeps them in sync: it fails if a grammar is missing a keyword the compiler defines,
// or carries a keyword the compiler does not (a stale entry), and if the TextMate builtin list
// diverges from the compiler's built-in components.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { RUNTIME_FN, WRAPPER_FN, DECLARATION_KEYWORDS, BUILTIN_COMPONENTS } from '@azerothjs/compiler';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmGrammar = readFileSync(path.join(here, '..', 'syntaxes', 'azeroth.tmLanguage.json'), 'utf8');
const jetbrainsLexer = readFileSync(
    path.join(repoRoot, 'editors', 'jetbrains', 'src', 'main', 'kotlin', 'com', 'azerothjs', 'lang', 'AzerothLexer.kt'),
    'utf8'
);

// The authoring keywords a `.azeroth` grammar must colour: the declaration keywords, `component`,
// the two `effect` forms (the RUNTIME_FN `watch` kind is the `effect (deps)` form - still `effect`),
// the `with` options clause, and the wrapper blocks. Built-in components are NOT here: the JetBrains
// lexer leaves them to the LSP, and the TextMate grammar colours them by a separate rule (checked below).
const AUTHORING_KEYWORDS = new Set<string>([
    ...DECLARATION_KEYWORDS,
    'component',
    'effect',
    'with',
    ...Object.keys(WRAPPER_FN)
]);

/** Every `\b(a|b|c)\b`-style lowercase alternation group across the grammar's keyword match rules. */
function tmLowercaseKeywords(): Set<string>
{
    const words = new Set<string>();
    for (const match of tmGrammar.matchAll(/\(([a-z][a-z|]*[a-z])\)/g))
    {
        for (const word of (match[1] ?? '').split('|'))
        {
            words.add(word);
        }
    }
    return words;
}

/** The capitalized alternation group (the built-in components) in the grammar's tag rule. */
function tmBuiltins(): Set<string>
{
    const match = tmGrammar.match(/\(([A-Z][A-Za-z]+(?:\|[A-Z][A-Za-z]+)+)\)/);
    return new Set(match?.[1] ? match[1].split('|') : []);
}

/** The AzerothJS authoring-keyword string literals from the lexer's KEYWORDS set. */
function jetbrainsAuthoringKeywords(): Set<string>
{
    // The keyword strings sit between the end of the block comment introducing them and the
    // closing `)` of the set; anchor on the comment's last line so a `)` inside the comment
    // prose is not mistaken for the set's close.
    const anchor = jetbrainsLexer.indexOf('mirroring the VS Code TextMate grammar');
    const afterComment = jetbrainsLexer.indexOf('\n', anchor);
    const block = jetbrainsLexer.slice(afterComment, jetbrainsLexer.indexOf(')', afterComment));
    const words = [...block.matchAll(/"([a-z]+)"/g)].flatMap((m) => (m[1] !== undefined ? [m[1]] : []));
    return new Set(words);
}

describe('editor grammar keyword drift', () =>
{
    it('the TextMate grammar colours every authoring keyword', () =>
    {
        const tm = tmLowercaseKeywords();
        for (const keyword of AUTHORING_KEYWORDS)
        {
            expect(tm.has(keyword), `TextMate grammar is missing the keyword '${ keyword }'`).toBe(true);
        }
    });

    it('the JetBrains lexer lists EXACTLY the authoring keywords (no missing, no stale)', () =>
    {
        const jb = jetbrainsAuthoringKeywords();
        expect([...jb].sort()).toEqual([...AUTHORING_KEYWORDS].sort());
    });

    it('the TextMate grammar colours every built-in component', () =>
    {
        const tm = tmBuiltins();
        for (const name of BUILTIN_COMPONENTS)
        {
            expect(tm.has(name), `TextMate grammar is missing the built-in '${ name }'`).toBe(true);
        }
    });

    it('the RUNTIME_FN reactive keywords are all authoring keywords (no keyword ships uncoloured)', () =>
    {
        // `watch` is the `effect (deps)` construct - its surface keyword is `effect`, already covered.
        for (const kind of Object.keys(RUNTIME_FN))
        {
            const surface = kind === 'watch' ? 'effect' : kind;
            expect(AUTHORING_KEYWORDS.has(surface), `RUNTIME_FN kind '${ kind }' has no grammar keyword`).toBe(true);
        }
    });
});
