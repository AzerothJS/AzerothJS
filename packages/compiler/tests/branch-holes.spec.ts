// @vitest-environment happy-dom
//
// A hole inside a Show, Match or Switch branch, compiled and driven through render, renderToString
// and hydrate. Each arm pins the text after every write, or the name of the error a write threw.
import { describe, it, expect, vi } from 'vitest';
import { generateModule, EMITTED_CONTRACT_VERSION } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { render, hydrate, renderToString } from 'azerothjs';

interface Hook
{
    set?: (v: boolean) => void;
    setReady?: (v: boolean) => void;
    setUser?: (v: unknown) => void;
    setK?: (v: boolean) => void;
    setList?: (v: number[]) => void;
    reads: number;
    setups: number;
}

const hook: Hook = { reads: 0, setups: 0 };

interface Shape
{
    markup: string;
    extra?: string;
    steps?: Array<() => void>;
}

const W = [() => hook.set?.(true), () => hook.set?.(false), () => hook.set?.(true)];
const K = [() => hook.setK?.(true), () => hook.setK?.(false), () => hook.setK?.(true)];
const Z = [() => hook.setUser?.(null), () => hook.setUser?.({ name: 'bob' }), () => hook.setUser?.({ name: 'cat' })];
const ZB = [
    () => runtime.batch(() =>
    {
        hook.set?.(true);
        hook.setUser?.(null);
    }),
    () => hook.setUser?.({ name: 'bob' })
];
const ZW = [
    () => runtime.batch(() =>
    {
        hook.setUser?.(null);
        hook.set?.(true);
    }),
    () => hook.setUser?.({ name: 'bob' })
];
const FLIP = [() => hook.set?.(true), () => hook.set?.(false), () => hook.setReady?.(false), () => hook.set?.(true)];
const KH = [() => hook.set?.(true), () => hook.setReady?.(false), () => hook.setReady?.(true), () => hook.set?.(false)];
const L = [() => hook.setList?.([1, 2, 3]), () => hook.setReady?.(false), () => hook.setReady?.(true)];

const KID = `component Kid(props: { on: boolean }) {
    <><i>x</i>{ props.on ? <b>in</b> : <i>out</i> }</>
}`;
const KIDH = `component KidH(props: { on: boolean }) {
    <>{ props.on ? <b>in</b> : <i>out</i> }<i>x</i></>
}`;
const KIDS = `component KidS() {
    state on = false;
    hook.setK = (v) => { on = v; };
    <><i>x</i>{ on ? <b>in</b> : <i>out</i> }</>
}`;
const FIELD = `component Field(props: { on: boolean }) {
    hook.setups++;
    const first = props.on;
    <label><input/>{ props.on ? "in" : "out" }</label>
}`;
const WRAP = `component Wrap(props: { children: any }) {
    <Show when={ true }>{ props.children }</Show>
}`;
const CARD = `component Card(props: { children: any }) {
    <section>{ props.children }</section>
}`;
const P = `component P(props: { t: string }) {
    <Show when={ true }>{ props.t }</Show>
}`;

