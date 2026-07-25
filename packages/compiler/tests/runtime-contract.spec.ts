// @vitest-environment happy-dom
//
// The compiled-output runtime contract: generated code imports ONLY from
// 'azerothjs/internal', and every name it can emit exists there. This is the drift
// test that welds the compiler's emit vocabulary to the contract module - adding a
// keyword, builtin, or markup helper to the emitter without exporting it from
// azerothjs/internal fails HERE, not in a user's build.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as contract from 'azerothjs/internal';

// A kitchen-sink module exercising every keyword, every wrapper block, every builtin
// component, and both markup paths (template clone + hydrate/string h() branch).
const SINK = `
import Card from './Card.azeroth';
export default component Sink
{
    state n = 0;
    state txt: string = 'x' with { name: 'txt' };
    derived double = n * 2;
    deferred slow = txt with { delay: 100 };
    effect { console.log(double); }
    effect (n) { console.log('watch', n); }
    resource user = fetch('/u').then(r => r.json());
    stream ticks = new EventSource('/t') with { parse: 'sse' };
    selector picked = n;
    store settings = { theme: 'dark' };
    form login = { email: '' };
    form rows[] = [{ q: 1 }];
    batch { n = 1; }
    untrack { console.log(n); }
    cleanup { console.log('bye'); }
    dispose { console.log('gone'); }
    <main class="a" class:active={n > 0} style:color={'red'}>
        <input bind:value={txt} onInput={(e) => e} />
        <Show when={n > 0} fallback={<p>none</p>}><span>{ double }</span></Show>
        <For each={[1,2]} key={(i) => i}>{(i) => <li>{i}</li>}</For>
        <Switch value={n}><Match when={1}><b>one</b></Match></Switch>
        <Dynamic component={Card} />
        <Suspense fallback={<p>...</p>}><span>{ user.loading ? '' : 'ok' }</span></Suspense>
        <Portal><div>float</div></Portal>
        <Transition name="fade"><div>t</div></Transition>
        <ErrorBoundary fallback={(e, reset) => <p>bad</p>}><span>ok</span></ErrorBoundary>
        <Card title={txt}>{ txt } sibling</Card>
    </main>
}
`;

function emittedRuntimeImports(code: string): { specifier: string; names: string[] }
{
    const match = /import\s*\{([^}]*)\}\s*from\s*['"](azerothjs[^'"]*)['"]/.exec(code);
    if (match === null)
    {
        throw new Error('compiled output must import its runtime');
    }
    return {
        specifier: match[2] ?? '',
        names: (match[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean)
    };
}

describe('the compiled-output runtime contract', () =>
{
    it('emitted code imports from azerothjs/internal - never the public entry', () =>
    {
        const { code } = generateModule(SINK, 'Sink.azeroth');
        const { specifier } = emittedRuntimeImports(code);
        expect(specifier).toBe('azerothjs/internal');
    });

    it('every emitted runtime name is exported by azerothjs/internal (drift weld)', () =>
    {
        const { code } = generateModule(SINK, 'Sink.azeroth');
        const { names } = emittedRuntimeImports(code);
        expect(names.length).toBeGreaterThan(20); // the sink genuinely exercises the vocabulary
        const exported = new Set(Object.keys(contract));
        for (const name of names)
        {
            expect(exported.has(name), `azerothjs/internal must export "${ name }"`).toBe(true);
        }
    });

    it('the sibling-hole and spread paths emit contract names too (bindHole/bindProps)', () =>
    {
        const { code } = generateModule(
            'export default component T { state n = 0; <div {...({ id: "x" })}>text { n } tail</div> }',
            'T.azeroth'
        );
        const { names } = emittedRuntimeImports(code);
        const exported = new Set(Object.keys(contract));
        for (const name of names)
        {
            expect(exported.has(name), `azerothjs/internal must export "${ name }"`).toBe(true);
        }
    });
});
