/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The document-head runtime: one registry with three faces.
 *
 *   - useHead(input)   registers a component's head declarations. In string mode every
 *                      value resolves IMMEDIATELY, untracked, inside the request's store
 *                      scope, and the resolved data lands in a per-request frame. On the
 *                      client (dom and hydrate alike) the entry joins per-key stacks and
 *                      winner-gated effects keep document.head in sync.
 *   - collectHead()    the SSR drain: computes winners, composes the title, serializes
 *                      replacements and additions. Invokes NO user code - everything was
 *                      resolved at registration - so it needs no scope at its call site.
 *   - the applier      per-entry, per-key effects owned by the registering component's
 *                      scope. A key's element is adopted from server markup by its
 *                      `data-azeroth-head` marker or created through document.createElement
 *                      under the render-safety gate - NEVER through h(), which is
 *                      mode-dispatched and returns descriptors during the hydration walk.
 *
 * Precedence is registration order: construction is top-down, so a leaf registers after
 * its layout and wins singletons; disposal pops and the key falls back. The document
 * title composes through ONE shared routine over both stacks' winner entries.
 */

import { createEffect, createSignal, onRootDispose, isStringMode, untrack } from '../reactivity/index.ts';
import { DEV } from '../reactivity/dev.ts';
import { getStoreScope } from '../reactivity/store-scope.ts';
import { escapeText, escapeAttr, inertJson } from '../reactivity/ssr.ts';
import { serializeElement } from './ssr.ts';
import type { Props } from './types.ts';

/** A head value: a string, or a getter for reactivity (client) / one-shot resolution (server). */
export type HeadValue = string | (() => string);

/** One meta declaration. Exactly one of name/property/httpEquiv is required. */
export interface HeadMeta
{
    name?: string;
    property?: string;
    httpEquiv?: string;
    content: HeadValue;
    media?: string;
}

/** One link declaration. `rel` is an author literal; `href` may be data-derived. */
export interface HeadLink
{
    rel: string;
    href: HeadValue;
    hreflang?: string;
    type?: string;
    sizes?: string;
    media?: string;
    as?: string;
    crossorigin?: string;
    imagesrcset?: string;
    imagesizes?: string;
}

/** A JSON-LD value; serialized with the inert-JSON rule into an application/ld+json block. */
export type JsonLdValue = Record<string, unknown>;

/** What {@link useHead} accepts. */
export interface HeadInput
{
    title?: HeadValue;

    /**
     * STRING ONLY: `%s` marks the title slot. Applies to titles declared by entries
     * registered AFTER this one (deeper segments); a title declared alongside its own
     * template (one call) renders bare - compose a template with its own default title
     * in TWO calls, template first.
     */
    titleTemplate?: string;

    meta?: ReadonlyArray<HeadMeta>;
    links?: ReadonlyArray<HeadLink>;
    jsonLd?: JsonLdValue | ReadonlyArray<JsonLdValue> | (() => JsonLdValue | ReadonlyArray<JsonLdValue>);
}

/** One keyed singleton, resolved, ready to serialize or write. */
interface SingletonDecl
{
    kind: 'meta' | 'link';
    attr: 'name' | 'property' | 'http-equiv' | 'rel';
    value: string;
    media: string | undefined;
    attrs: Record<string, string>;
}

/** One multi-valued element, resolved. `identity` is the dedup key. */
interface MultiDecl
{
    identity: string;
    tag: 'link' | 'meta';
    attrs: Record<string, string>;
}

/** What one useHead call contributed, fully resolved (server) or value-bearing (client). */
interface HeadEntry
{
    ordinal: number;
    title: HeadValue | undefined;
    titleTemplate: string | undefined;
    singletons: Map<string, SingletonDecl & { content: HeadValue }>;
    multis: Array<MultiDecl & { liveAttrs: Record<string, HeadValue> }>;
    jsonLd: HeadInput['jsonLd'];
}