const SHAPES = {
    soleTernary: { markup: '<Show when={ true }>{ returning ? <b>in</b> : <i>out</i> }</Show>' },
    soleText: { markup: '<Show when={ true }>{ returning ? "in" : "out" }</Show>' },
    soleNumber: { markup: '<Show when={ true }>{ 5 }</Show>' },
    matchSole: { markup: '<Switch><Match when={ true }>{ returning ? <b>in</b> : <i>out</i> }</Match></Switch>' },
    nestedSole: { markup: '<Show when={ true }><Show when={ ready }>{ returning ? <b>in</b> : <i>out</i> }</Show></Show>' },
    propSole: { markup: '<P t={ returning ? "in" : "out" }/>', extra: P },
    markupSole: { markup: '<Show when={ true }>{ <p>{ returning ? "in" : "out" }</p> }</Show>' },
    constSole: { markup: '<Show when={ true }>{ label }</Show>' },
    showFallback: { markup: '<Show when={ false } fallback={ returning ? <b>in</b> : <i>out</i> }><u>t</u></Show>' },
    switchFallback: { markup: '<Switch fallback={ returning ? <b>in</b> : <i>out</i> }><Match when={ false }><u>t</u></Match></Switch>' },
    markupFallback: { markup: '<Show when={ false } fallback={ <p>{ returning ? "in" : "out" }</p> }><u>t</u></Show>' },
    switchFallbackConst: { markup: '<Switch fallback={ label }><Match when={ false }><u>t</u></Match></Switch>' },
    rawFallbackConst: { markup: '{ [1].map((n) => { return <Show when={ false } fallback={ label }><u>t</u></Show>; }) }' },
    thunkReadOnce: { markup: '<Show when={ true }>{ () => mark() && returning ? <b>in</b> : <i>out</i> }</Show>' },
    thunkFallback: { markup: '<Show when={ false } fallback={ () => mark() && returning ? <b>in</b> : <i>out</i> }><u>t</u></Show>' },
    multiNode: { markup: '<Show when={ true }><i>x</i>{ returning && <b>in</b> }</Show>' },
    multiMatch: { markup: '<Switch><Match when={ true }><i>x</i>{ returning ? <b>in</b> : <i>out</i> }</Match></Switch>' },
    textToNode: { markup: '<Show when={ true }><i>x</i>{ returning ? <b>in</b> : "out" }</Show>' },
    kidInShow: { markup: '<Show when={ true }><Kid on={ returning }/></Show>', extra: KID },
    dynSelf: { markup: '<Dynamic component={ KidS }/>', extra: KIDS, steps: K },
    arraySole: { markup: '<Show when={ true }>{ returning ? [<b>in</b>, <b>2</b>] : <i>out</i> }</Show>' },
    arrayMulti: { markup: '<Show when={ true }><i>x</i>{ returning ? [<b>in</b>, <b>2</b>] : <i>out</i> }</Show>' },
    whenFlipMulti: { markup: '<Show when={ returning } fallback={ <i>out</i> }><i>x</i>{ ready ? <b>in</b> : <i>no</i> }</Show>', steps: FLIP },
    inputSibling: { markup: '<Show when={ true }><input/>{ returning ? <b>in</b> : <i>out</i> }</Show>' },
    fieldMulti: { markup: '<Show when={ true }><u>k</u>{ ready && <Field on={ returning }/> }</Show>', extra: FIELD },
    fieldPlain: { markup: '{ ready && <Field on={ returning }/> }', extra: FIELD },
    fieldWrap: { markup: '<Wrap><Field on={ returning }/></Wrap>', extra: `${ FIELD }\n${ WRAP }` },
    letSole: { markup: '<Show when={ ready } let={ r }>{ r && returning ? "in" : "out" }</Show>' },
    letSoleNode: { markup: '<Show when={ ready } let={ r }>{ r && returning ? <b>in</b> : <i>out</i> }</Show>' },
    zombie: { markup: '<Show when={ user }>{ user.name }</Show>', steps: Z },
    zombieLet: { markup: '<Show when={ user } let={ u }>{ u.name }</Show>', steps: Z },
    zombieMatch: { markup: '<Switch><Match when={ user }>{ user.name }</Match></Switch>', steps: Z },
    batchSole: { markup: '<Show when={ user }>{ user.name + (returning ? "!" : "") }</Show>', steps: ZB },
    batchWhenFirst: { markup: '<Show when={ user }>{ user.name + (returning ? "!" : "") }</Show>', steps: ZW },
    batchMulti: { markup: '<Show when={ user }><i>x</i>{ user.name + (returning ? "!" : "") }</Show>', steps: ZB },
    batchLet: { markup: '<Show when={ user } let={ u }>{ u.name + (returning ? "!" : "") }</Show>', steps: ZB },
    rawMode: { markup: '{ [1].map((n) => { return <Show when={ true }>{ returning ? <b>in</b> : <i>out</i> }</Show>; }) }' },
    rawMulti: { markup: '{ [1].map((n) => { return <Show when={ true }><i>x</i>{ returning ? <b>in</b> : <i>out</i> }</Show>; }) }' },
    exprMapSole: { markup: '{ [1].map((n) => <Show when={ true }>{ returning ? <b>in</b> : <i>out</i> }</Show>) }' },
    exprMapMulti: { markup: '{ [1].map((n) => <Show when={ true }><i>x</i>{ returning ? <b>in</b> : <i>out</i> }</Show>) }' },
    holeShowMulti: { markup: '{ ready && <Show when={ true }><i>x</i>{ returning ? <b>in</b> : <i>out</i> }</Show> }' },
    cardFragSole: { markup: '<Card><>{ returning ? "in" : "out" }</></Card>', extra: CARD },
    kidHeadPlain: { markup: '{ ready && <KidH on={ returning }/> }', extra: KIDH, steps: KH },
    kidHeadSole: { markup: '<Show when={ true }>{ ready && <KidH on={ returning }/> }</Show>', extra: KIDH, steps: KH },
    soleKidMid: { markup: '<Show when={ true }>{ ready && <Kid on={ returning }/> }</Show>', extra: KID, steps: KH },
    forInPlain: { markup: '<ul>{ ready && <For each={ list } key={ (x) => x } let={ x }><li>{ x }</li></For> }</ul>', steps: L },
    forInSole: { markup: '<ul><Show when={ true }>{ ready && <For each={ list } key={ (x) => x } let={ x }><li>{ x }</li></For> }</Show></ul>', steps: L }
} satisfies Record<string, Shape>;

