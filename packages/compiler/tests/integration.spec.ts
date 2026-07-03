// @vitest-environment node
//
// Full-pipeline integration: a realistic multi-construct component compiled
// end-to-end through the live pipeline (parse -> analyze -> lower -> optimize ->
// generateModule). Asserts the IR structure AND the emitted module's structure
// for a component using props, state, derived, effect, control flow, holes,
// attributes, and events. Real execution of the compiler itself - no mocks.
import { describe, it, expect } from 'vitest';
import { parseModule } from '@azerothjs/compiler';
import { analyzeComponent } from '../src/analyze.ts';
import { lowerComponent } from '../src/lower.ts';
import { optimize } from '../src/optimize.ts';
import { generateModule } from '../src/codegen.ts';
import type { ComponentDecl } from '@azerothjs/compiler';
import type { RenderPlan, ComponentBinding } from '../src/ir.ts';

const SOURCE = [
    'import { fetchUser } from \'./api\';',
    '',
    'component UserCard(props: { id: number; onClose: () => void }) {',
    '    state count = 0;',
    '    derived doubled = count * 2;',
    '    effect { console.log(\'count is\', count); }',
    '    const initial = count;',
    '    <div class="card" data-id={props.id}>',
    '        <h1>Count: {count}</h1>',
    '        <p>Doubled: {doubled}</p>',
    '        <Show when={count}>',
    '            <span>positive</span>',
    '        </Show>',
    '        <button onClick={() => count++}>inc</button>',
    '        <button onClick={props.onClose}>close</button>',
    '    </div>',
    '}'
].join('\n');

describe('integration - parse + analyze', () =>
{
    it('parses the component body into the expected item kinds', () =>
    {
        const c = parseModule(SOURCE).items.find(i => i.kind === 'component') as ComponentDecl;
        expect(c.name).toBe('UserCard');
        expect(c.body.map(b => b.kind)).toEqual([
            'state', 'derived', 'effect', 'opaque-statements', 'markup'
        ]);
    });

    it('analysis sees props + sources and wires each reactive scope to its deps', () =>
    {
        const c = parseModule(SOURCE).items.find(i => i.kind === 'component') as ComponentDecl;
        const analysis = analyzeComponent(SOURCE, c);
        expect(analysis.hasProps).toBe(true);
        expect(analysis.sources.map(s => s.name).sort()).toEqual(['count', 'doubled']);

        const derived = analysis.scopes.find(s => s.origin === 'derived');
        expect(derived!.deps).toEqual([{ kind: 'source', name: 'count' }]);

        const effect = analysis.scopes.find(s => s.origin === 'effect');
        expect(effect!.deps).toEqual([{ kind: 'source', name: 'count' }]);
        expect(effect!.pure).toBe(false);
    });
});

describe('integration - lower + optimize (IR)', () =>
{
    it('produces an element-rooted plan with text holes, a slot, attribute and event bindings', () =>
    {
        const c = parseModule(SOURCE).items.find(i => i.kind === 'component') as ComponentDecl;
        const plan = optimize(SOURCE, lowerComponent(SOURCE, c, analyzeComponent(SOURCE, c)) as RenderPlan);

        expect(plan.template.kind).toBe('element');

        const kinds = plan.bindings.map(b => b.kind).sort();
        // Two text holes (count, doubled), one attribute (data-id), two events,
        // one component (Show).
        expect(kinds).toContain('text');
        expect(kinds).toContain('attribute');
        expect(kinds).toContain('event');
        expect(kinds).toContain('component');

        const texts = plan.bindings.filter(b => b.kind === 'text');
        expect(texts).toHaveLength(2);
        // Each text hole reads count (count and doubled both ultimately reactive).
        for (const t of texts)
        {
            expect((t as { expr: { deps: unknown[] } }).expr.deps.length).toBeGreaterThan(0);
        }

        const show = plan.bindings.find(b => b.kind === 'component') as ComponentBinding;
        expect(show.tag).toBe('Show');
        expect(show.builtin).toBe(true);
        const whenProp = show.props.find(p => p.kind === 'prop' && p.name === 'when');
        expect((whenProp as { expr: { deps: unknown[] } }).expr.deps).toEqual([{ kind: 'source', name: 'count' }]);
    });
});

describe('integration - generateModule (emitted JS)', () =>
{
    const code = generateModule(SOURCE, 'UserCard.azeroth').code;

    it('preserves the opaque import and emits the factory', () =>
    {
        expect(code).toContain('import { fetchUser } from \'./api\';');
        expect(code).toContain('function UserCard(props)');
    });

    it('desugars all reactive constructs', () =>
    {
        expect(code).toContain('const [count, setCount] = createSignal(0);');
        expect(code).toContain('const doubled = createMemo(() => (count() * 2));');
        expect(code).toContain('createEffect(() => { console.log(\'count is\', count()); });');
        // The opaque setup statement is rewritten (read -> getter).
        expect(code).toContain('const initial = count();');
    });

    it('emits the mode-dispatched unified body with a hoisted template', () =>
    {
        expect(code).toContain('if (isStringMode() || isHydrating())');
        expect(code).toMatch(/const _tmpl\$1 = tmpl\(/);
        expect(code).toMatch(/const _r = _tmpl\$1\(\);/);
        expect(code).toContain('return _r;');
    });

    it('wires holes, the data-id attribute, the Show slot, and events', () =>
    {
        expect(code).toContain('bindHole(');
        expect(code).toContain('bindSlot(');
        expect(code).toMatch(/setProp\(_n\d+, 'data-id'/);
        // The valid handler (props.onClose) is passed as a function reference.
        expect(code).toMatch(/addEventListener\('click', props\.onClose\)/);
    });

    it('imports exactly the runtime helpers the emitted code uses', () =>
    {
        const importLine = code.split('\n').find(l => l.startsWith('import { ') && l.includes('azerothjs'))!;
        for (const name of ['createSignal', 'createMemo', 'createEffect', 'isStringMode', 'isHydrating', 'Show', 'bindHole', 'bindSlot', 'setProp', 'tmpl'])
        {
            expect(importLine).toContain(name);
        }
    });

    it('emits a non-empty v3 source map referencing the filename', () =>
    {
        const result = generateModule(SOURCE, 'UserCard.azeroth');
        expect(result.map!.version).toBe(3);
        expect(result.map!.sources).toEqual(['UserCard.azeroth']);
        expect(result.map!.mappings.length).toBeGreaterThan(0);
    });
});