/** The structured result of one SSR drain. */
export interface CollectedHead
{
    /** The COMPOSED title (the composition rule applied), or null when no title was
        declared - in which case the shell title stands untouched. */
    title: string | null;

    /** The escaped title CONTENT (escapeText applied), for the content-only shell surgery. */
    titleText: string | null;

    /** The full runtime-serialized fallback title ELEMENT, for the no-title-shell case. */
    titleElementHtml: string | null;

    /** Keyed singleton elements, structured so the host can match shell elements without
        parsing key strings. `html` is fully serialized and marked. */
    replacements: ReadonlyArray<{
        kind: 'meta' | 'link';
        attr: 'name' | 'property' | 'http-equiv' | 'rel';
        value: string;
        media?: string;
        html: string;
    }>;

    /** Multi-valued tags, serialized and marked, in registration order. */
    additions: string;
}

// --- keys ------------------------------------------------------------------------------

/** The repeatable Open Graph / article allowlist: multi-valued by property+content. */
const REPEATABLE_PROPERTY = /^(?:og:(?:image|video|audio)(?::[a-z_]+)?|og:locale:alternate|article:tag)$/;

/** Singleton links: one per document. Everything else multi by identity. */
const SINGLETON_RELS = new Set(['canonical', 'manifest']);

function metaKeyOf(attr: string, value: string, media: string | undefined): string
{
    return media === undefined ? `${ attr }:${ value }` : `${ attr }:${ value }|media:${ media }`;
}

// --- the server frame ------------------------------------------------------------------

let frameEntries: HeadEntry[] | null = null;
let frameOwner: object | null = null;

/**
 * Discards the per-request head frame if `owner` still holds it - the streaming
 * continuation seam and the buffered throw path, exactly the css-frame rule.
 *
 * @internal
 */
export function discardHeadFrame(owner: object): void
{
    if (frameOwner !== owner)
    {
        return;
    }
    if (DEV && frameEntries !== null && frameEntries.length > 0)
    {
        console.warn('azeroth: useHead() declarations could not reach this response\'s document head '
            + '(declared inside a streamed Suspense continuation, or the render threw) and were dropped. '
            + 'Derive SEO-critical facts from the route loader, or accept client-only application after hydration.');
    }
    frameEntries = null;
    frameOwner = null;
}

/** Resolves a HeadValue once, untracked - the server registration path. */
function resolveNow(value: HeadValue): string
{
    return typeof value === 'function' ? untrack(value) : value;
}

// --- shared entry construction ---------------------------------------------------------

let nextOrdinal = 0;

function buildEntry(input: HeadInput, resolve: (value: HeadValue) => string): HeadEntry
{
    const entry: HeadEntry = {
        ordinal: nextOrdinal++,
        title: input.title,
        titleTemplate: input.titleTemplate,
        singletons: new Map(),
        multis: [],
        jsonLd: input.jsonLd
    };

    for (const meta of input.meta ?? [])
    {
        const kinds = [meta.name !== undefined, meta.property !== undefined, meta.httpEquiv !== undefined]
            .filter(Boolean).length;
        if (kinds !== 1)
        {
            if (DEV)
            {
                throw new Error('azeroth: a useHead meta needs exactly ONE of name / property / httpEquiv.');
            }
            continue;
        }
        const attr = meta.name !== undefined ? 'name' : meta.property !== undefined ? 'property' : 'http-equiv';
        const value = meta.name ?? meta.property ?? meta.httpEquiv ?? '';
        const content = resolve(meta.content);
        const attrs: Record<string, string> = { [attr]: value, content };
        if (meta.media !== undefined)
        {
            attrs.media = meta.media;
        }
        if (attr === 'property' && REPEATABLE_PROPERTY.test(value))
        {
            entry.multis.push({
                identity: `property:${ value }|content:${ content }`,
                tag: 'meta',
                attrs,
                liveAttrs: { content: meta.content }
            });
            continue;
        }
        entry.singletons.set(metaKeyOf(attr, value, meta.media), {
            kind: 'meta', attr, value, media: meta.media, attrs, content: meta.content
        });
    }

    for (const link of input.links ?? [])
    {
        const href = resolve(link.href);
        const attrs: Record<string, string> = { rel: link.rel, href };
        for (const key of ['hreflang', 'type', 'sizes', 'media', 'as', 'crossorigin', 'imagesrcset', 'imagesizes'] as const)
        {
            const value = link[key];
            if (value !== undefined)
            {
                attrs[key] = value;
            }
        }
        if (SINGLETON_RELS.has(link.rel))
        {
            entry.singletons.set(`link:${ link.rel }`, {
                kind: 'link', attr: 'rel', value: link.rel, media: undefined, attrs, content: link.href
            });
            continue;
        }
        const identity = link.rel === 'alternate'
            ? `rel:alternate|hreflang:${ link.hreflang ?? '' }|href:${ href }`
            : `rel:${ link.rel }|href:${ href }|as:${ link.as ?? '' }`;
        entry.multis.push({ identity, tag: 'link', attrs, liveAttrs: { href: link.href } });
    }

    return entry;
}

