/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A render window owns its head and style frame. A host that constructs a RenderFrame and
// passes it through the render options drains EXACTLY that render's output, under any
// interleaving - the shape the old module-global frame could not represent, and the one
// through which one request's head could be served inside another request's document. The
// zero-argument drains keep working through a legacy slot that serves one synchronous
// render at a time and fails CLOSED under ambiguity: dropped, diagnosed, never
// cross-served - while the app-static registry always survives.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Suspense,
    createRenderFrame,
    createResource,
    collectStyleSheet,
    css,
    h,
    renderToStream,
    renderToString,
    resetStyleSheet,
    runInMode,
    useHead
} from 'azerothjs';
import { collectHead, registerStyle, resetHead } from 'azerothjs/internal';

beforeEach(() =>
{
    resetHead();
    resetStyleSheet();
    vi.restoreAllMocks();
});

let seq = 0;
const uniqueCss = (label: string): string => `.frame-spec-${ label }-${ seq++ } { color: rgb(1, 2, 3); }`;

function page(title: string, cssText: string): () => HTMLElement
{
    return () =>
    {
        useHead({ title });
        css([cssText] as unknown as TemplateStringsArray);
        return h('div', {}, 'body');
    };
}

describe('frame-owning hosts drain exactly their own render', () =>
{
    it('two renders, both completed before either drains, each collect their own head and styles', () =>
    {
        const a = createRenderFrame();
        const b = createRenderFrame();
        const cssA = uniqueCss('a');
        const cssB = uniqueCss('b');
        renderToString(page('TITLE-A', cssA), { frame: a });
        renderToString(page('TITLE-B', cssB), { frame: b });

        const stylesA = collectStyleSheet(a);
        const stylesB = collectStyleSheet(b);
        expect(collectHead({ frame: a }).titleText).toBe('TITLE-A');
        expect(collectHead({ frame: b }).titleText).toBe('TITLE-B');
        expect(stylesA).toContain('frame-spec-a');
        expect(stylesA).not.toContain('frame-spec-b');
        expect(stylesB).toContain('frame-spec-b');
        expect(stylesB).not.toContain('frame-spec-a');
    });

    it('a frame drain is a pure read: draining twice is harmless and identical', () =>
    {
        const frame = createRenderFrame();
        renderToString(page('TITLE-TWICE', uniqueCss('twice')), { frame });
        expect(collectStyleSheet(frame)).toBe(collectStyleSheet(frame));
        expect(collectHead({ frame }).titleText).toBe('TITLE-TWICE');
        expect(collectHead({ frame }).titleText).toBe('TITLE-TWICE');
    });

    it('a throwing render leaves its host an EMPTY frame - a caught error page cannot inherit the dead render\'s head', () =>
    {
        const frame = createRenderFrame();
        expect(() => renderToString(() =>
        {
            useHead({ title: 'DEAD-RENDER' });
            throw new Error('render died');
        }, { frame })).toThrow('render died');
        expect(collectHead({ frame }).titleText).toBeNull();
        // The same frame is reusable for the error page, clean.
        renderToString(page('ERROR-PAGE', uniqueCss('err')), { frame });
        expect(collectHead({ frame }).titleText).toBe('ERROR-PAGE');
    });
});

