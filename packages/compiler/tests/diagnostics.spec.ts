// @vitest-environment node
//
// Real-execution coverage for diagnoseModule: each semantic diagnostic code -
// constant-derived, inert-effect, self-write-in-effect, handler-not-function -
// plus the deliberate non-finding cases (handler factory with args, reactive
// derived/effect).
import { describe, it, expect } from 'vitest';
import { diagnoseModule, diagnoseUnusedImports } from '@azerothjs/compiler';
import type { AzerothDiagnostic } from '@azerothjs/compiler';
import { generateModule } from '../src/codegen.ts';

function codes(src: string): string[]
{
    return diagnoseModule(src).map(d => d.code);
}

/** Compiles `src` then reports the unused-import names (the diagnostic needs the compiled JS). */
function unused(src: string): string[]
{
    return diagnoseUnusedImports(src, generateModule(src).code).map(d => d.message);
}

function find(src: string, code: string): AzerothDiagnostic | undefined
{
    return diagnoseModule(src).find(d => d.code === code);
}

describe('diagnoseUnusedImports', () =>
{
    it('flags an imported value that is never used', () =>
    {
        const out = unused('import { Show, Unused } from \'azerothjs\';\ncomponent C { state n = 0; <div><Show when={n}><p>x</p></Show></div> }');
        expect(out).toEqual(['`Unused` is imported but never used - remove the import.']);
    });

    it('does NOT flag a type-only import used in a props annotation', () =>
    {
        // The compiled JS drops type usages; the source cross-check keeps it.
        expect(unused('import type { IconNode } from \'lucide\';\ncomponent C(props: { icon: IconNode }) { <p>x</p> }')).toEqual([]);
    });

    it('does NOT flag a component used only in markup', () =>
    {
        expect(unused('import { Spinner } from \'./ui\';\ncomponent C { <div><Spinner /></div> }')).toEqual([]);
    });

    it('does NOT flag a helper used only in an attribute value', () =>
    {
        expect(unused('import { cn } from \'./cn\';\ncomponent C { <div class={cn("a")}>x</div> }')).toEqual([]);
    });

    it('reports the local alias name for an unused aliased import', () =>
    {
        expect(unused('import { foo as bar } from \'./x\';\ncomponent C { <p>hi</p> }')).toEqual(['`bar` is imported but never used - remove the import.']);
    });

    it('it is a warning located at the unused name', () =>
    {
        const src = 'import { Gone } from \'./x\';\ncomponent C { <p>hi</p> }';
        const diag = diagnoseUnusedImports(src, generateModule(src).code);
        expect(diag[0].severity).toBe('warning');
        expect(diag[0].code).toBe('azeroth/unused-import');
        expect(src.slice(diag[0].start, diag[0].end)).toBe('Gone');
    });
});

describe('diagnoseModule - constant-derived', () =>
{
    it('flags a derived that reads no reactive source', () =>
    {
        const diag = find('component C { derived d = 1 + 2; <p>{d}</p> }', 'azeroth/constant-derived');
        expect(diag).toBeDefined();
        expect(diag!.severity).toBe('warning');
        expect(diag!.message).toContain('derived d');
    });

    it('does not flag a derived that reads a source', () =>
    {
        expect(codes('component C { state n = 0; derived d = n + 1; <p>{d}</p> }')).not.toContain('azeroth/constant-derived');
    });

    it('does not flag a derived whose initializer contains a call (it may read a store accessor)', () =>
    {
        // `router.location()` is an external reactive source the dependency analysis cannot see;
        // warning here would suggest "use a plain value", which would silently break reactivity.
        expect(codes('component C { derived d = router.location().pathname; <p>{d}</p> }')).not.toContain('azeroth/constant-derived');
    });
});

