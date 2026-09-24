// @vitest-environment happy-dom
//
// A hole inside a Show, Match or Switch branch, compiled and driven through render, renderToString
// and hydrate. Each arm pins the text after every write, or the name of the error a write threw.
import { describe, it, expect, vi } from 'vitest';
import { generateModule, EMITTED_CONTRACT_VERSION } from '../src/codegen.ts';
import * as runtime from 'azerothjs/internal';
import { render, hydrate, renderToString, Portal, createRoot, h } from 'azerothjs';

interface Hook
{
    set?: (v: boolean) => void;
    setReady?: (v: boolean) => void;
    setUser?: (v: unknown) => void;
    setK?: (v: boolean) => void;
    setList?: (v: number[]) => void;
    reads: number;
    cleanups: number;
    setups: number;
}

const hook: Hook = { reads: 0, setups: 0, cleanups: 0 };

interface Shape
{
    markup: string;
    extra?: string;
    setup?: string;
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
const ZL = [
    () => runtime.batch(() =>
    {
        hook.set?.(true);
        hook.setList?.([]);
    }),
    () => hook.setList?.([5])
];
const ZE = [
    () => runtime.batch(() =>
    {
        hook.setReady?.(false);
        hook.set?.(true);
    }),
    () => runtime.batch(() =>
    {
        hook.setReady?.(true);
        hook.setUser?.({ name: 'bob' });
    })
];
const ZO = [
    () => hook.set?.(true),
    () => runtime.batch(() =>
    {
        hook.set?.(false);
        hook.setUser?.({ name: 'bob' });
    })
];
const FLIP = [() => hook.set?.(true), () => hook.set?.(false), () => hook.setReady?.(false), () => hook.set?.(true)];
const KH = [() => hook.set?.(true), () => hook.setReady?.(false), () => hook.setReady?.(true), () => hook.set?.(false)];
const L = [() => hook.setList?.([1, 2, 3]), () => hook.setReady?.(false), () => hook.setReady?.(true)];
const LR = [...L, () => hook.setList?.([3, 1])];
const REORDER = [() => hook.setList?.([1, 2, 3]), () => hook.setList?.([3, 2, 1]), () => hook.setReady?.(false), () => hook.setReady?.(true), () => hook.setList?.([2])];
const LT = [() => hook.setList?.([1, 2, 3]), () => hook.setList?.([3]), () => hook.setList?.([2, 1])];
const DEEP = [() => hook.set?.(true), () => hook.setUser?.(null), () => hook.setUser?.({ name: 'bob' }), () => hook.set?.(false), () => hook.setReady?.(false), () => hook.setReady?.(true)];
const TAIL = [...W, () => hook.setReady?.(false), () => hook.setReady?.(true)];

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
const B = `component B(props: { on: boolean }) {
    <>{ props.on ? <b>in</b> : <i>out</i> }<i>b</i></>
}`;
const A = `${ B }
component A(props: { on: boolean; k: boolean }) {
    <>{ props.k ? <B on={ props.on }/> : <u>no</u> }<i>a</i></>
}`;
const B2 = `component B2(props: { on: boolean }) {
    <><i>b</i>{ props.on ? <b>in</b> : <i>out</i> }</>
}`;
const A2 = `${ B2 }
component A2(props: { on: boolean; k: boolean }) {
    <><i>a</i>{ props.k ? <B2 on={ props.on }/> : <u>no</u> }</>
}`;
const KA = `component KA(props: { on: boolean }) {
    <>{ props.on ? [<b>1</b>, <b>2</b>] : [] }<i>x</i></>
}`;
const KF = `component KF(props: { list: number[] }) {
    <><For each={ props.list } key={ (x) => x } let={ x }><li>{ x }</li></For><li>t</li></>
}`;
const K2 = `component K2(props: { on: boolean }) {
    <>{ props.on ? <b>in</b> : <i>out</i> }{ props.on ? "y" : <u>z</u> }</>
}`;
const KC = `component KC(props: { on: boolean }) {
    cleanup { hook.cleanups++; }
    <>{ props.on ? <b>in</b> : <i>out</i> }<i>x</i></>
}`;
const WRAP = `component Wrap(props: { children: any }) {
    <Show when={ true }>{ props.children }</Show>
}`;
const CARD = `component Card(props: { children: any }) {
    <section>{ props.children }</section>
}`;
const ROWS = `component Rows(props: { list: number[]; ready: boolean }) {
    <>{ props.ready && <For each={ props.list } key={ (x) => x } let={ x }><tr><td>{ x }</td></tr></For> }</>
}`;
const KFOOT = `component KFoot(props: { on: boolean }) {
    <>{ props.on ? <tfoot><tr><td>in</td></tr></tfoot> : <tfoot><tr><td>out</td></tr></tfoot> }</>
}`;
const KT = `component KT(props: { on: boolean }) {
    <><tr><td>k</td></tr>{ props.on && <tfoot><tr><td>f</td></tr></tfoot> }</>
}`;
const P = `component P(props: { t: string }) {
    <Show when={ true }>{ props.t }</Show>
}`;
const PAGE = `${ K2 }
component Page(props: { on: boolean }) {
    <><K2 on={ props.on }/><K2 on={ !props.on }/></>
}`;
const KIDE = `component KidE(props: { u: any; r: boolean }) {
    effect { hook.reads += props.u.name.length + (props.r ? 1 : 0); }
    <i>k</i>
}`;
const KIDM = `component KidM(props: { u: any; r: boolean }) {
    derived label = props.u.name + (props.r ? "!" : "");
    <i>{ label }</i>
}`;
const CLEAR = `component Clear(props: { r: boolean }) {
    effect { if (!props.r) { hook.setUser?.(null); } }
    <u></u>
}`;
const CLEARON = `component ClearOn(props: { r: boolean }) {
    effect { if (props.r) { hook.setUser?.(null); } }
    <u></u>
}`;
const SYNC = `component Sync(props: { u: any }) {
    effect { hook.setReady?.(props.u !== null); }
    <u></u>
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
    batchMatch: { markup: '<Switch><Match when={ user }>{ user.name + (returning ? "!" : "") }</Match></Switch>', steps: ZB },
    batchNested: { markup: '<Show when={ user }><Show when={ user.name }>{ user.name + (returning ? "!" : "") }</Show></Show>', steps: ZB },
    batchNestedOuter: { markup: '<Show when={ user }><Show when={ true }>{ user.name + (returning ? "!" : "") }</Show></Show>', steps: ZB },
    batchHoleInHole: { markup: '<Show when={ user }>{ ready ? <b>{ user.name + (returning ? "!" : "") }</b> : "" }</Show>', steps: ZB },
    batchTernary: { markup: '{ user ? <b>{ user.name + (returning ? "!" : "") }</b> : "" }', steps: ZB },
    batchKidEffect: { markup: '<Show when={ user }><KidE u={ user } r={ returning }/></Show>', extra: KIDE, steps: ZB },
    batchKidMemo: { markup: '<Show when={ user }><KidM u={ user } r={ returning }/></Show>', extra: KIDM, steps: ZB },
    batchDynamic: { markup: '<Dynamic component={ user ? KidM : null } props={ () => ({ u: user, r: returning }) }/>', extra: KIDM, steps: ZB },
    batchForIndex: { markup: '<ul><For each={ list } key={ (x) => x } let={ x } index={ i }><li>{ list[i].toFixed(0) + (returning ? "!" : "") }</li></For></ul>', steps: ZL },
    effectClearsOld: { markup: '<Clear r={ ready }/><Show when={ user }>{ user.name + (returning ? "!" : "") }</Show>', extra: CLEAR, steps: ZE },
    effectClearsYoung: { markup: '<Show when={ user }>{ user.name + (returning ? "!" : "") }</Show><Clear r={ ready }/>', extra: CLEAR, steps: ZE },
    innerOpensOuterClosesYoung: { markup: '<Show when={ user }>o<Show when={ returning }>{ user.name }</Show></Show><ClearOn r={ returning }/>', extra: CLEARON, steps: ZO },
    innerOpensOuterClosesOld: { markup: '<ClearOn r={ returning }/><Show when={ user }>o<Show when={ returning }>{ user.name }</Show></Show>', extra: CLEARON, steps: ZO },
    youngerWriter: { markup: '<Show when={ ready }>{ user.name + (returning ? "!" : "") }</Show><Sync u={ user }/>', extra: SYNC, steps: ZB },
    batchMatchMulti: { markup: '<Switch><Match when={ user }><i>x</i>{ user.name + (returning ? "!" : "") }</Match></Switch>', steps: ZB },
    batchShowFallbackMarkup: { markup: '<Show when={ !user } fallback={ <b>{ user.name + (returning ? "!" : "") }</b> }>none</Show>', steps: ZB },
    batchSwitchFallbackMarkup: { markup: '<Switch fallback={ <b>{ user.name + (returning ? "!" : "") }</b> }><Match when={ !user }>none</Match></Switch>', steps: ZB },
    batchShowFallbackExpr: { markup: '<Show when={ !user } fallback={ user.name + (returning ? "!" : "") }>none</Show>', steps: ZB },
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
    forInSole: { markup: '<ul><Show when={ true }>{ ready && <For each={ list } key={ (x) => x } let={ x }><li>{ x }</li></For> }</Show></ul>', steps: L },
    deepHead: { markup: '{ ready && <A on={ returning } k={ !!user }/> }', extra: A, steps: DEEP },
    deepHeadSole: { markup: '<Show when={ true }>{ ready && <A on={ returning } k={ !!user }/> }</Show>', extra: A, steps: DEEP },
    deepTailSole: { markup: '<Show when={ true }>{ ready && <A2 on={ returning } k={ !!user }/> }</Show>', extra: A2, steps: DEEP },
    innerArraySole: { markup: '<Show when={ true }>{ ready && <KA on={ returning }/> }</Show>', extra: KA, steps: KH },
    forHeadSole: { markup: '<ul><Show when={ true }>{ ready && <KF list={ list }/> }</Show></ul>', extra: KF, steps: LR },
    cleanupSole: { markup: '<Show when={ true }>{ ready && <KC on={ returning }/> }</Show>', extra: KC, steps: [...KH, () => hook.setReady?.(false)] },
    portalPlain: { markup: '{ ready && <Portal><p>{ returning ? "in" : "out" }</p></Portal> }', steps: KH },
    tailSib: { markup: '<Show when={ true }>{ ready && <Kid on={ returning }/> }<u>-</u></Show>', extra: KID, steps: KH },
    twoHoles: { markup: '<p>-</p>{ ready && <K2 on={ returning }/> }<p>-</p>', extra: K2, steps: KH },
    textArray: { markup: '<p>{ returning ? ["a", <b>b</b>] : "t" }</p>' },
    forReorder: { markup: '<ul>{ ready && <For each={ list } key={ (x) => x } let={ x }><li>{ x }</li></For> }</ul>', steps: REORDER },
    sameInput: { markup: '{ (returning || !returning) && box }', setup: 'const box = <input/>;' },
    portalTarget: { markup: '<ul>{ list.map((x) => <li>{ x }</li>) }</ul>', steps: LT },
    portalTargetText: { markup: '<ul>{ returning ? <li>in</li> : "out" }</ul>' },
    sepList: { markup: '<p>{ list.map((x, i) => [i > 0 ? ", " : "", () => x]) }</p>', steps: LT },
    emptyLone: { markup: '<p>{ ["", () => list.length] }</p>', steps: LT },
    adjacent: { markup: '<p>{ ready && [list.length, " of ", () => list[0]] }</p>', steps: L },
    nestEmpty: { markup: '<p>{ ["", list.map((x) => () => x)] }</p>', steps: LT },
    nestAdj: { markup: '<p>{ [list.length, " of ", list.map((x) => () => x)] }</p>', steps: LT },
    rowsFrag: { markup: '<table><tbody><Rows list={ list } ready={ ready }/></tbody></table>', extra: ROWS, steps: L },
    forInTbody: { markup: '<table><tbody>{ ready && <For each={ list } key={ (x) => x } let={ x }><tr><td>{ x }</td></tr></For> }</tbody></table>', steps: L },
    fragK2: { markup: '<p>-</p>{ ready && <><K2 on={ returning }/></> }<p>-</p>', extra: K2, steps: KH },
    page: { markup: '<p>-</p>{ ready && <Page on={ returning }/> }<p>-</p>', extra: PAGE, steps: KH },
    tableHole: { markup: '<table><tr><td>h</td></tr>{ returning ? <tr><td>in</td></tr> : <tr><td>out</td></tr> }<tr><td>t</td></tr></table>' },
    tFoot: { markup: '<table><tr><td>h</td></tr>{ returning ? <tr><td>in</td></tr> : <tfoot><tr><td>f</td></tr></tfoot> }</table>' },
    tFootNull: { markup: '<table><tr><td>h</td></tr>{ !returning && <tfoot><tr><td>f</td></tr></tfoot> }</table>' },
    tFootSwap: { markup: '<table><tr><td>h</td></tr>{ returning ? <tfoot><tr><td>in</td></tr></tfoot> : <tfoot><tr><td>out</td></tr></tfoot> }</table>' },
    tFootRow: { markup: '<table><tr><td>h</td></tr>{ !returning && <tfoot><tr><td>f</td></tr></tfoot> }<tr><td>t</td></tr></table>' },
    tBodyVal: { markup: '<table><tr><td>h</td></tr>{ !returning && <tbody><tr><td>b</td></tr></tbody> }</table>' },
    captionHide: { markup: '<table><tr><td>h</td></tr>{ returning ? null : <caption>cap</caption> }</table>' },
    tFootFor: { markup: '<table><tr><td>h</td></tr><For each={ list } key={ (x) => x } let={ x }><tr><td>{ x }</td></tr></For>{ ready && <tfoot><tr><td>f</td></tr></tfoot> }</table>', steps: L },
    tMixed: { markup: '<table><tr><td>h</td></tr>{ returning ? <tr><td>in</td></tr> : [<tr><td>out</td></tr>, <tfoot><tr><td>f</td></tr></tfoot>] }</table>' },
    forSecInHole: { markup: '<table><tr><td>h</td></tr>{ ready && <For each={ list } key={ (x) => x } let={ x }><tbody><tr><td>{ x }</td></tr></tbody></For> }</table>', steps: REORDER },
    showInHole: { markup: '<table><tr><td>h</td></tr>{ ready && <Show when={ !returning }><tfoot><tr><td>f</td></tr></tfoot></Show> }</table>', steps: KH },
    nestFoot: { markup: '<table><tr><td>h</td></tr>{ ready && <KFoot on={ returning }/> }</table>', extra: KFOOT, steps: KH },
    nullToFoot: { markup: '<table><tr><td>h</td></tr>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }</table>' },
    rowToFoot: { markup: '<table><tr><td>h</td></tr>{ returning ? <tfoot><tr><td>f</td></tr></tfoot> : <tr><td>r</td></tr> }</table>' },
    rowsToFoot: { markup: '<table><tr><td>h</td></tr>{ returning ? <tfoot><tr><td>f</td></tr></tfoot> : [<tr><td>r1</td></tr>, <tr><td>r2</td></tr>] }</table>' },
    rowsFoot: { markup: '<table><tr><td>h</td></tr>{ ready && [<tr><td>r1</td></tr>, <tr><td>r2</td></tr>, <tfoot><tr><td>f</td></tr></tfoot>] }</table>', steps: KH },
    bodyFoot: { markup: '<table><tr><td>h</td></tr>{ ready && [<tbody><tr><td>r1</td></tr><tr><td>r2</td></tr></tbody>, <tfoot><tr><td>f</td></tr></tfoot>] }</table>', steps: KH },
    nullToArr: { markup: '<table><tr><td>h</td></tr>{ returning && [<tr><td>x</td></tr>, <tfoot><tr><td>f</td></tr></tfoot>] }</table>' },
    fragFoot: {
        markup: '<table><tr><td>h</td></tr>{ returning && foot() }</table>',
        setup: 'const foot = () => { const f = document.createDocumentFragment(); f.appendChild(document.createElement("tfoot")).appendChild(document.createElement("tr")).appendChild(document.createElement("td")).textContent = "f"; return f; };'
    },
    rowToFootMid: { markup: '<table><tr><td>h</td></tr>{ returning ? <tfoot><tr><td>f</td></tr></tfoot> : <tr><td>r</td></tr> }<tr><td>t</td></tr></table>' },
    boundaryRow: { markup: '<table><tr><td>h</td></tr>{ returning ? <tr><td>in</td></tr> : <ErrorBoundary fallback={ (e, reset) => <tr><td>bad</td></tr> }><tr><td>out</td></tr></ErrorBoundary> }<tr><td>t</td></tr></table>' },
    showTailFoot: { markup: '<table><tr><td>h</td></tr><Show when={ ready }>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }</Show></table>', steps: TAIL },
    showRowTailFoot: { markup: '<table><tr><td>h</td></tr><Show when={ ready }><tr><td>s</td></tr>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }</Show></table>', steps: TAIL },
    matchTailFoot: { markup: '<table><tr><td>h</td></tr><Switch><Match when={ ready }>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }</Match></Switch></table>', steps: TAIL },
    compTailFoot: { markup: '<table><tr><td>h</td></tr>{ ready && <KT on={ returning }/> }</table>', extra: KT, steps: TAIL },
    showHoleTailFoot: { markup: '<table><tr><td>h</td></tr><Show when={ ready }>{ !returning && <tr><td>s</td></tr> }{ returning && <tfoot><tr><td>f</td></tr></tfoot> }</Show></table>', steps: TAIL },
    holeAfterFoot: { markup: '<table><tr><td>h</td></tr>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }{ !ready && <tr><td>x</td></tr> }</table>' },
    forAfterFoot: { markup: '<table><tr><td>h</td></tr>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }<For each={ list.filter((x) => x > 5) } key={ (x) => x } let={ x }><tr><td>{ x }</td></tr></For></table>' },
    showAfterFoot: { markup: '<table><tr><td>h</td></tr>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }<Show when={ !ready }><tr><td>s</td></tr></Show></table>' },
    bodyHoleAfterFoot: { markup: '<table><tbody><tr><td>h</td></tr></tbody>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }{ !ready && <tr><td>x</td></tr> }</table>' },
    bodyForAfterFoot: { markup: '<table><tbody><tr><td>h</td></tr></tbody>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }<For each={ list.filter((x) => x > 5) } key={ (x) => x } let={ x }><tr><td>{ x }</td></tr></For></table>' },
    bodyShowAfterFoot: { markup: '<table><tbody><tr><td>h</td></tr></tbody>{ returning && <tfoot><tr><td>f</td></tr></tfoot> }<Show when={ !ready }><tr><td>s</td></tr></Show></table>' }
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
    ${ shape.setup ?? '' }
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
    // The queued hole reads `when` itself as null before the swap closes the branch, which drops
    // its error; a let= name keeps the last truthy value.
    it('the let= form follows the value without throwing', () =>
    {
        expect(sequences('batchLet')).toEqual(everywhere('ann >  > bob!'));
    });

    it('clearing when first closes the branch before the read', () =>
    {
        expect(sequences('batchWhenFirst')).toEqual(everywhere('ann >  > bob!'));
    });

    it('a sole or multi-child read of when does not throw, and the branch closes', () =>
    {
        expect(sequences('batchSole')).toEqual(everywhere('ann >  > bob!'));
        expect(sequences('batchMulti')).toEqual(everywhere('xann >  > xbob!'));
    });
});

describe('a read on the value the same flush clears, in a branch that flush closes', () =>
{
    // The read may see the cleared value before the branch closes; its unhandled error is dropped.
    // The reader is a hole, a fallback, a kid's effect or derived value, a Dynamic or a For row.
    const cases: Array<[ShapeName, string]> = [
        ['batchMatch', 'ann >  > bob!'],
        ['batchNested', 'ann >  > bob!'],
        ['batchNestedOuter', 'ann >  > bob!'],
        ['batchHoleInHole', 'ann >  > bob!'],
        ['batchTernary', 'ann >  > bob!'],
        ['batchKidEffect', 'k >  > k'],
        ['batchKidMemo', 'ann >  > bob!'],
        ['batchDynamic', 'ann >  > bob!'],
        ['batchForIndex', '1 >  > 5!'],
        ['effectClearsOld', 'ann >  > bob!'],
        ['effectClearsYoung', 'ann >  > bob!'],
        ['innerOpensOuterClosesYoung', 'o >  > o'],
        ['youngerWriter', 'ann >  > bob!'],
        ['batchMatchMulti', 'xann >  > xbob!'],
        ['batchShowFallbackMarkup', 'ann > none > bob!'],
        ['batchSwitchFallbackMarkup', 'ann > none > bob!'],
        ['batchShowFallbackExpr', 'ann > none > bob!']
    ];

    for (const [name, seq] of cases)
    {
        it(`${ name } does not throw from the clearing write`, () =>
        {
            expect(sequences(name)).toEqual(everywhere(seq));
        });
    }

    it('innerOpensOuterClosesOld, whose older writer closes the outer branch first, closes without an error', () =>
    {
        expect(sequences('innerOpensOuterClosesOld')).toEqual(everywhere('o >  > o'));
    });
});

describe('a hole whose value holds a live inner hole or For', () =>
{
    // The outer hole clears its live range on every swap, so rows and nodes the inner hole or For
    // added go too.
    const cases: Array<[ShapeName, string]> = [
        ['kidHeadPlain', 'outx > inx >  > inx > outx'],
        ['kidHeadSole', 'outx > inx >  > inx > outx'],
        ['soleKidMid', 'xout > xin >  > xin > xout'],
        ['forInPlain', '1 > 123 >  > 123'],
        ['forInSole', '1 > 123 >  > 123']
    ];

    for (const [name, seq] of cases)
    {
        it(`${ name } clears the whole value on every swap`, () =>
        {
            expect(sequences(name)).toEqual(everywhere(seq));
        });
    }

    for (const [name, seq] of cases)
    {
        it(`${ name } hydrates in place`, () =>
        {
            const run = hydrateRun(name);
            expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq });
        });
    }

    // Each inner hole sits at an edge of the outer value.
    const deep: Array<[ShapeName, string]> = [
        ['deepHead', 'outba > inba > noa > inba > outba >  > outba'],
        ['deepHeadSole', 'outba > inba > noa > inba > outba >  > outba'],
        ['deepTailSole', 'about > abin > ano > abin > about >  > about'],
        ['innerArraySole', 'x > 12x >  > 12x > x'],
        ['forHeadSole', '1t > 123t >  > 123t > 31t'],
        ['tailSib', 'xout- > xin- > - > xin- > xout-'],
        ['twoHoles', '-outz- > -iny- > -- > -iny- > -outz-']
    ];

    for (const [name, seq] of deep)
    {
        it(`${ name } clears the whole value on every swap`, () =>
        {
            expect(sequences(name)).toEqual(everywhere(seq));
        });
    }

    it('the component in the value is cleaned up once per hide', () =>
    {
        hook.cleanups = 0;
        expect(renderRun('cleanupSole').seq).toBe('outx > inx >  > inx > outx > ');
        expect(hook.cleanups).toBe(2);
    });

    it('a value made only of inner holes hydrates in place', () =>
    {
        const run = hydrateRun('twoHoles');
        expect({ adopted: run.adopted, warned: run.warned, seq: run.seq })
            .toEqual({ adopted: true, warned: [], seq: '-outz- > -iny- > -- > -iny- > -outz-' });
    });

    it('a Portal in a hole toggles after hydration without throwing', () =>
    {
        expect(hydrateRun('portalPlain').seq).toBe(' >  >  >  > ');
    });

    it('a For in the value reorders, hides and shows with only its current rows', () =>
    {
        expect(sequences('forReorder')).toEqual(everywhere('1 > 123 > 321 >  > 321 > 2'));
    });

    it('a hole that returns the node it already shows keeps it in place', () =>
    {
        for (const ssr of [true, false])
        {
            expect(renderRun('sameInput', ssr)).toMatchObject({ seq: ' >  >  > ', input: 'connected=true value=typed focused=true' });
        }
    });

    it('a text value after an array that began with text keeps no stale node', () =>
    {
        expect(sequences('textArray')).toEqual(everywhere('t > ab > t > ab'));
    });

    it('a sole branch hole hydrates like the same hole outside a branch', () =>
    {
        expect(hydrateRun('kidHeadSole').seq).toBe(hydrateRun('kidHeadPlain').seq);
        expect(hydrateRun('forInSole').seq).toBe(hydrateRun('forInPlain').seq);
    });
});

/** Mounts a shape in one lane, points a Portal at its ul, and drives the shape's writes. */
function portalRun(name: ShapeName, lane: 'render' | 'client' | 'hydrate'): string
{
    const container = mountPoint();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let dispose = (): void => undefined;
    try
    {
        const C = compile(name, lane !== 'client');
        if (lane === 'hydrate')
        {
            container.innerHTML = renderToString(() => C());
            hydrate(() => C(), container);
        }
        else
        {
            render(() => C(), container);
        }
        const ul = container.querySelector('ul')!;
        createRoot((d) =>
        {
            dispose = d;
            container.appendChild(Portal({ target: ul, children: () => h('li', { class: 'm' }, 'm') }));
        });
        const shape: Shape = SHAPES[name];
        return drive(container, shape.steps ?? W).seq;
    }
    catch (error)
    {
        return `mount ${ errorName(error) }`;
    }
    finally
    {
        dispose();
        warn.mockRestore();
        container.remove();
    }
}

/** Counts the bulk textContent clears a tbody takes while the list empties. */
function bulkClears(name: ShapeName, ssr: boolean): string
{
    const container = mountPoint();
    try
    {
        const C = compile(name, ssr);
        render(() => C(), container);
        hook.setList?.([1, 2, 3]);
        const tbody = container.querySelector('tbody')!;
        let proto: object | null = tbody;
        let desc: PropertyDescriptor | undefined;
        while (proto !== null && desc === undefined)
        {
            desc = Object.getOwnPropertyDescriptor(proto, 'textContent');
            proto = Object.getPrototypeOf(proto) as object | null;
        }
        let bulk = 0;
        Object.defineProperty(tbody, 'textContent', {
            configurable: true,
            get(): string
            {
                return desc!.get!.call(this) as string;
            },
            set(v: string)
            {
                bulk++;
                desc!.set!.call(this, v);
            }
        });
        hook.setList?.([]);
        const cleared = container.textContent;
        hook.setList?.([4]);
        return `bulk=${ bulk } cleared=${ JSON.stringify(cleared) } then=${ container.textContent }`;
    }
    finally
    {
        container.remove();
    }
}

describe('a hole range next to foreign or merged nodes', () =>
{
    it('a Portal that targets an element filled by a lone hole keeps its content across swaps', () =>
    {
        for (const lane of ['render', 'client', 'hydrate'] as const)
        {
            expect({ lane, seq: portalRun('portalTarget', lane) }).toEqual({ lane, seq: '1m > 123m > 3m > 21m' });
            expect({ lane, seq: portalRun('portalTargetText', lane) }).toEqual({ lane, seq: 'outm > inm > outm > inm' });
        }
    });

    it('a lone hole that empties leaves its element with no child nodes', () =>
    {
        expect(sequences('portalTarget')).toEqual(everywhere('1 > 123 > 3 > 21'));
        const container = mountPoint();
        const C = compile('portalTarget', false);
        render(() => C(), container);
        hook.setList?.([]);
        expect(container.querySelector('ul')!.childNodes.length).toBe(0);
        hook.setList?.([5]);
        expect(container.textContent).toBe('5');
        container.remove();
    });

    // Server text for '' is absent and adjacent primitives merge, so these arrays rebuild inside
    // the hole. Fragments made only of holes adopt, nested or not.
    const merged: Array<[ShapeName, string]> = [
        ['sepList', '1 > 1, 2, 3 > 3 > 2, 1'],
        ['emptyLone', '1 > 3 > 1 > 2'],
        ['adjacent', '1 of 1 > 3 of 1 >  > 3 of 1'],
        ['nestEmpty', '1 > 123 > 3 > 21'],
        ['nestAdj', '1 of 1 > 3 of 123 > 1 of 3 > 2 of 21'],
        ['fragK2', '-outz- > -iny- > -- > -iny- > -outz-'],
        ['page', '-outziny- > -inyoutz- > -- > -inyoutz- > -outziny-']
    ];

    for (const [name, seq] of merged)
    {
        it(`${ name } hydrates with no fallback`, () =>
        {
            const run = hydrateRun(name);
            expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq });
            expect(sequences(name)).toEqual(everywhere(seq));
        });
    }

    it('a For alone in a tbody behind a hole keeps the bulk clear', () =>
    {
        for (const name of ['rowsFrag', 'forInTbody'] as const)
        {
            expect(sequences(name)).toEqual(everywhere('1 > 123 >  > 123'));
            for (const ssr of [true, false])
            {
                expect({ name, ssr, clear: bulkClears(name, ssr) }).toEqual({ name, ssr, clear: 'bulk=1 cleared="" then=4' });
            }
        }
    });

    it('a hole in a table with no tbody swaps its row in place after hydration', () =>
    {
        const seq = 'houtt > hint > houtt > hint';
        const run = hydrateRun('tableHole');
        expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq });
        expect(sequences('tableHole')).toEqual(everywhere(seq));
    });

    // A section in the value closes the parser's tbody, so the open anchor stays behind in it.
    const sections: Array<[ShapeName, string]> = [
        ['tFoot', 'hf > hin > hf > hin'],
        ['tFootNull', 'hf > h > hf > h'],
        ['tFootSwap', 'hout > hin > hout > hin'],
        ['tFootRow', 'hft > ht > hft > ht'],
        ['tBodyVal', 'hb > h > hb > h'],
        ['captionHide', 'hcap > h > hcap > h'],
        ['tFootFor', 'h1f > h123f > h123 > h123f']
    ];

    for (const [name, seq] of sections)
    {
        it(`${ name } after a row in a table with no tbody hydrates in place and updates`, () =>
        {
            const run = hydrateRun(name);
            expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq });
            expect(sequences(name)).toEqual(everywhere(seq));
        });
    }

    // A value led by its own markers or rows leaves them in the parser's tbody too.
    // The last element is the hydrated shape where the joined range keeps rows in the table.
    const MIXED_OUT = 'tbody@table tfoot@table foot=f bodies=1 rows=3 trs=h@tbody,out@table,f@tfoot';
    const MIXED_IN = 'tbody@table foot=- bodies=1 rows=2 trs=h@tbody,in@table';
    const led: Array<[ShapeName, string, string?]> = [
        ['forSecInHole', 'h1 > h123 > h321 > h > h321 > h2'],
        ['showInHole', 'hf > h > h > h > hf'],
        ['nestFoot', 'hout > hin > h > hin > hout'],
        ['tMixed', 'houtf > hin > houtf > hin', [MIXED_OUT, MIXED_IN, MIXED_OUT, MIXED_IN].join(' > ')]
    ];

    for (const [name, seq, shape] of led)
    {
        it(`${ name } after a row in a table with no tbody hydrates in place and keeps the table's sections`, () =>
        {
            const run = hydrateRun(name);
            expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq });
            expect(sequences(name)).toEqual(everywhere(seq));
            expect(tableShapes(name, 'hydrate')).toBe(shape ?? tableShapes(name, 'render'));
        });
    }

    // A later section moves the range's empty bounds out of the parser's tbody first, so it lands
    // in the table; a row that follows it lands there too.
    const ALONE = 'tbody@table foot=- bodies=1 rows=1 trs=h@tbody';
    const FOOT = 'tbody@table tfoot@table foot=f bodies=1 rows=2 trs=h@tbody,f@tfoot';
    const ROW_FOOT = 'tbody@table tfoot@table foot=f bodies=1 rows=3 trs=h@tbody,x@table,f@tfoot';
    const rows = (trs: string): string => `tbody@table foot=- bodies=1 rows=${ trs.split(',').length } trs=${ trs }`;
    const later: Array<[ShapeName, string, string[]]> = [
        ['nullToFoot', 'h > hf > h > hf', [ALONE, FOOT, ALONE, FOOT]],
        ['rowToFoot', 'hr > hf > hr > hf', [rows('h@tbody,r@tbody'), FOOT, rows('h@tbody,r@table'), FOOT]],
        ['rowsToFoot', 'hr1r2 > hf > hr1r2 > hf', [rows('h@tbody,r1@tbody,r2@tbody'), FOOT, rows('h@tbody,r1@table,r2@table'), FOOT]],
        ['nullToArr', 'h > hxf > h > hxf', [ALONE, ROW_FOOT, ALONE, ROW_FOOT]],
        ['fragFoot', 'h > hf > h > hf', [ALONE, FOOT, ALONE, FOOT]]
    ];

    for (const [name, seq, shape] of later)
    {
        it(`${ name } after a row in a table with no tbody puts the later section in the table`, () =>
        {
            const run = hydrateRun(name);
            expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq });
            expect(sequences(name)).toEqual(everywhere(seq));
            expect(tableShapes(name, 'hydrate')).toBe(shape.join(' > '));
        });
    }

    // A hole at the end of a Show branch, a Match or a component in a hole takes that range, rows
    // included, into the table with it, so a later section lands where the parser puts it.
    const LED_FOOT = (row: string): string => `tbody@table tfoot@table foot=f bodies=1 rows=3 trs=h@tbody,${ row }@table,f@tfoot`;
    const ledBy = (row: string): string[] => [rows(`h@tbody,${ row }@tbody`), LED_FOOT(row), rows(`h@tbody,${ row }@table`), LED_FOOT(row), ALONE, LED_FOOT(row)];
    const nested: Array<[ShapeName, string, string[]]> = [
        ['showTailFoot', 'h > hf > h > hf > h > hf', [ALONE, FOOT, ALONE, FOOT, ALONE, FOOT]],
        ['matchTailFoot', 'h > hf > h > hf > h > hf', [ALONE, FOOT, ALONE, FOOT, ALONE, FOOT]],
        ['showRowTailFoot', 'hs > hsf > hs > hsf > h > hsf', ledBy('s')],
        ['compTailFoot', 'hk > hkf > hk > hkf > h > hkf', ledBy('k')],
        ['showHoleTailFoot', 'hs > hf > hs > hf > h > hf', [rows('h@tbody,s@tbody'), FOOT, rows('h@tbody,s@table'), FOOT, ALONE, FOOT]]
    ];

    for (const [name, seq, shape] of nested)
    {
        it(`${ name } after a row in a table with no tbody puts a later section in the table`, () =>
        {
            const run = hydrateRun(name);
            expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq });
            expect(sequences(name)).toEqual(everywhere(seq));
            expect(tableShapes(name, 'hydrate')).toBe(shape.join(' > '));
        });
    }

    it('a hole followed by an empty hole, For or Show in a table with no tbody puts a later section in the table', () =>
    {
        // The empty range moves into the table with the hole, so the section lands as it does
        // after an explicit tbody.
        const foot = [ALONE, FOOT, ALONE, FOOT].join(' > ');
        for (const name of ['holeAfterFoot', 'forAfterFoot', 'showAfterFoot'] as const)
        {
            expect({ name, seq: hydrateRun(name).seq, shape: tableShapes(name, 'hydrate') }).toEqual({ name, seq: 'h > hf > h > hf', shape: foot });
        }
        for (const name of ['bodyHoleAfterFoot', 'bodyForAfterFoot', 'bodyShowAfterFoot'] as const)
        {
            expect({ name, shape: tableShapes(name, 'hydrate') }).toEqual({ name, shape: foot });
        }
    });

    it('a hole followed by a row in a table with no tbody keeps its place when a section arrives', () =>
    {
        // The section stays in the parser's tbody there, keeping the hole's place before the row.
        const run = hydrateRun('rowToFootMid');
        expect({ adopted: run.adopted, warned: run.warned, seq: run.seq }).toEqual({ adopted: true, warned: [], seq: 'hrt > hft > hrt > hft' });
    });

    it('an ErrorBoundary in a hole after a row in a table with no tbody hydrates and swaps its row', () =>
    {
        // The boundary builds its own content again when it hydrates, in a table or not.
        const run = hydrateRun('boundaryRow');
        expect({ warned: run.warned, seq: run.seq }).toEqual({ warned: [], seq: 'houtt > hint > houtt > hint' });
        expect(sequences('boundaryRow')).toEqual(everywhere('houtt > hint > houtt > hint'));
    });

    it('a value or a Show branch that starts with rows and then holds a table section moves those rows out of the parser tbody', () =>
    {
        // The rows and the section cannot share the tbody the browser inserted; an explicit tbody
        // keeps its rows. The move uses moveBefore where it exists; a refused move still inserts.
        const split = 'tbody@table tfoot@table foot=f bodies=1 rows=4 trs=h@tbody,r1@table,r2@table,f@tfoot';
        expect(tableShapes('rowsFoot', 'hydrate')).toBe([split, split, ALONE, split, split].join(' > '));
        expect(tableShapes('bodyFoot', 'hydrate')).toBe(tableShapes('bodyFoot', 'render'));
        const proto = Element.prototype as { moveBefore?: (node: Node, child: Node | null) => void };
        const movers: Array<[ShapeName, string, string]> = [
            ['rowsFoot', 'hr1r2f > hr1r2f > h > hr1r2f > hr1r2f', '#comment,TR,TR'],
            ['showRowTailFoot', 'hs > hsf > hs > hsf > h > hsf', '#comment,TR,#comment,#comment,#comment']
        ];
        for (const [name, seq, nodes] of movers)
        {
            for (const refuse of [false, true])
            {
                const moved: string[] = [];
                proto.moveBefore = function (this: Element, node: Node, child: Node | null): void
                {
                    moved.push(node.nodeName);
                    if (refuse)
                    {
                        throw new DOMException('refused', 'HierarchyRequestError');
                    }
                    this.insertBefore(node, child);
                };
                try
                {
                    const run = hydrateRun(name);
                    expect({ name, refuse, adopted: run.adopted, warned: run.warned, seq: run.seq, moved: moved.join(',') })
                        .toEqual({ name, refuse, adopted: true, warned: [], seq, moved: nodes });
                }
                finally
                {
                    delete proto.moveBefore;
                }
            }
        }
    });
});

