/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Which language a reader gets, decided by ONE rule that both sides run.
 *
 * The server negotiates from `Accept-Language` and the client from `navigator.languages`, and
 * those are the same question asked of two different lists - so they answer to the same
 * function here rather than to two implementations that drift. A page whose server and client
 * disagree about the language re-renders the whole document at hydration, which is the visible
 * flash this module exists to prevent.
 */

/** ASCII-lowercases a tag for comparison. Language tags are case-insensitive per BCP 47. */
function fold(tag: string): string
{
    return tag.trim().toLowerCase();
}

/** The primary language subtag: `fa-IR` -> `fa`. */
function primary(tag: string): string
{
    const cut = tag.indexOf('-');
    return cut === -1 ? tag : tag.slice(0, cut);
}

/**
 * The languages an `Accept-Language` header asks for, MOST WANTED FIRST.
 *
 * The order is the whole point. A reader whose header is `en-US,fa;q=0.9` has asked for English
 * and would accept Persian, and answering in Persian because Persian appears at all gets that
 * exactly backwards - which is the mistake every hand-rolled detector makes, because scanning
 * for "is my language in there" is the easier loop to write.
 *
 * Weights sort descending and ties keep header order, since a client that wrote two languages at
 * the same weight still wrote one of them first. A malformed weight scores 0 rather than
 * discarding the tag: the reader still named a language. `*` is dropped - it names no language,
 * so it can only mean the caller's own fallback.
 *
 * @param header - A raw `Accept-Language` value, e.g. `fa-IR,fa;q=0.9,en;q=0.8`.
 * @returns The tags in preference order, lowercased. Empty when the header names nothing usable.
 */
export function parseAcceptLanguage(header: string): string[]
{
    const scored: Array<{ tag: string; q: number; at: number }> = [];
    let at = 0;
    for (const part of header.split(','))
    {
        const [raw = '', ...parameters] = part.split(';');
        const tag = fold(raw);
        if (tag === '' || tag === '*')
        {
            continue;
        }
        let q = 1;
        for (const parameter of parameters)
        {
            const [name = '', value = ''] = parameter.split('=');
            if (name.trim().toLowerCase() === 'q')
            {
                const parsed = Number.parseFloat(value);
                q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
            }
        }
        scored.push({ tag, q, at: at++ });
    }
    return scored
        .sort((a, b) => (b.q - a.q) || (a.at - b.at))
        .map((entry) => entry.tag);
}

/**
 * The supported locale to serve a reader who asked for `requested`, or `fallback`.
 *
 * Walks the request in PREFERENCE ORDER and takes the first thing that can be served, so a
 * reader's second choice never beats their first. Each tag is tried exactly, then by its
 * language subtag, so `fa-IR` is served by a site that supports `fa`, and a site that supports
 * `zh-CN` can answer a bare `zh`.
 *
 * @param requested - What the reader asked for, most wanted first ({@link parseAcceptLanguage},
 *                    or `navigator.languages`).
 * @param supported - The locales this app actually has, in the app's own preference order.
 * @param fallback - Served when nothing matches. Returned as given.
 * @returns The matching entry FROM `supported`, spelled as the app spelled it.
 */
export function resolveLocale(
    requested: readonly string[],
    supported: readonly string[],
    fallback: string
): string
{
    if (supported.length === 0)
    {
        return fallback;
    }
    const folded = supported.map((locale) => ({ locale, tag: fold(locale) }));
    for (const want of requested.map(fold))
    {
        if (want === '')
        {
            continue;
        }
        const exact = folded.find((entry) => entry.tag === want);
        if (exact !== undefined)
        {
            return exact.locale;
        }
        // The reader's REGION is a preference, not a requirement: someone asking for fa-AF is
        // better served Persian than English. Matched on the language subtag in both
        // directions, so a `zh` request reaches a `zh-CN` site and vice versa.
        const language = primary(want);
        const loose = folded.find((entry) => primary(entry.tag) === language);
        if (loose !== undefined)
        {
            return loose.locale;
        }
    }
    return fallback;
}