describe('the legacy zero-argument drains', () =>
{
    it('the safe case is byte-identical: one render, styles drained, then head drained - both present', () =>
    {
        const cssText = uniqueCss('safe');
        renderToString(page('SAFE-TITLE', cssText));
        const styles = collectStyleSheet();
        const head = collectHead();
        expect(styles).toContain('frame-spec-safe');
        expect(head.titleText).toBe('SAFE-TITLE');
    });

    it('a styles-only host never strands the slot: every render\'s styles arrive, no diagnostic', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        renderToString(() =>
        {
            css([uniqueCss('so1')] as unknown as TemplateStringsArray);
            return h('div', {}, 'x');
        });
        expect(collectStyleSheet()).toContain('frame-spec-so1');
        renderToString(() =>
        {
            css([uniqueCss('so2')] as unknown as TemplateStringsArray);
            return h('div', {}, 'x');
        });
        // Pre-fix-shape hazard: the first render's EMPTY head payload must not count as
        // outstanding, or this second seal trips clear-both and loses these styles.
        expect(collectStyleSheet()).toContain('frame-spec-so2');
        expect(warn.mock.calls.some((c) => /BOTH were dropped/.test(String(c[0])))).toBe(false);
    });

    it('two un-drained renders fail CLOSED: both dropped, diagnosed, never cross-served - and app-static survives', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        registerStyle(`.frame-spec-appstatic-${ seq } { color: rgb(9, 9, 9); }`);
        renderToString(page('SECRET-FIRST', uniqueCss('amb1')));
        renderToString(page('SECOND', uniqueCss('amb2')));
        const styles = collectStyleSheet();
        const head = collectHead();
        // Neither render's data reaches any document...
        expect(head.titleText).not.toBe('SECRET-FIRST');
        expect(head.titleText).toBeNull();
        expect(styles).not.toContain('frame-spec-amb1');
        expect(styles).not.toContain('frame-spec-amb2');
        // ...but the app-static registry is served untouched: the fail-closed drop is a
        // FRAME event, never "the function returns empty".
        expect(styles).toContain('frame-spec-appstatic');
        expect(warn.mock.calls.some((c) => /BOTH were dropped/.test(String(c[0])))).toBe(true);
    });

    it('an un-migrated THROW never seals: the next clean render is served, no ghost clear-both', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(() => renderToString(() =>
        {
            useHead({ title: 'DEAD' });
            throw new Error('boom');
        })).toThrow('boom');
        renderToString(page('CLEAN-AFTER-THROW', uniqueCss('cat')));
        expect(collectHead().titleText).toBe('CLEAN-AFTER-THROW');
        expect(warn.mock.calls.some((c) => /BOTH were dropped/.test(String(c[0])))).toBe(false);
    });

    it('a stray string-mode write with no render window reaches the zero-argument drain, as before', () =>
    {
        const cssText = uniqueCss('stray');
        runInMode('string', () =>
        {
            css([cssText] as unknown as TemplateStringsArray);
            return null;
        });
        expect(collectStyleSheet()).toContain('frame-spec-stray');
    });

    it('an unsealed stray frame is silently overwritten by a real render\'s seal - the rotation semantics', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        runInMode('string', () =>
        {
            css([uniqueCss('lost')] as unknown as TemplateStringsArray);
            return null;
        });
        renderToString(page('REAL', uniqueCss('real')));
        const styles = collectStyleSheet();
        expect(styles).toContain('frame-spec-real');
        expect(styles).not.toContain('frame-spec-lost');
        expect(collectHead().titleText).toBe('REAL');
        expect(warn.mock.calls.some((c) => /BOTH were dropped/.test(String(c[0])))).toBe(false);
    });
});

describe('nested renders', () =>
{
    it('a zero-frame render nested inside a migrated render is discarded with a diagnostic - never sealed into module state', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const outer = createRenderFrame();
        renderToString(() =>
        {
            useHead({ title: 'OUTER' });
            // The nested zero-frame render: its request-derived head must not outlive
            // this request in the legacy slot.
            renderToString(() =>
            {
                useHead({ title: 'NESTED-SECRET' });
                return h('i', {}, 'inner');
            });
            return h('div', {}, 'outer');
        }, { frame: outer });
        expect(collectHead({ frame: outer }).titleText).toBe('OUTER');
        // The slot holds nothing: a later zero-arg drain cannot receive the nested head.
        expect(collectHead().titleText).toBeNull();
        expect(warn.mock.calls.some((c) => /could not reach this response/.test(String(c[0])))).toBe(true);
    });

    it('a frame-supplied nested render composes: the inner host drains its own frame', () =>
    {
        const outer = createRenderFrame();
        const inner = createRenderFrame();
        renderToString(() =>
        {
            useHead({ title: 'OUTER-2' });
            renderToString(() =>
            {
                useHead({ title: 'INNER-2' });
                return h('i', {}, 'inner');
            }, { frame: inner });
            return h('div', {}, 'outer');
        }, { frame: outer });
        expect(collectHead({ frame: outer }).titleText).toBe('OUTER-2');
        expect(collectHead({ frame: inner }).titleText).toBe('INNER-2');
    });
});

