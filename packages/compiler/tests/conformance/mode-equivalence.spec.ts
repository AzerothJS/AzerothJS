// @vitest-environment happy-dom
//
// The cross-mode conformance suite: for every program the language accepts, client render,
// SSR string + hydration, and the manual h() API must be observationally equivalent, and the
// programs the language rejects must be rejected by ONE rule everywhere. Assertions compare
// modes to EACH OTHER wherever possible, so the suite pins the contract, not an implementation;
// a future rewrite must pass it without reading compiler or runtime internals.
import { describe, it, expect } from 'vitest';
import { render, hydrate, renderToString, h, createSignal } from 'azerothjs';
import { generateModule } from '../../src/codegen.ts';
import { compileComponent, type CompiledComponent } from './executor.ts';

const CLICKER_ELEMENT = compileComponent(
    'component ClickerElement(props) { <button onClick={ props.press }>hit</button> }',
    'ClickerElement');
const CLICKER_FRAGMENT = compileComponent(
    'component ClickerFragment(props) { <><button onClick={ props.press }>hit</button></> }',
    'ClickerFragment');
const FOCUSER = compileComponent(
    'component Focuser(props) { <button onFocus={ props.noticed }>f</button> }',
    'Focuser');
const VALUED = compileComponent(
    'component Valued(props) { <input value={ props.v } /> }',
    'Valued');
const TOGGLED = compileComponent(
    'component Toggled(props) { <button disabled={ props.on }>x</button> }',
    'Toggled');
const MIXED = compileComponent(
    'component Mixed(props) { <div><span>a</span>{ props.t }<span>b</span></div> }',
    'Mixed');

/** A container mounted in the document, optionally behind an ancestor that stops click propagation. */
function host(blockClicks: boolean): { container: HTMLElement; dispose: () => void }
{
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    if (blockClicks)
    {
        wrapper.addEventListener('click', (e) => e.stopPropagation());
    }
    const container = document.createElement('div');
    wrapper.appendChild(container);
    return { container, dispose: () => wrapper.remove() };
}

interface ClickOutcome
{
    calls: number;
    currentTargetWasButton: boolean;
}

/** Clicks the rendered button once and reports what the handler observed. */
function clickOutcome(mount: (app: () => unknown, container: HTMLElement) => void, component: CompiledComponent, blockClicks: boolean): ClickOutcome
{
    let calls = 0;
    let currentTargetWasButton = false;
    const { container, dispose } = host(blockClicks);
    const app = (): unknown => component({
        press: (e: Event) =>
        {
            calls += 1;
            currentTargetWasButton = e.currentTarget === container.querySelector('button');
        }
    });
    mount(app, container);
    container.querySelector('button')!.click();
    dispose();
    return { calls, currentTargetWasButton };
}

function mountCsr(app: () => unknown, container: HTMLElement): void
{
    render(app as () => HTMLElement, container);
}

function mountHydrated(app: () => unknown, container: HTMLElement): void
{
    container.innerHTML = renderToString(app as () => HTMLElement);
    hydrate(app as () => HTMLElement, container);
}

