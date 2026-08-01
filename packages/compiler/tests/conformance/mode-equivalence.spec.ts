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