describe('the legacy slot: reset, append, and mid-render rules', () =>
{
    it('the resets are per-payload: resetStyleSheet clears only the slot css, resetHead is the hammer', () =>
    {
        renderToString(page('RESET-TITLE', uniqueCss('reset')));
        resetStyleSheet();
        // The css payload is gone; the head payload survives its sibling's reset.
        expect(collectStyleSheet()).not.toContain('frame-spec-reset');
        expect(collectHead().titleText).toBe('RESET-TITLE');
        renderToString(page('HAMMER', uniqueCss('hammer')));
        resetHead();
        // The hammer clears stack AND slot: nothing survives.
        expect(collectHead().titleText).toBeNull();
        expect(collectStyleSheet()).not.toContain('frame-spec-hammer');
    });

    it('a stray write onto a SEALED slot frame appends and re-marks its payload unconsumed', () =>
    {
        renderToString(page('SEAL-THEN-STRAY', uniqueCss('sts')));
        // Consume the css half; the head half is still outstanding.
        expect(collectStyleSheet()).toContain('frame-spec-sts');
        // The stray append re-marks css unconsumed - it holds new data.
        const appended = uniqueCss('appended');
        runInMode('string', () =>
        {
            css([appended] as unknown as TemplateStringsArray);
            return null;
        });
        expect(collectStyleSheet()).toContain('frame-spec-appended');
        expect(collectHead().titleText).toBe('SEAL-THEN-STRAY');
    });

    it('a mid-render resetStyleSheet diagnoses and leaves the live window its frame', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const frame = createRenderFrame();
        renderToString(() =>
        {
            css([uniqueCss('live')] as unknown as TemplateStringsArray);
            resetStyleSheet();
            return h('div', {}, 'x');
        }, { frame });
        expect(collectStyleSheet(frame)).toContain('frame-spec-live');
        expect(warn.mock.calls.some((c) => /during a render/.test(String(c[0])))).toBe(true);
    });
});

describe('the streamed host that yields before draining - the loss shape, closed', () =>
{
    it('a boundary settling after CANCEL opens no window: later renders are unaffected', async () =>
    {
        let resolveLate!: (value: string) => void;
        const late = new Promise<string>((resolve) =>
        {
            resolveLate = resolve;
        });
        const frame = createRenderFrame();
        const stream = renderToStream(() =>
        {
            const resource = createResource<string>(() => late);
            return Suspense({
                fallback: () => h('i', {}, 'loading'),
                on: [resource],
                children: () => h('b', {}, resource.data() ?? '')
            });
        }, { frame });
        const reader = stream.getReader();
        await reader.read();
        await reader.cancel();
        // The boundary settles AFTER finalize: the drive gate returns before any window
        // opens - a window pushed above the gate would never close, and the dead frame
        // on the stack would make every later render look NESTED and discard.
        resolveLate('late');
        await new Promise((resolve) => setTimeout(resolve, 20));
        renderToString(page('AFTER-CANCEL', uniqueCss('ac')));
        expect(collectHead().titleText).toBe('AFTER-CANCEL');
        expect(collectStyleSheet()).toContain('frame-spec-ac');
    });

    it('a fast-settling boundary cannot cost the main pass its own head and styles', async () =>
    {
        const frame = createRenderFrame();
        const cssText = uniqueCss('stream');
        const stream = renderToStream(() =>
        {
            useHead({ title: 'STREAM-OWN-TITLE' });
            css([cssText] as unknown as TemplateStringsArray);
            const resource = createResource<string>(() => Promise.resolve('fast'));
            return Suspense({
                fallback: () => h('i', {}, 'loading'),
                on: [resource],
                children: () => h('b', {}, resource.data() ?? '')
            });
        }, { frame });
        // The host yields a macrotask - well past the measured 4-tick loss window - while
        // the fast boundary settles and its continuation runs.
        await new Promise((resolve) => setTimeout(resolve, 25));
        const styles = collectStyleSheet(frame);
        const head = collectHead({ frame });
        expect(head.titleText).toBe('STREAM-OWN-TITLE');
        expect(styles).toContain('frame-spec-stream');
        await stream.getReader().cancel();
    });
});