type ShapeName = keyof typeof SHAPES;

function moduleSource(shape: Shape): string
{
    return `${ shape.extra ?? '' }
const label = "const";
function mark() { hook.reads++; return true; }
export default component C() {
    state returning = false;
    state ready = true;
    state user = { name: "ann" };
    state list = [1];
    hook.set = (v) => { returning = v; };
    hook.setReady = (v) => { ready = v; };
    hook.setUser = (v) => { user = v; };
    hook.setList = (v) => { list = v; };
    <div>${ shape.markup }</div>
}`;
}

function emit(name: ShapeName, ssr = true): string
{
    return generateModule(moduleSource(SHAPES[name]), 'T.azeroth', ssr ? {} : { ssr: false }).code;
}

/** Compiles a shape and returns its component, executed against the runtime with `hook` in scope. */
function compile(name: ShapeName, ssr = true): () => HTMLElement
{
    const body = emit(name, ssr)
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const keys = Object.keys(runtime);
    const values = runtime as unknown as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the compiler's own output IS the point
    const factory = new Function(...keys, 'hook', `${ body }\nreturn C;`) as (...args: unknown[]) => () => HTMLElement;
    return factory(...keys.map((k) => values[k]), hook);
}

function errorName(error: unknown): string
{
    return `threw ${ (error as { name?: string } | null)?.name ?? String(error) }`;
}

interface Run
{
    seq: string;
    reads: number;
    setups: number;
    input?: string | undefined;
}

interface HydrateRun extends Run
{
    adopted: boolean;
    warned: string[];
}

/** Runs each write and joins the container text after mount and after every write. */
function drive(container: HTMLElement, steps: Array<() => void>): Pick<Run, 'seq' | 'input'>
{
    const input = container.querySelector('input');
    if (input)
    {
        input.value = 'typed';
        input.focus();
    }
    const seq = [container.textContent];
    for (const step of steps)
    {
        try
        {
            step();
            seq.push(container.textContent);
        }
        catch (error)
        {
            seq.push(errorName(error));
        }
    }
    return {
        seq: seq.join(' > '),
        input: input ? `connected=${ input.isConnected } value=${ input.value } focused=${ document.activeElement === input }` : undefined
    };
}

