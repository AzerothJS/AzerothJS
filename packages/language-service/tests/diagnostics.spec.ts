// @vitest-environment node
//
// The editor-facing diagnostics path (the LSP `getDiagnostics` provider) must surface the same
// handler-type error the azeroth-tsc gate enforces. A non-function `onClick={...}` projects to
// `(...) satisfies AzerothHandler<'onClick'>`, whose failure TypeScript reports on the generated
// `satisfies` keyword - pure scaffolding. The provider has to anchor that back to the handler
// value, otherwise the editor stays silent while CI fails. Regression guard for that asymmetry.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

/** Opens an in-memory `.azeroth` module in a fresh service and returns its diagnostics. */
function diagnose(name: string, source: string)
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, name)).href;
    service.didOpen(uri, source);
    return service.getDiagnostics(uri);
}

describe('LSP diagnostics: event handler type', () =>
{
    it('flags a non-function event handler, anchored to the handler value (not scaffolding)', () =>
    {
        const diagnostics = diagnose(
            'Bad.azeroth',
            'export default component Bad {\n    state n = 0;\n    <button onClick={n}>x</button>\n}\n'
        );
        const handler = diagnostics.find((d) => d.code === 1360);
        expect(handler, 'a non-function handler must surface in the editor').toBeDefined();
        expect(handler!.message).toContain('Event handler must be a function');
        // Anchored onto `n` in `onClick={n}` (the third line, 0-based 2), not generated code.
        expect(handler!.range.start.line).toBe(2);
    });

    it('leaves a valid function handler clean', () =>
    {
        const diagnostics = diagnose(
            'Good.azeroth',
            'export default component Good {\n    state n = 0;\n    <button onClick={() => { n = n + 1; }}>x</button>\n}\n'
        );
        expect(diagnostics.filter((d) => d.code === 1360)).toHaveLength(0);
    });
});

describe('LSP diagnostics: Show/Match narrowing', () =>
{
    const isNullish = (d: { message: string }): boolean => /possibly '?(null|undefined)/.test(d.message);

    it('surfaces a possibly-null access OUTSIDE a guard (control - proves the check is live)', () =>
    {
        const diagnostics = diagnose(
            'Unguarded.azeroth',
            'export default component Unguarded {\n    state user = null as ({ name: string } | null);\n    <p>{user.name}</p>\n}\n'
        );
        expect(diagnostics.some(isNullish), 'an unguarded nullable access must still error').toBe(true);
    });

    it('narrows a state guard inside <Show when> so the child needs no `!`', () =>
    {
        const diagnostics = diagnose(
            'ShowNarrow.azeroth',
            'export default component ShowNarrow {\n    state user = null as ({ name: string } | null);\n    <Show when={user}><p>{user.name}</p></Show>\n}\n'
        );
        expect(diagnostics.filter(isNullish)).toHaveLength(0);
    });

    it('narrows a state guard inside <Match when> the same way', () =>
    {
        const diagnostics = diagnose(
            'MatchNarrow.azeroth',
            'export default component MatchNarrow {\n    state user = null as ({ name: string } | null);\n    <Switch><Match when={user}><p>{user.name}</p></Match></Switch>\n}\n'
        );
        expect(diagnostics.filter(isNullish)).toHaveLength(0);
    });

    it('does not flag a function-typed when (the `when={thunk}` form) as an always-true condition', () =>
    {
        // `when` accepts `boolean | (() => boolean)`; the narrowing guard must not turn a thunk into a
        // TS2774 "this condition will always return true" false positive.
        const diagnostics = diagnose(
            'ThunkWhen.azeroth',
            'export default component ThunkWhen(props: { show: () => boolean }) {\n    <Show when={props.show}><p>hi</p></Show>\n}\n'
        );
        expect(diagnostics.filter((d) => d.code === 2774)).toHaveLength(0);
    });

    it('gives factory-prop function literals contextual parameter types (no implicit any)', () =>
    {
        // A function literal passed to a factory prop (ErrorBoundary's fallback) is the factory
        // itself; wrapped in the `() => (...)` value projection its params fell to implicit any
        // (TS7006) under a strict consumer tsconfig. The projection passes literals through.
        const diagnostics = diagnose(
            'Boundary.azeroth',
            "import { ErrorBoundary } from 'azerothjs';\n"
            + 'export default component Boundary {\n'
            + '    <ErrorBoundary fallback={(error, reset) => <button onClick={() => reset()}>retry</button>}>\n'
            + '        <p>content</p>\n'
            + '    </ErrorBoundary>\n'
            + '}\n'
        );
        expect(diagnostics.filter((d) => d.code === 7006)).toHaveLength(0);
    });
});