// --- the composition rule (one spelling, both faces) -----------------------------------

/**
 * The winner template applies to the winner title UNLESS the title's declaring entry is
 * the same entry as, or was registered before, the template's. `%s` substitution uses a
 * function replacement so `$`-patterns in a title survive literally.
 */
function composeTitle(
    titleEntry: { ordinal: number; text: string } | null,
    templateEntry: { ordinal: number; template: string } | null
): string | null
{
    if (titleEntry === null)
    {
        return null;
    }
    if (templateEntry === null || titleEntry.ordinal <= templateEntry.ordinal)
    {
        return titleEntry.text;
    }
    return templateEntry.template.replace('%s', () => titleEntry.text);
}

// --- collect (the SSR drain) -----------------------------------------------------------

/**
 * The ONE refuse-by-drop diagnostic for every head value the runtime cannot serve: a
 * hostile URL the gate refuses, a jsonLd block JSON cannot represent, a non-string
 * composed title. The offending VALUE is dropped and the response proceeds - a head fact
 * is never worth failing a rendered page for, and on the server these sites run inside
 * the host's finally, where a throw would REPLACE the render's real outcome.
 */
function droppedHead(what: string, error: unknown): null
{
    if (DEV)
    {
        let reason: string;
        try
        {
            reason = String(error instanceof Error ? error.message : error);
        }
        catch
        {
            reason = 'an unrepresentable error';
        }
        console.warn(`azeroth: a useHead ${ what } was DROPPED - ${ reason }`);
    }
    return null;
}

/** DEV-diagnosed drop for an element the safety gate refuses (a hostile data-derived URL). */
function serializeHeadElement(tag: string, props: Props): string | null
{
    try
    {
        return serializeElement(tag, props, []).html;
    }
    catch (error)
    {
        return droppedHead(`${ tag } element`, error);
    }
}

/**
 * Drains the per-request head frame and returns resolved, runtime-serialized data. Called
 * by the host (the kit) beside collectStyleSheet(), after the render returns; it invokes
 * no user code and needs no render mode or store scope.
 *
 * @internal
 */