function mountPoint(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

function renderRun(name: ShapeName, ssr = true): Run
{
    const shape: Shape = SHAPES[name];
    const container = mountPoint();
    hook.reads = 0;
    hook.setups = 0;
    let driven: Pick<Run, 'seq' | 'input'>;
    try
    {
        const C = compile(name, ssr);
        render(() => C(), container);
        driven = drive(container, shape.steps ?? W);
    }
    catch (error)
    {
        driven = { seq: `mount ${ errorName(error) }` };
    }
    container.remove();
    return { ...driven, reads: hook.reads, setups: hook.setups };
}

function serverHtml(name: ShapeName): string
{
    try
    {
        const C = compile(name);
        return renderToString(() => C());
    }
    catch (error)
    {
        return errorName(error);
    }
}

function hydrateRun(name: ShapeName): HydrateRun
{
    const shape: Shape = SHAPES[name];
    const container = mountPoint();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try
    {
        const C = compile(name);
        container.innerHTML = renderToString(() => C());
        const server = [...container.querySelectorAll('*')];
        hook.reads = 0;
        hook.setups = 0;
        hydrate(() => C(), container);
        const adopted = server.every((node) => node.isConnected);
        const warned = warn.mock.calls.map((call) => String(call[0]));
        return { adopted, warned, ...drive(container, shape.steps ?? W), reads: hook.reads, setups: hook.setups };
    }
    catch (error)
    {
        return { adopted: false, warned: [], seq: `mount ${ errorName(error) }`, reads: hook.reads, setups: hook.setups };
    }
    finally
    {
        warn.mockRestore();
        container.remove();
    }
}

/** The sequence under render, under the client-only emit, and under hydrate. */
function sequences(name: ShapeName): { render: string; client: string; hydrate: string }
{
    return { render: renderRun(name).seq, client: renderRun(name, false).seq, hydrate: hydrateRun(name).seq };
}

function everywhere(seq: string): { render: string; client: string; hydrate: string }
{
    return { render: seq, client: seq, hydrate: seq };
}

describe('a hole in a branch built into a fragment swaps nodes in place', () =>
{
    const cases: Array<[ShapeName, string]> = [
        ['multiNode', 'x > xin > x > xin'],
        ['multiMatch', 'xout > xin > xout > xin'],
        ['textToNode', 'xout > xin > xout > xin'],
        ['kidInShow', 'xout > xin > xout > xin'],
        ['dynSelf', 'xout > xin > xout > xin']
    ];

    for (const [name, seq] of cases)
    {
        it(`${ name } tracks every write without throwing`, () =>
        {
            expect(sequences(name)).toEqual(everywhere(seq));
        });
    }
});

describe('an array value in a branch hole splices in place', () =>
{
    it('arrayMulti swaps a node for an array and back', () =>
    {
        expect(sequences('arrayMulti')).toEqual(everywhere('xout > xin2 > xout > xin2'));
    });

    it('arraySole swaps a node for an array and back', () =>
    {
        expect(sequences('arraySole')).toEqual(everywhere('out > in2 > out > in2'));
    });
});

describe('the when flip that mounts a multi-child branch', () =>
{
    it('mounts the branch and keeps its hole live', () =>
    {
        expect(sequences('whenFlipMulti')).toEqual(everywhere('out > xin > out > out > xno'));
    });
});

describe('a sole hole child of Show or Match tracks its reads', () =>
{
    const cases: ShapeName[] = ['soleTernary', 'soleText', 'matchSole', 'nestedSole', 'propSole'];

    for (const name of cases)
    {
        it(`${ name } updates on every write`, () =>
        {
            expect(sequences(name)).toEqual(everywhere('out > in > out > in'));
        });
    }
});

describe('a non-markup fallback tracks its reads', () =>
{
    for (const name of ['showFallback', 'switchFallback'] as const)
    {
        it(`${ name } updates on every write`, () =>
        {
            expect(sequences(name)).toEqual(everywhere('out > in > out > in'));
        });
    }
});

describe('a sole hole in a Show branch hydrates in place', () =>
{
    const cases: ShapeName[] = ['soleTernary', 'soleText', 'markupSole', 'matchSole', 'nestedSole', 'propSole'];

    for (const name of cases)
    {
        it(`${ name } adopts the server nodes with no warning`, () =>
        {
            const run = hydrateRun(name);
            expect({ adopted: run.adopted, warned: run.warned, seq: run.seq })
                .toEqual({ adopted: true, warned: [], seq: 'out > in > out > in' });
        });
    }
});

describe('a sole hole under let= reads its binding', () =>
{
    for (const name of ['letSole', 'letSoleNode'] as const)
    {
        it(`${ name } renders on the server and tracks in the browser`, () =>
        {
            expect(serverHtml(name)).not.toMatch(/^threw/);
            expect(sequences(name)).toEqual(everywhere('out > in > out > in'));
        });
    }

    it('zombieLet follows the narrowed value', () =>
    {
        expect(sequences('zombieLet')).toEqual(everywhere('ann >  > bob > cat'));
    });
});

describe('an explicit branch arrow is read once', () =>
{
    for (const name of ['thunkReadOnce', 'thunkFallback'] as const)
    {
        it(`${ name } reads its body once and stays put`, () =>
        {
            const rendered = renderRun(name);
            const hydrated = hydrateRun(name);
            expect({ seq: rendered.seq, reads: rendered.reads }).toEqual({ seq: 'out > out > out > out', reads: 1 });
            expect({ seq: hydrated.seq, reads: hydrated.reads }).toEqual({ seq: 'out > out > out > out', reads: 1 });
        });
    }
});

describe('the server markup of a branch', () =>
{
    const unchanged: Array<[ShapeName, string]> = [
        ['markupFallback', '<div><!--azc:show--><p><!--[-->out<!--]--></p><!--/azc--></div>'],
        ['constSole', '<div><!--azc:show-->const<!--/azc--></div>'],
        ['switchFallbackConst', '<div><!--azc:switch-->const<!--/azc--></div>'],
        ['multiNode', '<div><!--azc:show--><i>x</i><!--[--><!--]--><!--/azc--></div>'],
        ['multiMatch', '<div><!--azc:switch--><i>x</i><!--[--><i>out</i><!--]--><!--/azc--></div>'],
        ['whenFlipMulti', '<div><!--azc:show--><i>out</i><!--/azc--></div>'],
        ['kidInShow', '<div><!--azc:show--><i>x</i><!--[--><i>out</i><!--]--><!--/azc--></div>'],
        ['inputSibling', '<div><!--azc:show--><input><!--[--><i>out</i><!--]--><!--/azc--></div>'],
        ['arrayMulti', '<div><!--azc:show--><i>x</i><!--[--><i>out</i><!--]--><!--/azc--></div>'],
        ['textToNode', '<div><!--azc:show--><i>x</i><!--[-->out<!--]--><!--/azc--></div>'],
        ['fieldMulti', '<div><!--azc:show--><u>k</u><!--[--><label><input><!--[-->out<!--]--></label><!--]--><!--/azc--></div>'],
        ['rawMulti', '<div><!--[--><!--azc:show--><i>x</i><!--[--><i>out</i><!--]--><!--/azc--><!--]--></div>'],
        ['exprMapMulti', '<div><!--[--><!--azc:show--><i>x</i><!--[--><i>out</i><!--]--><!--/azc--><!--]--></div>'],
        ['holeShowMulti', '<div><!--[--><!--azc:show--><i>x</i><!--[--><i>out</i><!--]--><!--/azc--><!--]--></div>']
    ];

    for (const [name, html] of unchanged)
    {
        it(`${ name } keeps its bytes`, () =>
        {
            expect(serverHtml(name)).toBe(html);
        });
    }

    // A sole hole or a non-markup fallback serializes as a hole inside the co-range.
    const paired: Array<[ShapeName, string]> = [
        ['soleTernary', '<div><!--azc:show--><!--[--><i>out</i><!--]--><!--/azc--></div>'],
        ['soleNumber', '<div><!--azc:show--><!--[-->5<!--]--><!--/azc--></div>'],
        ['showFallback', '<div><!--azc:show--><!--[--><i>out</i><!--]--><!--/azc--></div>'],
        ['switchFallback', '<div><!--azc:switch--><!--[--><i>out</i><!--]--><!--/azc--></div>'],
        ['rawFallbackConst', '<div><!--azc:show--><!--[-->const<!--]--><!--/azc--></div>']
    ];

    for (const [name, html] of paired)
    {
        it(`${ name } carries one hole anchor pair`, () =>
        {
            expect(serverHtml(name)).toBe(html);
        });
    }
});

describe('a hole whose value holds another hole hydrates in place', () =>
{
    const cases: Array<[ShapeName, string]> = [
        ['exprMapSole', 'out > in > out > in'],
        ['rawMode', 'out > in > out > in'],
        ['holeShowMulti', 'xout > xin > xout > xin'],
        ['rawMulti', 'xout > xin > xout > xin'],
        ['cardFragSole', 'out > in > out > in']
    ];

    for (const [name, seq] of cases)
    {
        it(`${ name } keeps the server nodes live with no warning`, () =>
        {
            const run = hydrateRun(name);
            expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq });
        });
    }
});

