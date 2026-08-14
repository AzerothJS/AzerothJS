// @vitest-environment happy-dom
//
// The compiled-output runtime contract: generated code imports ONLY from
// 'azerothjs/internal', and every name it can emit exists there. This is the drift
// test that welds the compiler's emit vocabulary to the contract module - adding a
// keyword, builtin, or markup helper to the emitter without exporting it from
// azerothjs/internal fails HERE, not in a user's build.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateModule, EMITTED_CONTRACT_VERSION } from '../src/codegen.ts';
import * as contract from 'azerothjs/internal';

const here = path.dirname(fileURLToPath(import.meta.url));

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
        <For each={[1,2]} key={(i) => i} let={ i }><li>{i}</li></For>
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

describe('the version handshake', () =>
{
    it('every runtime-consuming module asserts the contract version at load', () =>
    {
        const { code } = generateModule('export default component T { state n = 0; <p>{ n }</p> }', 'T.azeroth');
        expect(code).toContain(`assertRuntimeContract(${ EMITTED_CONTRACT_VERSION });`);
        // The assertion sits BEFORE any component code runs (module top level, after imports).
        expect(code.indexOf('assertRuntimeContract')).toBeLessThan(code.indexOf('function T'));
    });

    it('compiler and runtime speak the SAME version (the lockstep weld)', () =>
    {
        expect(contract.RUNTIME_CONTRACT_VERSION).toBe(EMITTED_CONTRACT_VERSION);
    });

    it('the matching version passes; a mismatch throws the rebuild error', () =>
    {
        expect(() => contract.assertRuntimeContract(contract.RUNTIME_CONTRACT_VERSION)).not.toThrow();
        expect(() => contract.assertRuntimeContract(0)).toThrow(/compiled for azerothjs runtime contract v0.*rebuild/s);
        expect(() => contract.assertRuntimeContract(999)).toThrow(/same release train/);
    });

    it('a module with no runtime consumption emits no handshake (source passes through)', () =>
    {
        const result = generateModule('export const x = 1;');
        expect(result.code).toBe('export const x = 1;');
        expect(result.code).not.toContain('assertRuntimeContract');
    });
});

describe('the handshake failure tells the reader which side is stale', () =>
{
    // One direction-blind sentence ("rebuild the app, or update the prebuilt library") sent half
    // of all readers to the wrong remedy: stale COMPILED output is rebuilt, a stale RUNTIME is
    // upgraded, and those are opposite actions.
    it('names rebuilding when the module is behind the runtime', () =>
    {
        expect(() => contract.assertRuntimeContract(contract.RUNTIME_CONTRACT_VERSION - 1))
            .toThrow(/This module is the stale side: rebuild it/);
    });

    it('names upgrading the runtime when the runtime is behind the module', () =>
    {
        expect(() => contract.assertRuntimeContract(contract.RUNTIME_CONTRACT_VERSION + 1))
            .toThrow(/The installed runtime is the stale side: upgrade azerothjs/);
    });

    it('names the module when a caller supplies its URL', () =>
    {
        expect(() => contract.assertRuntimeContract(contract.RUNTIME_CONTRACT_VERSION - 1, 'file:///app/dist/Card.js'))
            .toThrow(/\(module: file:\/\/\/app\/dist\/Card\.js\)/);
    });

    it('does NOT emit import.meta, which would make compiled output module-only', () =>
    {
        // `import.meta` is legal only inside an ES module, so emitting it would make a compiled
        // component impossible to evaluate anywhere else - including the harnesses that execute
        // real emitted code to test it.
        const result = generateModule('export default component C() { state n = 0; <p>{n}</p> }');
        expect(result.code).toContain('assertRuntimeContract(');
        expect(result.code).not.toContain('import.meta');
    });
});

/**
 * SemVer 2.0.0 precedence, prerelease-aware, no dependency: negative when a < b, zero
 * when equal, positive when a > b. Build metadata never appears in release versions here.
 */