export function collectHead(options: { scriptNonce?: string } = {}): CollectedHead
{
    const entries = frameEntries ?? [];
    frameEntries = null;
    frameOwner = null;

    let titleWinner: { ordinal: number; text: string } | null = null;
    let templateWinner: { ordinal: number; template: string } | null = null;
    const singletonWinners = new Map<string, SingletonDecl & { ordinal: number }>();
    const multi: MultiDecl[] = [];
    const seenIdentities = new Set<string>();
    const jsonLdBlocks: string[] = [];

    for (const entry of entries)
    {
        if (entry.title !== undefined)
        {
            titleWinner = { ordinal: entry.ordinal, text: resolveNow(entry.title) };
        }
        if (entry.titleTemplate !== undefined)
        {
            templateWinner = { ordinal: entry.ordinal, template: entry.titleTemplate };
        }
        for (const [key, decl] of entry.singletons)
        {
            singletonWinners.set(key, { ...decl, ordinal: entry.ordinal });
        }
        for (const decl of entry.multis)
        {
            if (!seenIdentities.has(decl.identity))
            {
                seenIdentities.add(decl.identity);
                multi.push(decl);
            }
        }
        if (entry.jsonLd !== undefined)
        {
            // Already resolved at registration (the string-path invariant): never a
            // function here, so the drain invokes no user code. Deduped by the resolved
            // JSON - the same identity the client refcounts - so a layout and a leaf
            // declaring one Organization emit ONE block, in every mode.
            const list = Array.isArray(entry.jsonLd) ? entry.jsonLd : [entry.jsonLd as JsonLdValue];
            for (const block of list)
            {
                // Per-BLOCK, so one unrepresentable value (a hole, a BigInt, a cycle)
                // costs itself and nothing else; dedup identity for survivors unchanged.
                let json: string;
                try
                {
                    json = inertJson(block);
                }
                catch (error)
                {
                    droppedHead('jsonLd block', error);
                    continue;
                }
                if (!jsonLdBlocks.includes(json))
                {
                    jsonLdBlocks.push(json);
                }
            }
        }
    }

    // Dropping a broken title is CORRECT here, not merely safe: the contract has one
    // empty-title owner, so an absent title element falls back exactly as an undeclared
    // one does - whereas a throw from this site runs inside the host's finally and would
    // replace the render's real outcome with a TypeError.
    let title: string | null;
    let titleText: string | null;
    try
    {
        title = composeTitle(titleWinner, templateWinner);
        titleText = title === null ? null : escapeText(title);
    }
    catch (error)
    {
        droppedHead('title', error);
        title = null;
        titleText = null;
    }
    const titleElementHtml = titleText === null
        ? null
        : `<title data-azeroth-head="title">${ titleText }</title>`;

    const replacements: Array<CollectedHead['replacements'][number]> = [];
    for (const [key, decl] of singletonWinners)
    {
        const html = serializeHeadElement(decl.kind, { ...decl.attrs, 'data-azeroth-head': key });
        if (html === null)
        {
            continue;
        }
        replacements.push(decl.media === undefined
            ? { kind: decl.kind, attr: decl.attr, value: decl.value, html }
            : { kind: decl.kind, attr: decl.attr, value: decl.value, media: decl.media, html });
    }

    let additions = '';
    for (const decl of multi)
    {
        const html = serializeHeadElement(decl.tag, { ...decl.attrs, 'data-azeroth-head': decl.identity });
        if (html !== null)
        {
            additions += html;
        }
    }
    const nonce = options.scriptNonce === undefined ? '' : ` nonce="${ escapeAttr(options.scriptNonce) }"`;
    for (const json of jsonLdBlocks)
    {
        additions += `<script type="application/ld+json" data-azeroth-head="jsonld"${ nonce }>${ json }</script>`;
    }

    return { title, titleText, titleElementHtml, replacements, additions };
}

// --- the client face -------------------------------------------------------------------

type TopSignal = [() => HeadEntry | null, (value: HeadEntry | null) => void];

const stacks = new Map<string, HeadEntry[]>();
const tops = new Map<string, TopSignal>();
const keyedElements = new Map<string, Element>();
const identityElements = new Map<string, { count: number; el: Element | null }>();
let bootTitle: string | null = null;

function topSignalOf(key: string): TopSignal
{
    let signal = tops.get(key);
    if (signal === undefined)
    {
        const [get, set] = createSignal<HeadEntry | null>(null);
        signal = [get, set];
        tops.set(key, signal);
    }
    return signal;
}