/** Language subtags written right-to-left, for runtimes with no `Intl.Locale` text info. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
    'ar', 'arc', 'ckb', 'dv', 'fa', 'ha', 'he', 'khw', 'ks', 'ku', 'ps', 'sd', 'ur', 'uz-af', 'yi'
]);

/**
 * Which way a locale is written.
 *
 * Asks `Intl` rather than carrying a table, because a table is a list of the languages whoever
 * wrote it happened to think of - and the ones it misses (Central Kurdish, Sindhi, Yiddish) are
 * precisely the readers nobody tests with. The table below is the fallback for a runtime with no
 * text info, not the source of truth.
 *
 * An unrecognised tag is `ltr`: a page that renders left-to-right is wrong for some readers, and
 * a page that throws is wrong for all of them.
 */
export function localeDirection(tag: string): 'ltr' | 'rtl'
{
    try
    {
        const locale = new Intl.Locale(tag) as Intl.Locale & {
            getTextInfo?: () => { direction?: string };
            textInfo?: { direction?: string };
        };
        // Two spellings of one API: a method in the shipped proposal, a property in the engines
        // that implemented the earlier draft.
        const info = typeof locale.getTextInfo === 'function' ? locale.getTextInfo() : locale.textInfo;
        if (info?.direction === 'rtl' || info?.direction === 'ltr')
        {
            return info.direction;
        }
    }
    catch
    {
        // A malformed tag is the caller's problem to notice, not a reason to fail the render.
    }
    const folded = fold(tag);
    return RTL_LANGUAGES.has(folded) || RTL_LANGUAGES.has(primary(folded)) ? 'rtl' : 'ltr';
}

/** What {@link negotiateLocale} chooses between. */
export interface LocaleConfig
{
    /** BCP 47 tags this app publishes, best first. */
    supported: readonly string[];

    /** Served when the reader asks for nothing published here. Defaults to `supported[0]`. */
    default?: string;

    /** The cookie holding an explicit choice, which outranks the browser's headers. Defaults to `locale`. */
    cookie?: string | false;
}

/** What a negotiation decided, and whether the reader's own choice decided it. */
export interface NegotiatedLocale
{
    locale: string;

    /**
     * True when a cookie chose it. Callers that cache say so in `Vary`, and only when it is true -
     * naming `Cookie` unconditionally makes every response uncacheable for the sake of readers who
     * never chose one.
     */
    fromCookie: boolean;
}

/**
 * The language to answer one request in.
 *
 * The same rule pages are negotiated with, callable from anywhere holding a `Request` - an SSE
 * stream whose events carry text, a JSON endpoint returning messages, a redirect that has to pick
 * a language before there is a page. Having one function for it is the point: a site whose API
 * answers in a different language from its pages is worse than one that only speaks English.
 *
 * A cookie is an answer the reader gave and wins outright; `Accept-Language` is what their
 * browser guesses on their behalf and is read in preference order. The cookie is RESOLVED rather
 * than trusted, so reader-supplied text cannot become the answer.
 *
 * @param request - The request to answer.
 * @param config - The languages this app publishes.
 * @returns The chosen locale, and whether the reader's own choice chose it.
 * @example
 * const { locale } = negotiateLocale(request, { supported: ['en', 'fa'] });
 * return sse(request, (send) => send({ data: greetingFor(locale) }));
 */
export function negotiateLocale(request: Request, config: LocaleConfig): NegotiatedLocale
{
    const fallback = config.default ?? config.supported[0] ?? 'en';
    if (config.supported.length === 0)
    {
        return { locale: fallback, fromCookie: false };
    }
    if (config.cookie !== false)
    {
        const name = config.cookie ?? 'locale';
        const chosen = readCookie(request, name);
        if (chosen !== null)
        {
            return { locale: resolveLocale([chosen], config.supported, fallback), fromCookie: true };
        }
    }
    const header = request.headers.get('accept-language');
    return {
        locale: header === null
            ? fallback
            : resolveLocale(parseAcceptLanguage(header), config.supported, fallback),
        fromCookie: false
    };
}

/**
 * One cookie from the request, or null.
 *
 * Read here rather than through the server package's parser because this module is the shared
 * vocabulary both faces import, and it must not depend on the server.
 */
function readCookie(request: Request, name: string): string | null
{
    const header = request.headers.get('cookie');
    if (header === null)
    {
        return null;
    }
    for (const part of header.split(';'))
    {
        const at = part.indexOf('=');
        if (at === -1)
        {
            continue;
        }
        if (part.slice(0, at).trim() === name)
        {
            return decodeURIComponent(part.slice(at + 1).trim());
        }
    }
    return null;
}