describe('diagnoseModule - inert-effect', () =>
{
    it('flags an effect that reads no reactive source and has no calls/side effects', () =>
    {
        const diag = find('component C { effect { const x = 1 + 2; } <p>x</p> }', 'azeroth/inert-effect');
        expect(diag).toBeDefined();
        expect(diag!.severity).toBe('warning');
    });

    it('does not flag an effect that reads a source', () =>
    {
        expect(codes('component C { state n = 0; effect { console.log(n); } <p>{n}</p> }')).not.toContain('azeroth/inert-effect');
    });

    it('does not flag an effect whose body contains a call (it may read a store accessor)', () =>
    {
        // A call may read an external reactive source (e.g. a store) the analysis cannot see, or do
        // legitimate one-time setup (the `effect`-as-onMount idiom) - warning would be a false positive.
        expect(codes('component C { effect { setSeo({ title: "X" }); } <p>x</p> }')).not.toContain('azeroth/inert-effect');
    });
});

describe('diagnoseModule - self-write-in-effect', () =>
{
    it('flags an effect that both reads and assigns the same state', () =>
    {
        const diag = find('component C { state n = 0; effect { n = n + 1; } <p>{n}</p> }', 'azeroth/self-write-in-effect');
        expect(diag).toBeDefined();
        expect(diag!.severity).toBe('warning');
        expect(diag!.message).toContain('`n`');
    });

    it('does not flag an effect that writes a DIFFERENT state than it reads', () =>
    {
        const src = 'component C { state a = 0; state b = 0; effect { b = a + 1; } <p>{b}</p> }';
        expect(codes(src)).not.toContain('azeroth/self-write-in-effect');
    });

    it('flags `++`/`--` and compound self-updates (they read the target before writing)', () =>
    {
        expect(codes('component C { state n = 0; effect { n++; } <p>{n}</p> }')).toContain('azeroth/self-write-in-effect');
        expect(codes('component C { state n = 0; effect { n += 1; } <p>{n}</p> }')).toContain('azeroth/self-write-in-effect');
    });

    it('does NOT flag the clamp idiom: state read only in the GUARD, written from another source', () =>
    {
        // `page = totalPages` writes from a DIFFERENT source; `page` appears only in the condition, so
        // the write converges (stops once page <= totalPages) rather than looping.
        const src = 'component C { state page = 1; derived totalPages = 5; effect { if (page > totalPages) page = totalPages; } <p>{page}</p> }';
        expect(codes(src)).not.toContain('azeroth/self-write-in-effect');
    });
});

describe('diagnoseModule - handler-not-function', () =>
{
    it('flags a zero-arg call handler that runs at setup', () =>
    {
        const diag = find('component C { <button onClick={save()}>x</button> }', 'azeroth/handler-not-function');
        expect(diag).toBeDefined();
        expect(diag!.severity).toBe('error');
        expect(diag!.message).toContain('must be a function');
    });

    it('flags an assignment handler', () =>
    {
        expect(codes('component C { state n = 0; <button onClick={n = 1}>x</button> }')).toContain('azeroth/handler-not-function');
    });

    it('flags a ++/-- handler', () =>
    {
        expect(codes('component C { state n = 0; <button onClick={n++}>x</button> }')).toContain('azeroth/handler-not-function');
    });

    it('does NOT flag a handler-factory call WITH arguments', () =>
    {
        // onClick={makeHandler(id)} is the factory idiom - intentionally allowed.
        expect(codes('component C { <button onClick={makeHandler(id)}>x</button> }')).not.toContain('azeroth/handler-not-function');
    });

    it('does NOT flag a bare function-reference handler', () =>
    {
        expect(codes('component C { <button onClick={save}>x</button> }')).not.toContain('azeroth/handler-not-function');
    });

    it('does NOT flag an arrow-function handler', () =>
    {
        expect(codes('component C { state n = 0; <button onClick={() => n++}>x</button> }')).not.toContain('azeroth/handler-not-function');
    });
});

describe('diagnoseModule - module-level', () =>
{
    it('returns an empty array for a module with no component', () =>
    {
        expect(diagnoseModule('const x = 1;')).toEqual([]);
    });

    it('every diagnostic carries a source span within the source', () =>
    {
        const src = 'component C { derived d = 1 + 2; <p>{d}</p> }';
        for (const diag of diagnoseModule(src))
        {
            expect(diag.start).toBeGreaterThanOrEqual(0);
            expect(diag.end).toBeGreaterThan(diag.start);
            expect(diag.end).toBeLessThanOrEqual(src.length);
        }
    });
});