function stackOf(key: string): HeadEntry[]
{
    let stack = stacks.get(key);
    if (stack === undefined)
    {
        stack = [];
        stacks.set(key, stack);
    }
    return stack;
}

/**
 * The one owner of the document-title face: reads BOTH stacks' winner entries untracked
 * (their registration order drives the composition rule) and writes document.title - or
 * restores the shell's own title when no declarer remains. Invoked from winner-gated
 * effects and from disposal pops; reactivity arrives through the invoking effect.
 */
function applyDocumentTitle(): void
{
    if (bootTitle === null)
    {
        bootTitle = document.title;
    }
    const titleTop = stackOf('title').at(-1) ?? null;
    const templateTop = stackOf('titleTemplate').at(-1) ?? null;

    if (titleTop === null || titleTop.title === undefined)
    {
        const base = document.head.querySelector('title[data-azeroth-title-base]')
            ?.getAttribute('data-azeroth-title-base');
        document.title = base ?? bootTitle;
        return;
    }
    try
    {
        const composed = composeTitle(
            { ordinal: titleTop.ordinal, text: untrack(() => resolveNow(titleTop.title as HeadValue)) },
            templateTop !== null && templateTop.titleTemplate !== undefined
                ? { ordinal: templateTop.ordinal, template: templateTop.titleTemplate }
                : null);
        // The WRITE stays inside the try: assignment stringifies, and a composed value
        // with a throwing toString must not escape the winner-gated effect either.
        document.title = composed ?? bootTitle;
    }
    catch (error)
    {
        droppedHead('title', error);
        document.title = bootTitle;
    }
}

/** Adopt-or-create the registry-owned element for a marker value. Null when refused. */
function elementFor(marker: string, tag: string, attrs: Record<string, string>): Element | null
{
    const existing = keyedElements.get(marker);
    if (existing !== undefined && existing.isConnected)
    {
        return existing;
    }
    const adopted = document.head.querySelector(`[data-azeroth-head="${ CSS.escape(marker) }"]`);
    if (adopted !== null)
    {
        keyedElements.set(marker, adopted);
        return adopted;
    }
    const created = createHeadElement(tag, { ...attrs, 'data-azeroth-head': marker });
    if (created !== null)
    {
        document.head.appendChild(created);
        keyedElements.set(marker, created);
    }
    return created;
}

/**
 * Mode-independent element creation under the render-safety gate: serializing the element
 * runs the SAME attribute assertions the server path uses (one gate), and the DOM element
 * is then built structurally - never through h(), which is mode-dispatched.
 */
function createHeadElement(tag: string, attrs: Record<string, string>): Element | null
{
    try
    {
        // The gate: throws on refused tags/attributes/URLs exactly as the server does.
        serializeElement(tag, attrs, []);
    }
    catch (error)
    {
        return droppedHead(`${ tag } element`, error);
    }
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs))
    {
        el.setAttribute(key, value);
    }
    return el;
}

function writeSingleton(key: string, decl: SingletonDecl & { content: HeadValue }, content: string): void
{
    // The CURRENT value rides the right attribute per kind - a link never carries a
    // stray `content` attribute, and creation uses today's value, not the snapshot.
    const attrs = { ...decl.attrs };
    if (decl.kind === 'meta')
    {
        attrs.content = content;
    }
    else
    {
        attrs.href = content;
    }
    // Refuse-by-drop applies to EVERY write, not only creation: a data-derived href
    // that turns hostile after mount is dropped with the diagnostic, never written.
    if (serializeHeadElement(decl.kind, attrs) === null)
    {
        return;
    }
    const el = elementFor(key, decl.kind, attrs);
    if (el === null)
    {
        return;
    }
    el.setAttribute(decl.kind === 'meta' ? 'content' : 'href', content);
}

function removeKeyedElement(key: string): void
{
    const el = keyedElements.get(key);
    if (el !== undefined)
    {
        el.remove();
        keyedElements.delete(key);
    }
}