function compareVersions(a: string, b: string): number
{
    const parse = (version: string): { base: number[]; prerelease: string[] } =>
    {
        const dash = version.indexOf('-');
        return {
            base: (dash === -1 ? version : version.slice(0, dash)).split('.').map(Number),
            prerelease: dash === -1 ? [] : version.slice(dash + 1).split('.')
        };
    };
    const left = parse(a);
    const right = parse(b);
    for (let i = 0; i < 3; i++)
    {
        const l = left.base[i] ?? 0;
        const r = right.base[i] ?? 0;
        if (l !== r)
        {
            return l < r ? -1 : 1;
        }
    }
    // A prerelease ranks below its stable release.
    if (left.prerelease.length === 0 || right.prerelease.length === 0)
    {
        return Number(right.prerelease.length > 0) - Number(left.prerelease.length > 0);
    }
    for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++)
    {
        const l = left.prerelease[i];
        const r = right.prerelease[i];
        if (l === undefined || r === undefined)
        {
            // A shorter identifier set ranks below its extension (beta < beta.1).
            return l === undefined ? -1 : 1;
        }
        if (l === r)
        {
            continue;
        }
        const lNumeric = /^\d+$/.test(l);
        const rNumeric = /^\d+$/.test(r);
        if (lNumeric && rNumeric)
        {
            return Number(l) < Number(r) ? -1 : 1;
        }
        if (lNumeric !== rNumeric)
        {
            // Numeric identifiers rank below alphanumeric ones.
            return lNumeric ? -1 : 1;
        }
        return l < r ? -1 : 1;
    }
    return 0;
}

describe('the contract generation is welded to the package version', () =>
{
    // The handshake can only distinguish artifacts AFTER a wrong install; the version string
    // is what installs resolve on. So every contract generation is pinned to the FIRST package
    // version allowed to ship it (contract-versions.json - the release script refuses to
    // publish outside it), and the current version must be at or above the pin for the
    // contract it carries. A generation absent from the table never shipped and never may.
    const table = (JSON.parse(readFileSync(path.join(here, '..', 'contract-versions.json'), 'utf8')) as
        { firstVersionByContract: Record<string, string> }).firstVersionByContract;
    const compilerVersion = (JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as
        { version: string }).version;
    const runtimeVersion = (JSON.parse(readFileSync(path.join(here, '..', '..', 'azerothjs', 'package.json'), 'utf8')) as
        { version: string }).version;

    it('compareVersions orders semver with prerelease precedence', () =>
    {
        const ordered = ['2.1.0-alpha.2', '2.1.0-beta.1', '2.1.0-beta.2', '2.1.0-beta.11', '2.1.0-rc.1', '2.1.0', '2.1.1', '2.2.0-beta.1'];
        for (let i = 1; i < ordered.length; i++)
        {
            const lower = ordered[i - 1] ?? '';
            const higher = ordered[i] ?? '';
            expect(compareVersions(lower, higher), `${ lower } < ${ higher }`).toBeLessThan(0);
            expect(compareVersions(higher, lower), `${ higher } > ${ lower }`).toBeGreaterThan(0);
        }
        expect(compareVersions('2.1.0-beta.2', '2.1.0-beta.2')).toBe(0);
    });

    it('the table names the first version allowed to ship the current contract', () =>
    {
        expect(
            table[String(EMITTED_CONTRACT_VERSION)],
            `contract-versions.json must register the first version shipping contract v${ EMITTED_CONTRACT_VERSION }`
        ).toBeDefined();
    });

    it('the package version is at or above the floor of the contract it ships', () =>
    {
        const floor = table[String(EMITTED_CONTRACT_VERSION)];
        if (floor === undefined)
        {
            throw new Error(`no floor registered for contract v${ EMITTED_CONTRACT_VERSION }`);
        }
        expect(runtimeVersion, 'compiler and runtime version in lockstep').toBe(compilerVersion);
        expect(
            compareVersions(compilerVersion, floor),
            `${ compilerVersion } must not ship contract v${ EMITTED_CONTRACT_VERSION } (first allowed at ${ floor })`
        ).toBeGreaterThanOrEqual(0);
    });

    it('floors rise with the contract generation', () =>
    {
        // A new generation registered at or below an older one's floor would let one version
        // string cover two contracts - exactly what the table exists to rule out.
        const entries = Object.entries(table)
            .map(([generation, version]) => [Number(generation), version] as const)
            .sort((a, b) => a[0] - b[0]);
        expect(entries.length).toBeGreaterThan(0);
        let previous: readonly [number, string] | null = null;
        for (const [generation, version] of entries)
        {
            if (previous !== null)
            {
                expect(
                    compareVersions(previous[1], version),
                    `contract v${ generation } floor (${ version }) must be above contract v${ previous[0] }'s (${ previous[1] })`
                ).toBeLessThan(0);
            }
            previous = [generation, version];
        }
    });
});