describe('event attachment is ONE model across every mode', () =>
{
    const manualH: CompiledComponent = (props = {}) =>
        h('button', { onClick: props['press'] }, 'hit');

    const surfaces: [string, () => ClickOutcome[]][] = [
        ['unblocked', () => [
            clickOutcome(mountCsr, CLICKER_ELEMENT, false),
            clickOutcome(mountCsr, CLICKER_FRAGMENT, false),
            clickOutcome(mountHydrated, CLICKER_ELEMENT, false),
            clickOutcome(mountHydrated, CLICKER_FRAGMENT, false),
            clickOutcome(mountCsr, manualH, false),
            clickOutcome(mountHydrated, manualH, false)
        ]],
        ['behind an ancestor stopPropagation', () => [
            clickOutcome(mountCsr, CLICKER_ELEMENT, true),
            clickOutcome(mountCsr, CLICKER_FRAGMENT, true),
            clickOutcome(mountHydrated, CLICKER_ELEMENT, true),
            clickOutcome(mountHydrated, CLICKER_FRAGMENT, true),
            clickOutcome(mountCsr, manualH, true),
            clickOutcome(mountHydrated, manualH, true)
        ]]
    ];

    it('a clean click fires the handler exactly once everywhere, with currentTarget = the element', () =>
    {
        const outcomes = surfaces[0]![1]();
        for (const outcome of outcomes)
        {
            expect(outcome.calls).toBe(1);
            expect(outcome.currentTargetWasButton).toBe(true);
        }
    });

    it('interposed stopPropagation suppresses (or passes) the handler IDENTICALLY everywhere', () =>
    {
        const outcomes = surfaces[1]![1]();
        const calls = outcomes.map((o) => o.calls);
        // The contract is parity, and the documented model is delegation for the delegated
        // set: a direct ancestor listener that stops propagation runs before the document
        // dispatcher, so the click never arrives. 0 everywhere.
        expect(calls).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it('a non-delegated event (focus) attaches directly and fires identically everywhere', () =>
    {
        const measure = (mount: (app: () => unknown, container: HTMLElement) => void): number =>
        {
            let calls = 0;
            const { container, dispose } = host(false);
            mount(() => FOCUSER({ noticed: () => (calls += 1) }), container);
            container.querySelector('button')!.dispatchEvent(new Event('focus'));
            dispose();
            return calls;
        };
        expect([measure(mountCsr), measure(mountHydrated)]).toEqual([1, 1]);
    });
});

describe('the reserved host on* namespace is a rejected program', () =>
{
    for (const name of ['onpaste', 'once', 'ONCLICK', 'onward-link'])
    {
        it(`\`${ name }\` on a host element is a compile error naming the rule`, () =>
        {
            expect(() => generateModule(`component C(props) { <button ${ name }={ props.x }>go</button> }`))
                .toThrow(/reserved for event handlers/);
        });
    }

    it('the error carries the mechanical camelCase fix when one exists', () =>
    {
        expect(() => generateModule('component C(props) { <button onpaste={ props.x }>go</button> }'))
            .toThrow(/onPaste/);
    });

    it('the same names stay ORDINARY PROPS on components (verbatim key domain)', () =>
    {
        const code = generateModule('import Foo from "./Foo.azeroth"; component C(props) { <Foo onpaste={ props.x } /> }').code;
        expect(code).toContain('onpaste');
    });

    it('h() refuses a reserved key with the same rule in DOM and string mode', () =>
    {
        expect(() => h('button', { onclick: () => 1 }, 'x')).toThrow(/reserved for event handlers/);
        expect(() => renderToString(() => h('button', { onclick: () => 1 }, 'x')))
            .toThrow(/reserved for event handlers/);
    });
});

describe('content properties own the element content exclusively', () =>
{
    it('innerHTML plus markup children is a compile error, for BOTH root shapes', () =>
    {
        expect(() => generateModule('component C { <div innerHTML={ "<b>rich</b>" }>plain</div> }'))
            .toThrow(/mutually exclusive/);
        expect(() => generateModule('component C { <><div innerHTML={ "<b>rich</b>" }>plain</div></> }'))
            .toThrow(/mutually exclusive/);
    });

    it('textContent plus children is rejected by the same rule', () =>
    {
        expect(() => generateModule('component C { <div textContent={ "t" }><span>x</span></div> }'))
            .toThrow(/mutually exclusive/);
    });

    it('h() enforces the same exclusivity in DOM and string mode', () =>
    {
        expect(() => h('div', { innerHTML: '<b>rich</b>' }, 'plain')).toThrow(/mutually exclusive/);
        expect(() => renderToString(() => h('div', { innerHTML: '<b>rich</b>' }, 'plain')))
            .toThrow(/mutually exclusive/);
    });

    it('innerHTML WITHOUT children stays legal and equivalent across modes', () =>
    {
        const richDiv = compileComponent('component RichDiv { <div innerHTML={ "<b>rich</b>" }></div> }', 'RichDiv');
        const { container, dispose } = host(false);
        render(() => richDiv({}) as HTMLElement, container);
        const csrHtml = container.querySelector('div')!.innerHTML;
        dispose();
        expect(csrHtml).toBe('<b>rich</b>');
        expect(renderToString(() => richDiv({}) as HTMLElement, { markers: false }))
            .toBe('<div><b>rich</b></div>');
    });
});

describe('void elements cannot have children', () =>
{
    it('markup children on a void element are a located parse error, not garbage code', () =>
    {
        expect(() => generateModule('component C { <input>text</input> }'))
            .toThrow(/void element/i);
    });

    it('h() rejects void children with the same rule in DOM and string mode', () =>
    {
        expect(() => h('input', {}, 'text')).toThrow(/void element/i);
        expect(() => renderToString(() => h('input', {}, 'text'))).toThrow(/void element/i);
    });
});

describe('handler-form values must be functions, one rule in every mode', () =>
{
    it('a non-function handler value throws the same rule in CSR, SSR, and h()', () =>
    {
        const bad = (): unknown => CLICKER_ELEMENT({ press: 42 });
        const { container, dispose } = host(false);
        expect(() => render(bad as () => HTMLElement, container)).toThrow(/function/);
        dispose();
        expect(() => renderToString(bad as () => HTMLElement)).toThrow(/function/);
        expect(() => h('button', { onClick: 42 }, 'x')).toThrow(/function/);
    });

    it('a nullish handler is a no-op everywhere, never an error', () =>
    {
        const quiet = (): unknown => CLICKER_ELEMENT({ press: undefined });
        const { container, dispose } = host(false);
        render(quiet as () => HTMLElement, container);
        container.querySelector('button')!.click();
        const csrHtml = container.innerHTML;
        dispose();
        expect(csrHtml).toContain('hit');
        expect(renderToString(quiet as () => HTMLElement, { markers: false })).toContain('hit');
    });
});

describe('property vs attribute semantics agree across modes', () =>
{
    it('value lands as the live property on the client and the matching attribute on the server', () =>
    {
        const { container, dispose } = host(false);
        render(() => VALUED({ v: 'typed' }) as HTMLElement, container);
        const csrValue = container.querySelector('input')!.value;
        dispose();
        expect(csrValue).toBe('typed');
        expect(renderToString(() => VALUED({ v: 'typed' }) as HTMLElement, { markers: false }))
            .toContain('value="typed"');

        const hydratedHost = host(false);
        mountHydrated(() => VALUED({ v: 'typed' }), hydratedHost.container);
        expect(hydratedHost.container.querySelector('input')!.value).toBe('typed');
        hydratedHost.dispose();
    });

    it('a boolean attribute is present when true and absent when false, in every mode', () =>
    {
        const { container, dispose } = host(false);
        render(() => TOGGLED({ on: true }) as HTMLElement, container);
        const onDisabled = container.querySelector('button')!.disabled;
        dispose();
        expect(onDisabled).toBe(true);
        expect(renderToString(() => TOGGLED({ on: true }) as HTMLElement, { markers: false }))
            .toContain('disabled');
        expect(renderToString(() => TOGGLED({ on: false }) as HTMLElement, { markers: false }))
            .not.toContain('disabled');
    });
});

describe('children placement is identical across modes and root shapes', () =>
{
    it('static + dynamic children interleave the same everywhere', () =>
    {
        const { container, dispose } = host(false);
        render(() => MIXED({ t: 'MID' }) as HTMLElement, container);
        const csrText = container.textContent;
        dispose();

        const hydratedHost = host(false);
        mountHydrated(() => MIXED({ t: 'MID' }), hydratedHost.container);
        const hydratedText = hydratedHost.container.textContent;
        hydratedHost.dispose();

        expect(csrText).toBe('aMIDb');
        expect(hydratedText).toBe(csrText);
    });

    it('reactive updates after hydration patch the adopted nodes in place', () =>
    {
        const [t, setT] = createSignal('one');
        const { container, dispose } = host(false);
        mountHydrated(() => MIXED({ t }), container);
        expect(container.textContent).toBe('aoneb');
        setT('two');
        expect(container.textContent).toBe('atwob');
        dispose();
    });
});

// GRAMMAR 6.6 binds the template CLONE as well as h(): a value one mode refuses cannot be
// written by another. The clone is fed by a folded template no runtime writer inspects, and
// in a `dom`-target build the gated h() branch is never emitted at all - so before this rule
// the SAME SOURCE threw in SSR and rendered on the client. Recorded pre-fix red run, measured
// through the real compiler and runtime:
//
//   <a href="javascript:alert(1)">   CSR: <a href="javascript:alert(1)">   SSR: THREW
//   <div onClick="alert(1)">         CSR: <div onclick="alert(1)">         SSR: THREW
//   <base href="//evil.test/">       CSR: rendered                         SSR: THREW
//   <iframe srcdoc="...">            CSR: rendered                         SSR: THREW
//   <script>alert(1)</script>        CSR: rendered                         SSR: THREW
//
// The rejected corpus below pins each family at BUILD time, where the clone can be reached.
describe('render-safety binds every writer, the folded template included', () =>
{
    const REJECTED: ReadonlyArray<readonly [string, string, RegExp]> = [
        ['an executable URL scheme', '<a href="javascript:alert(1)">x</a>', /would\s+execute this URL/],
        ['a CONSTANT-FOLDED URL, which lands in the same template', '<a href={ "javascript:" + "alert(1)" }>x</a>', /would\s+execute this URL/],
        ['a non-image data: URL', '<a href="data:text/html,<script>alert(1)</script>">x</a>', /would\s+execute this URL/],
        ['an SVG data URL outside an image context', '<a href="data:image/svg+xml,x">y</a>', /would\s+execute this URL/],
        ['srcdoc, an inline document', '<iframe srcdoc="<img onerror=alert(1)>"></iframe>', /inline DOCUMENT/],
        ['a refused tag', '<div><base href="//evil.test/" /></div>', /refusing to render <base>/],
        ['an executable script', '<div><script>alert(1)</script></div>', /executable <script>/],
        ['a handler-form name given a STRING, the one shape that yields live code', '<div onClick="alert(1)">x</div>', /expects a function handler/],
        ['an off-origin meta refresh, dangerous only as a PAIR', '<meta http-equiv="refresh" content="0;url=https://evil.test/" />', /leaves this app's origin/],
        ['a meta refresh in the spelling with no url= token', '<meta http-equiv="refresh" content="0;https://evil.test/" />', /leaves this app's origin/]
    ];

    for (const [label, markup, rule] of REJECTED)
    {
        it(`refuses ${ label } at build time, in both compile targets`, () =>
        {
            const source = `component C() { ${ markup } }`;
            expect(() => generateModule(source)).toThrow(rule);
            // The dom-only target is the shape with NO gated branch at all, so a rule that
            // only held for the universal target would leave it unreachable everywhere.
            expect(() => generateModule(source, 'C.azeroth', { ssr: false })).toThrow(rule);
        });
    }

    // The non-vacuous half: programs the gate ACCEPTS must still compile and agree across
    // modes. Without these the corpus above could pass by refusing everything.
    const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
        ['an inline image data URL on <img src>', '<img src="data:image/png;base64,AAAA" />'],
        ['an SVG data URL where the browser renders it as an image', '<img src="data:image/svg+xml,%3Csvg%3E" />'],
        ['a data-block script', '<div><script type="application/ld+json">{}</script></div>'],
        ['a script whose type is dynamic, which the runtime gate judges instead', '<div><script type={ t }>{ "{}" }</script></div>'],
        ['an ordinary relative URL', '<a href="/docs">x</a>'],
        ['a handler given a function', '<div onClick={ go }>x</div>'],
        ['a SAME-ORIGIN meta refresh, which navigates nowhere it should not', '<meta http-equiv="refresh" content="3;url=/next" />'],
        ['an absolute og:url, where content is not a navigation directive', '<meta property="og:url" content="https://example.com/a" />'],
        ['a refresh whose content is dynamic, which the runtime gate judges instead', '<meta http-equiv="refresh" content={ t } />']
    ];

    for (const [label, markup] of ACCEPTED)
    {
        it(`accepts ${ label }`, () =>
        {
            const source = `component C() { const t = "application/ld+json"; const go = () => undefined; ${ markup } }`;
            expect(() => generateModule(source)).not.toThrow();
            expect(() => generateModule(source, 'C.azeroth', { ssr: false })).not.toThrow();
        });
    }

    it('leaves an author-vetted value alone: unsafeUrl is an expression and never folds', () =>
    {
        const source = 'import { unsafeUrl } from "azerothjs";'
            + ' component C() { <a href={ unsafeUrl("javascript:void(0)") }>legacy</a> }';
        expect(() => generateModule(source)).not.toThrow();
        // It must reach the runtime BRANDED rather than be baked into the clone: the
        // template carries no href at all, and both writers receive the unsafeUrl call.
        const code = generateModule(source).code;
        expect(code).toContain("tmpl('<a>legacy</a>')");
        expect(code).toContain('unsafeUrl("javascript:void(0)")');
    });
});