const tagOf = (el: Element | null): string => el?.tagName.toLowerCase() ?? '';

/** A table's sections and their parents, first tfoot, tbody and row counts, and row parents. */
function tableShape(root: Element): string
{
    const table = root.querySelector('table');
    const kids = table === null ? [] : [...table.children];
    const sections = table === null ? [] : [...table.querySelectorAll('thead, tbody, tfoot, caption')].map((el) => `${ tagOf(el) }@${ tagOf(el.parentElement) }`);
    const rows = kids.flatMap((el) => (tagOf(el) === 'tr' ? [el] : [...el.children].filter((row) => tagOf(row) === 'tr')));
    const foot = kids.find((el) => tagOf(el) === 'tfoot')?.textContent ?? '-';
    const parents = table === null ? [] : [...table.querySelectorAll('tr')].map((row) => `${ row.textContent }@${ tagOf(row.parentElement) }`);
    return `${ sections.join(' ') } foot=${ foot } bodies=${ kids.filter((el) => tagOf(el) === 'tbody').length } rows=${ rows.length } trs=${ parents.join(',') }`;
}

/**
 * The table shape after mount and after every write: hydrated as it stands, rendered as the parser
 * reads it back.
 */
function tableShapes(name: ShapeName, lane: 'render' | 'hydrate'): string
{
    const container = mountPoint();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const read = (): string =>
    {
        if (lane === 'hydrate')
        {
            return tableShape(container);
        }
        const parsed = document.createElement('div');
        parsed.innerHTML = container.innerHTML;
        return tableShape(parsed);
    };
    try
    {
        const C = compile(name);
        if (lane === 'hydrate')
        {
            container.innerHTML = renderToString(() => C());
            hydrate(() => C(), container);
        }
        else
        {
            render(() => C(), container);
        }
        const seq = [read()];
        const shape: Shape = SHAPES[name];
        for (const step of shape.steps ?? W)
        {
            step();
            seq.push(read());
        }
        return seq.join(' > ');
    }
    finally
    {
        warn.mockRestore();
        container.remove();
    }
}