function acquireIdentity(identity: string, tag: string, attrs: Record<string, string>): void
{
    const slot = identityElements.get(identity);
    if (slot !== undefined)
    {
        slot.count += 1;
        return;
    }
    const adopted = document.head.querySelector(`[data-azeroth-head="${ CSS.escape(identity) }"]`);
    const el = adopted ?? createHeadElement(tag, { ...attrs, 'data-azeroth-head': identity });
    if (el !== null && el.parentNode === null)
    {
        document.head.appendChild(el);
    }
    identityElements.set(identity, { count: 1, el });
}

function releaseIdentity(identity: string): void
{
    const slot = identityElements.get(identity);
    if (slot === undefined)
    {
        return;
    }
    slot.count -= 1;
    if (slot.count <= 0)
    {
        slot.el?.remove();
        identityElements.delete(identity);
    }
}

/** One-shot post-boot sweep scheduled by the first client registration. */
let sweepScheduled = false;

/**
 * Reclaims server-marked head elements NO live entry adopted - the divergent-hydration
 * leftovers: a streamed page whose main pass snapshotted a pending resource emits a
 * marked block the settled client never matches by identity, and without this sweep the
 * stale server block would sit beside the fresh one forever. Runs once, a microtask
 * after the synchronous registration burst (hydration's walk included), so every entry
 * that will ever adopt has adopted. The marked title element is exempt - the
 * document.title face owns titles and an implicit title element always exists.
 */
function sweepUnclaimedMarked(): void
{
    const claimed = new Set<Element>();
    for (const el of keyedElements.values())
    {
        claimed.add(el);
    }
    for (const slot of identityElements.values())
    {
        if (slot.el !== null)
        {
            claimed.add(slot.el);
        }
    }
    for (const el of [...document.head.querySelectorAll('[data-azeroth-head]')])
    {
        if (el.getAttribute('data-azeroth-head') !== 'title' && !claimed.has(el))
        {
            el.remove();
        }
    }
}

// --- useHead ---------------------------------------------------------------------------

/**
 * Declares this component's contribution to the document head: title (with `titleTemplate`
 * composition), meta by name/property/http-equiv, links, and JSON-LD data blocks.
 *
 * Precedence is nesting: a leaf's declarations win over its layout's for the same key and
 * fall back on disposal. Values may be getters for reactivity on the client; on the server
 * every value resolves ONCE, at this call, inside the request - so SEO-critical facts
 * should derive from route loaders, which are always settled before the render. A getter
 * that reads a still-pending resource during a streamed main pass snapshots its loading
 * fallback into the flushed head (documented degradation; the live page converges after
 * hydration).
 *
 * Multiple render() containers share the one document head and one registry; last
 * registered wins across them, deliberately - document.head itself is global.
 *
 * @param input - The declarations. See {@link HeadInput}.
 * @example
 * useHead({
 *     title: () => `${ user.data()?.name ?? 'Loading' }`,
 *     meta: [{ property: 'og:title', content: () => user.data()?.name ?? '' }],
 *     jsonLd: () => ({ '@context': 'https://schema.org', '@type': 'Person', name: user.data()?.name })
 * });
 */
