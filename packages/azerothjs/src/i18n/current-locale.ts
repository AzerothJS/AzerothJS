/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The reader's language, held where the document holds it.
 *
 * A page has ONE language: `<html lang>` and `<html dir>` are single attributes on a single
 * element, so the locale is module state on the client for the same reason the head registry is
 * - the thing being described is itself global. The client seeds from `document.documentElement`,
 * which is what the server wrote, so the two sides cannot disagree about the language at
 * hydration; there is one value and the client reads it rather than being told it a second time
 * over a wire it would then have to keep in step.
 *
 * On the SERVER that same module state would be the cross-request bleed this codebase has
 * already paid for once, so there is none: a string render is PINNED for its synchronous
 * duration and the pin is restored in a `finally`, exactly as the blocked-state pin is.
 */

import { createSignal, isStringMode } from '../reactivity/index.ts';
import type { Getter } from '../reactivity/index.ts';
import { localeDirection } from './locale.ts';

/** SERVER: the locale this synchronous render is pinned to. */
let renderLocale: string | null = null;

/**
 * SERVER: pins one string render to a locale.
 *
 * The host resolves the language from the request - a cookie, `Accept-Language`, a path segment -
 * none of which the render can see, so it arrives the way the CSRF token and the action result
 * arrive: from outside, pinned for the render, never read from ambient state. Synchronous by
 * contract; a string render never interleaves with another.
 *
 * @internal Used by the SSR host. Applications read the result through {@link useLocale}.
 */
export function renderWithLocale<T>(locale: string, render: () => T): T
{
    const previous = renderLocale;
    renderLocale = locale;
    try
    {
        return render();
    }
    finally
    {
        renderLocale = previous;
    }
}

/**
 * The document's language on the client, or `null` before anything has set one.
 *
 * Read lazily rather than at module load: this module can be imported by a server bundle, and
 * `document` may not exist when it is.
 */
function documentLocale(): string | null
{
    if (typeof document === 'undefined')
    {
        return null;
    }
    const declared = document.documentElement.getAttribute('lang');
    return declared === null || declared === '' ? null : declared;
}

const [locale, setSignal] = createSignal<string | null>(null);

/** Writes the language onto the element that carries it for the whole document. */
function applyToDocument(tag: string): void
{
    if (typeof document === 'undefined')
    {
        return;
    }
    const root = document.documentElement;
    root.setAttribute('lang', tag);
    // `dir` on the root is what drives every logical CSS property and what a screen reader
    // follows. It travels with the language and is never set independently.
    root.setAttribute('dir', localeDirection(tag));
}

/**
 * The language this page is being read in, as a reactive value.
 *
 * Everything derived from it should read it HERE rather than capture it, so that changing the
 * language redraws a date without the page having to know it was a date. That is the whole
 * benefit of the locale being a signal in a fine-grained renderer.
 *
 * During a server render it is the locale the host pinned. On the client it is the document's
 * own `<html lang>` until something calls {@link setLocale}, which is what makes the hydrating
 * client agree with the served markup by construction rather than by an assertion.
 *
 * @returns A getter for the current BCP 47 tag, `'en'` when nothing has declared one.
 * @example
 * const locale = useLocale();
 * const price = () => new Intl.NumberFormat(locale()).format(amount());
 */
export function useLocale(): Getter<string>
{
    if (isStringMode())
    {
        // One render, one language: a constant getter, so nothing subscribes to a value that
        // cannot change before the response is written.
        const pinned = renderLocale ?? 'en';
        return () => pinned;
    }
    return () => locale() ?? documentLocale() ?? 'en';
}

/**
 * Which way the current locale is written, as a reactive value.
 *
 * For the rare component that has to branch on direction rather than express itself in logical
 * CSS properties, which handle the ordinary cases without asking.
 */
export function useDirection(): Getter<'ltr' | 'rtl'>
{
    const current = useLocale();
    return () => localeDirection(current());
}

/** A year: long enough that a reader's choice outlives their next visit. */
const CHOICE_MAX_AGE = 60 * 60 * 24 * 365;

/** How {@link setLocale} remembers the choice. */
export interface SetLocaleOptions
{
    /**
     * The cookie the choice is written to, or `false` to remember nothing.
     *
     * Defaults to `locale`, which is the name `mountPages` reads by default - so the two agree
     * without either being configured. An app that renames one must rename both.
     */
    cookie?: string | false;
}

/**
 * Switches the page's language.
 *
 * Updates the signal and the document's `lang`/`dir` together, so every reader of
 * {@link useLocale} redraws and the page's direction changes with it.
 *
 * The choice is written to a cookie rather than to local storage, because the SERVER is what
 * has to act on it: the next request arrives already knowing the language, and its HTML is
 * rendered in that language rather than corrected afterwards. Storing it where only the client
 * can read it would leave every first paint in the wrong language.
 *
 * @param tag - A BCP 47 tag the application supports.
 * @param options - Where to remember the choice; `{ cookie: false }` to remember nothing.
 */
export function setLocale(tag: string, options: SetLocaleOptions = {}): void
{
    if (isStringMode())
    {
        throw new Error('azeroth: setLocale() is a client action - a server render\'s language is '
            + 'decided by the host before the render begins, so switching it mid-render would '
            + 'contradict the document already being written.');
    }
    applyToDocument(tag);
    setSignal(tag);
    const cookie = options.cookie ?? 'locale';
    if (cookie !== false && typeof document !== 'undefined')
    {
        // Lax rather than Strict: a reader arriving from a link should still see the language
        // they chose. Not `secure`, so it works on a plain-http development origin; it carries
        // a display preference, not a credential.
        document.cookie = `${ encodeURIComponent(cookie) }=${ encodeURIComponent(tag) }`
            + `; path=/; max-age=${ CHOICE_MAX_AGE }; samesite=lax`;
    }
}

/** @internal Test seam: forgets the client's locale so a spec starts from the document again. */
export function resetLocale(): void
{
    setSignal(null);
}
