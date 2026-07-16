// @vitest-environment node
//
// The keyword DRIFT guard. Three emitters lower the reactive keywords - codegen (runtime JS),
// the projection (type-facing TS), and the nested-scope lowerer - and the shared tables in
// keyword-spec.ts are what keep them agreeing. This spec pins the agreement END TO END: one
// fixture exercises EVERY construct kind, and the assertions are driven by the tables
// themselves (RUNTIME_FN / PROJECTION_STYLE), so:
//   - adding a keyword to RUNTIME_FN without teaching the fixture (and thus every emitter) FAILS;
//   - changing a kind's projection shape without updating PROJECTION_STYLE FAILS;
//   - the two watch-dependency splitters can never disagree again (one implementation, pinned
//     here on the regex-literal case that used to differ).
import { describe, it, expect } from 'vitest';
import { generateVirtualCode } from '@azerothjs/compiler';
import { generateModule } from '../src/codegen.ts';
import { RUNTIME_FN, RUNTIME_FN_FIELD_ARRAY, PROJECTION_STYLE, DECLARATION_KEYWORDS, type ConstructKind } from '../src/keyword-spec.ts';
import { splitTopLevelCommas, splitTopLevelCommaSpans } from '../src/lower-reactive.ts';

// One component exercising every ConstructKind (plus the array form and a nested keyword).
const FIXTURE = `component Drift
{
    state count: number = 0;
    derived doubled = count * 2;
    deferred slow = count * 3;
    resource user = () => fetchUser();
    stream feed = () => open() with { source: count };
    store cart = { items: [] as number[] };
    selector active = count;
    form signUp = { name: '' } with { onSubmit: (values) => console.log(values) };
    form rows[] = { title: '' };
    effect {
        state clicks = 0;
        batch { clicks = count; }
        console.log(clicks);
    }
    effect (String(count).match(/a,b/), count) { console.log(count); }
    <p>{ count }</p>
}`;

const generated = generateModule(FIXTURE).code;
const projected = generateVirtualCode(FIXTURE).code;

/** The token proving a runtime helper was emitted (the bare name `on` needs its call shape). */
function callToken(fn: string): string
{
    return fn === 'on' ? 'on([' : `${ fn }(`;
}

describe('keyword drift guard', () =>
{
    it('codegen emits every runtime helper in RUNTIME_FN (completeness is table-driven)', () =>
    {
        for (const fn of Object.values(RUNTIME_FN))
        {
            expect(generated, `codegen must emit ${ fn } for its keyword`).toContain(callToken(fn));
        }
        expect(generated).toContain(`${ RUNTIME_FN_FIELD_ARRAY }(`);
    });

    it('the nested-scope lowerer handles keywords inside a reactive body', () =>
    {
        // Top-level `state count: number` (emits `createSignal<number>(`) plus the nested
        // `state clicks` inside the effect (emits `createSignal(`) - count the helper NAME so
        // the type argument on the typed form is included.
        const signalCalls = generated.split(RUNTIME_FN.state).length - 1;
        expect(signalCalls).toBeGreaterThanOrEqual(2);
        // The wrapper block lowered to its own runtime call.
        expect(generated).toContain('batch(');
    });

    it('the projection encodes each kind exactly as PROJECTION_STYLE declares', () =>
    {
        const proofs: Record<(typeof PROJECTION_STYLE)[ConstructKind], () => void> =
        {
            'value-let-cast': () =>
            {
                expect(projected).toContain('let count');
                expect(projected).toContain('as number');
            },
            'value-const': () =>
            {
                expect(projected).toContain('const doubled');
                expect(projected).toContain('const slow');
            },
            'real-call': () =>
            {
                expect(projected).toContain('createResource(');
                expect(projected).toContain('createStream(');
                expect(projected).toContain('createStore(');
                expect(projected).toContain('createSelector(');
                expect(projected).toContain('on([');
            },
            'api-and-fields': () =>
            {
                expect(projected).toContain('Object.assign(createForm(');
                expect(projected).toContain('__azRowForm(createFieldArray(');
            },
            'void-arrow': () =>
            {
                expect(projected).toContain('void (() => {');
            }
        };
        for (const kind of Object.keys(PROJECTION_STYLE) as ConstructKind[])
        {
            proofs[PROJECTION_STYLE[kind]]();
        }
    });

    it('PROJECTION_STYLE and RUNTIME_FN cover the same keyword universe', () =>
    {
        const styled = new Set(Object.keys(PROJECTION_STYLE));
        for (const kind of Object.keys(RUNTIME_FN))
        {
            expect(styled.has(kind), `PROJECTION_STYLE must declare a shape for '${ kind }'`).toBe(true);
        }
        // Every declaration keyword is styled too (the parser set and the emitters agree).
        for (const word of DECLARATION_KEYWORDS)
        {
            expect(styled.has(word), `PROJECTION_STYLE must declare a shape for '${ word }'`).toBe(true);
        }
    });

    it('watch dependencies split identically for codegen and the projection (regex commas included)', () =>
    {
        const deps = 'String(count).match(/a,b/), count';
        const parts = splitTopLevelCommas(deps);
        const spans = splitTopLevelCommaSpans(deps, 0, deps.length).map((span) => deps.slice(span.start, span.end));
        expect(parts).toEqual(['String(count).match(/a,b/)', 'count']);
        expect(spans).toEqual(parts);

        // Comments, templates, and nesting are equally invisible to both forms.
        const tricky = 'a /* x,y */, tag`v${ b, c }`, [d, e]';
        expect(splitTopLevelCommas(tricky)).toEqual(splitTopLevelCommaSpans(tricky, 0, tricky.length).map((span) => tricky.slice(span.start, span.end)));
        expect(splitTopLevelCommas(tricky)).toHaveLength(3);

        // And the emitters both saw TWO watch deps in the fixture.
        expect(generated).toMatch(/on\(\[\(\) => \(.*\), \(\) => \(.*\)\]/);
        const projectedWatch = projected.slice(projected.indexOf('on(['));
        expect(projectedWatch.slice(0, projectedWatch.indexOf(']'))).toContain(', () => (');
    });
});