export function useHead(input: HeadInput): void
{
    if (isStringMode())
    {
        const owner = getStoreScope();
        if (frameOwner !== owner)
        {
            frameEntries = [];
            frameOwner = owner;
        }
        const entry = buildEntry(input, resolveNow);
        // EVERY value resolves HERE, at registration, inside the request's scope -
        // including the title getter and a function-form jsonLd. collectHead must
        // never invoke user code (it runs outside the scope, where a scoped-store
        // read would build against the default scope - the probe that catches this
        // is the two-request scoped-store spec).
        if (entry.title !== undefined)
        {
            entry.title = resolveNow(entry.title);
            if (typeof entry.title === 'function')
            {
                // A getter that RETURNS a function would smuggle user code past this
                // registration-time resolution into the drain - which must invoke none.
                droppedHead('title', new TypeError('a title getter resolved to a function'));
                entry.title = undefined;
            }
        }
        if (typeof entry.jsonLd === 'function')
        {
            entry.jsonLd = untrack(entry.jsonLd);
        }
        (frameEntries ??= []).push(entry);
        return;
    }

    if (!sweepScheduled)
    {
        sweepScheduled = true;
        queueMicrotask(sweepUnclaimedMarked);
    }

    // Client and hydrate modes are identical: stacks + winner-gated effects. Static
    // multi values resolve once here; getter-bearing multis and jsonLd stay LIVE
    // through identity-swapping effects below.
    const entry = buildEntry(input, resolveNow);

    const singletonKeys: string[] = [...entry.singletons.keys()];
    if (entry.title !== undefined)
    {
        singletonKeys.push('title');
    }
    if (entry.titleTemplate !== undefined)
    {
        singletonKeys.push('titleTemplate');
    }

    for (const key of singletonKeys)
    {
        const stack = stackOf(key);
        stack.push(entry);
        topSignalOf(key)[1](entry);
    }

    for (const key of singletonKeys)
    {
        const [top] = topSignalOf(key);
        createEffect(() =>
        {
            if (top() !== entry)
            {
                return; // shadowed: the winner gate - write nothing
            }
            if (key === 'title' || key === 'titleTemplate')
            {
                // Track this entry's own title getter, then hand the write to the one
                // shared owner (which re-reads untracked).
                if (key === 'title' && typeof entry.title === 'function')
                {
                    entry.title();
                }
                applyDocumentTitle();
                return;
            }
            const decl = entry.singletons.get(key) as SingletonDecl & { content: HeadValue };
            const content = typeof decl.content === 'function' ? decl.content() : decl.content;
            writeSingleton(key, decl, content);
        });
    }

    // Multis: a decl with only static values acquires once; a decl with a GETTER is
    // LIVE - its effect re-resolves, and an identity change releases the old element
    // and acquires the new. Without this, a jsonLd/og:image derived from loader data
    // snapshots whatever the loader held at construction (the PREVIOUS route's data
    // during a client navigation - observed live as a Person block naming the wrong
    // user) and never converges.
    const liveMultiCurrent: Array<string | null> = [];
    for (const decl of entry.multis)
    {
        if (!Object.values(decl.liveAttrs).some((value) => typeof value === 'function'))
        {
            acquireIdentity(decl.identity, decl.tag, decl.attrs);
            continue;
        }
        const slot = liveMultiCurrent.length;
        liveMultiCurrent.push(null);
        createEffect(() =>
        {
            const attrs = { ...decl.attrs };
            for (const [key, value] of Object.entries(decl.liveAttrs))
            {
                attrs[key] = typeof value === 'function' ? value() : value;
            }
            const identity = decl.tag === 'meta'
                ? `property:${ attrs.property ?? '' }|content:${ attrs.content ?? '' }`
                : (attrs.rel === 'alternate'
                    ? `rel:alternate|hreflang:${ attrs.hreflang ?? '' }|href:${ attrs.href ?? '' }`
                    : `rel:${ attrs.rel ?? '' }|href:${ attrs.href ?? '' }|as:${ attrs.as ?? '' }`);
            if (identity === liveMultiCurrent[slot])
            {
                return;
            }
            const previous = liveMultiCurrent[slot];
            if (previous !== null && previous !== undefined)
            {
                releaseIdentity(previous);
            }
            acquireIdentity(identity, decl.tag, attrs);
            liveMultiCurrent[slot] = identity;
        });
    }

    // jsonLd: the function form is LIVE the same way - re-resolved tracked, identities
    // swapped on change; the static form acquires once.
    let jsonLdCurrent: string[] = [];
    if (entry.jsonLd !== undefined)
    {
        const source = entry.jsonLd;
        const applyBlocks = (blocks: readonly JsonLdValue[]): void =>
        {
            // Deduped up front: identical blocks in one call are ONE identity, so the
            // acquire/release accounting can never skew on duplicates. Per-block drop:
            // an unrepresentable value costs itself, not the effect - a throw here runs
            // mid-navigation inside createEffect, the contract's own warned failure mode.
            const serialized: string[] = [];
            for (const block of blocks)
            {
                try
                {
                    serialized.push(inertJson(block));
                }
                catch (error)
                {
                    droppedHead('jsonLd block', error);
                }
            }
            const next = [...new Set(serialized)];
            const nextIdentities = next.map((json) => `jsonld:${ json }`);
            for (const identity of jsonLdCurrent)
            {
                if (!nextIdentities.includes(identity))
                {
                    releaseIdentity(identity);
                }
            }
            for (let i = 0; i < next.length; i++)
            {
                const identity = nextIdentities[i] as string;
                if (jsonLdCurrent.includes(identity))
                {
                    continue;
                }
                acquireJsonLd(identity, next[i] as string);
            }
            jsonLdCurrent = nextIdentities;
        };
        if (typeof source === 'function')
        {
            createEffect(() =>
            {
                const resolved = source();
                applyBlocks(Array.isArray(resolved) ? resolved : [resolved]);
            });
        }
        else
        {
            applyBlocks(Array.isArray(source) ? source : [source]);
        }
    }

    onRootDispose(() =>
    {
        for (const key of singletonKeys)
        {
            const stack = stackOf(key);
            const index = stack.indexOf(entry);
            if (index !== -1)
            {
                stack.splice(index, 1);
            }
            const newTop = stack.at(-1) ?? null;
            topSignalOf(key)[1](newTop);
            if (key === 'title' || key === 'titleTemplate')
            {
                applyDocumentTitle();
            }
            else if (newTop === null)
            {
                removeKeyedElement(key);
            }
        }
        for (let i = 0; i < entry.multis.length; i++)
        {
            const decl = entry.multis[i] as MultiDecl & { liveAttrs: Record<string, HeadValue> };
            if (!Object.values(decl.liveAttrs).some((value) => typeof value === 'function'))
            {
                releaseIdentity(decl.identity);
            }
        }
        for (const identity of liveMultiCurrent)
        {
            if (identity !== null)
            {
                releaseIdentity(identity);
            }
        }
        for (const identity of jsonLdCurrent)
        {
            releaseIdentity(identity);
        }
    });
}