describe('the runtime contract of the branch emit', () =>
{
    it('refuses a module compiled at v4 and names it the stale side', () =>
    {
        expect(() => runtime.assertRuntimeContract(4))
            .toThrow(/compiled for azerothjs runtime contract v4, but the installed azerothjs speaks v5\..*This module is the stale side: rebuild it/s);
    });

    it('stamps the branch emit with v5, which loads on this runtime', () =>
    {
        expect(emit('soleTernary')).toContain('assertRuntimeContract(5);');
        expect(EMITTED_CONTRACT_VERSION).toBe(5);
        expect(() => compile('soleTernary')).not.toThrow();
    });
});

describe('component identity inside a branch hole', () =>
{
    it('a component set up in a sole branch hole rebuilds like one in a plain hole', () =>
    {
        const expected = { seq: 'out > in > out > in', setups: 4, input: 'connected=false value=typed focused=false' };
        const pick = ({ seq, setups, input }: Run): Partial<Run> => ({ seq, setups, input });
        expect(pick(renderRun('fieldPlain'))).toEqual(expected);
        expect(pick(renderRun('fieldWrap'))).toEqual(expected);
    });

    it('fieldWrap hydrates in place', () =>
    {
        const run = hydrateRun('fieldWrap');
        expect({ adopted: run.adopted, warned: run.warned, seq: run.seq })
            .toEqual({ adopted: true, warned: [], seq: 'out > in > out > in' });
    });

    it('an input beside a branch hole keeps identity, value and focus', () =>
    {
        const kept = 'connected=true value=typed focused=true';
        const rendered = renderRun('inputSibling');
        const hydrated = hydrateRun('inputSibling');
        expect({ seq: rendered.seq, input: rendered.input }).toEqual({ seq: 'out > in > out > in', input: kept });
        expect({ adopted: hydrated.adopted, seq: hydrated.seq, input: hydrated.input })
            .toEqual({ adopted: true, seq: 'out > in > out > in', input: kept });
    });
});

