/**
 * MODULE: api/manifest-handoff - the manifest as an inert page payload
 *
 * The typed client is synchronous over a manifest VALUE; the only question is how
 * that value reaches the browser. Fetching `/api/_manifest` costs a network round
 * trip that serializes ahead of everything importing the client module - a real
 * waterfall on the hydration path. But on a server-rendered page the value is
 * already in the process that renders the HTML, so it can ride the document the
 * same way the router's loader handoff does: an inert JSON script tag written into
 * `<head>`, read back synchronously before any module runs.
 *
 * Both halves of the wire contract live HERE - the tag id, the escaping, the
 * parse-and-degrade - so the writer (kit's mountPages, via the server entry) and
 * the reader (application client code, via the shared entry) can never drift.
 * A page without the tag (dev vite, prerendered files, non-kit servers) reads
 * `undefined` and the caller falls back to the fetch - always a correct fallback.
 */

import type { Manifest } from './declare.ts';

/** @internal The script tag id both sides agree on. */
const MANIFEST_HANDOFF_ID = 'azeroth-api-manifest';

/**
 * SERVER: the manifest as an inert JSON script tag for the document head.
 *
 * The `<`-escape closes the only injection route out of a JSON script tag: a payload
 * string containing `</script>` (or `<!--`) cannot terminate the tag once no literal
 * `<` survives. JSON itself never NEEDS a literal `<`, so the escape is lossless.
 * The router's loader handoff hardens its own payload the same way; the rule is not
 * shared code because sharing it would mean this server package importing the UI
 * runtime, which is the coupling the shared entry exists to prevent.
 *
 * @param manifest - The projection `manifestOf(api)` returns.
 * @returns The tag, ready to splice before `</head>`.
 */
export function manifestScript(manifest: Manifest): string
{
    const json = JSON.stringify(manifest).replace(/</g, '\\u003c');
    return `<script type="application/json" id="${ MANIFEST_HANDOFF_ID }">${ json }</script>`;
}

/**
 * CLIENT: reads the manifest the server embedded, or `undefined` when there is none
 * (a plain vite dev page, a prerendered file, a non-kit server) or the content is
 * malformed. `undefined` means "fall back to fetching `/api/_manifest`" - the
 * degraded path is always a correct one.
 *
 * @returns The embedded manifest, or `undefined`.
 */
export function readManifest(): Manifest | undefined
{
    const doc = (globalThis as { document?: Document }).document;
    const text = doc?.getElementById(MANIFEST_HANDOFF_ID)?.textContent;
    if (typeof text !== 'string')
    {
        return undefined;
    }
    try
    {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed as Manifest : undefined;
    }
    catch
    {
        return undefined;
    }
}