/** Adopt-or-create one JSON-LD block element for `identity`, refcounted. @internal */
function acquireJsonLd(identity: string, json: string): void
{
    const slot = identityElements.get(identity);
    if (slot !== undefined)
    {
        slot.count += 1;
        return;
    }
    let el: Element | null = findJsonLdElement(json);
    if (el === null)
    {
        el = document.createElement('script');
        el.setAttribute('type', 'application/ld+json');
        el.setAttribute('data-azeroth-head', 'jsonld');
        el.textContent = json;
        document.head.appendChild(el);
    }
    identityElements.set(identity, { count: 1, el });
}

/** Adopts a server-emitted JSON-LD block whose content matches `json`, if one exists. */
function findJsonLdElement(json: string): Element | null
{
    for (const el of document.head.querySelectorAll('script[data-azeroth-head="jsonld"]'))
    {
        if (el.textContent === json && ![...identityElements.values()].some((slot) => slot.el === el))
        {
            return el;
        }
    }
    return null;
}

/** Clears every client registry (tests). @internal */
export function resetHead(): void
{
    for (const el of keyedElements.values())
    {
        el.remove();
    }
    keyedElements.clear();
    for (const slot of identityElements.values())
    {
        slot.el?.remove();
    }
    identityElements.clear();
    stacks.clear();
    tops.clear();
    bootTitle = null;
    sweepScheduled = false;
    frameEntries = null;
    frameOwner = null;
}