describe('a branch closed by a single write never runs its read on the null', () =>
{
    for (const name of ['zombie', 'zombieLet', 'zombieMatch'] as const)
    {
        it(`${ name } follows the value without throwing`, () =>
        {
            expect(sequences(name)).toEqual(everywhere('ann >  > bob > cat'));
        });
    }
});

describe('a batch that writes another signal the branch reads, then clears when', () =>
{
    // The queued hole runs before the branch closes, so a read of `when` itself sees the null;
    // a let= name keeps the last truthy value.
    it('the let= form follows the value without throwing', () =>
    {
        expect(sequences('batchLet')).toEqual(everywhere('ann >  > bob!'));
    });

    it('clearing when first closes the branch before the read', () =>
    {
        expect(sequences('batchWhenFirst')).toEqual(everywhere('ann >  > bob!'));
    });

    it('a sole or multi-child read of when throws TypeError', () =>
    {
        expect(sequences('batchSole')).toEqual(everywhere('ann > threw TypeError > bob!'));
        expect(sequences('batchMulti')).toEqual(everywhere('xann > threw TypeError > xbob!'));
    });
});

describe('a hole whose value holds a live inner hole or For', () =>
{
    // These pin the stale saved node list the outer hole keeps, in and out of a branch.
    const cases: Array<[ShapeName, { render: string; hydrate: string }]> = [
        ['kidHeadPlain', { render: 'outx > inx > threw DOMException > threw DOMException > inoutx', hydrate: 'outx > inx > in > ininx > inoutx' }],
        ['kidHeadSole', { render: 'outx > inx > threw TypeError > threw TypeError > inx', hydrate: 'outx > inx > in > ininx > inoutx' }],
        ['soleKidMid', { render: 'xout > xin > in > xinin > xoutin', hydrate: 'xout > xin > in > inxin > inxout' }],
        ['forInPlain', { render: '1 > 123 > 23 > 23123', hydrate: '1 > 123 > 23 > 23123' }],
        ['forInSole', { render: '1 > 123 > 23 > 12323', hydrate: '1 > 123 > 23 > 23123' }]
    ];

    for (const [name, seq] of cases)
    {
        it(`${ name } keeps its current sequence`, () =>
        {
            expect(sequences(name)).toEqual({ render: seq.render, client: seq.render, hydrate: seq.hydrate });
        });
    }

    it('a sole branch hole hydrates like the same hole outside a branch', () =>
    {
        expect(hydrateRun('kidHeadSole').seq).toBe(hydrateRun('kidHeadPlain').seq);
        expect(hydrateRun('forInSole').seq).toBe(hydrateRun('forInPlain').seq);
    });
});
