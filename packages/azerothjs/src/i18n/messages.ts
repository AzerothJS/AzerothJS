/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Message catalogues: the strings a reader sees, chosen by language and filled in.
 *
 * The catalogue is an ordinary TypeScript object, not a format this framework invented. That is
 * deliberate: the key set is then a TYPE, so a translation that forgets a key or invents one is a
 * build error rather than an English string surfacing in a Persian page, and no tooling has to
 * exist for it. What the framework adds is the part a plain object cannot do - choosing the
 * right plural form for the reader's language, which is not a question of counting to one.
 */

import { untrack } from '../reactivity/index.ts';
import { useLocale } from './current-locale.ts';

/**
 * One message. A plain string, or the plural forms a language distinguishes.
 *
 * The form names are CLDR's. English uses two of them and Persian one, so most catalogues only
 * ever write `one` and `other` - but Arabic distinguishes six and Russian four, and a message
 * that only ever spells two of them is simply wrong in those languages rather than slightly off.
 */
export type Message =
    | string
    | {
        zero?: string;
        one?: string;
        two?: string;
        few?: string;
        many?: string;
        other: string;
    };

/** A catalogue: message keys to messages. Nesting is not a feature; use dotted keys. */
export type Catalog = Readonly<Record<string, Message>>;

/** What a message's placeholders are filled from. `count` also selects the plural form. */
export type MessageVars = Readonly<Record<string, string | number>>;

/** The translator {@link createMessages} returns. */
export interface Translator<K extends string>
{
    /**
     * The message for `key` in the reader's language, placeholders filled.
     *
     * Reads the current locale, so a component that calls it re-runs when the language changes -
     * which is what makes switching languages an ordinary reactive update rather than a reload.
     */
    (key: K, vars?: MessageVars): string;
}

/** A catalogue set: the reference language first, every other language typed against it. */
export type Catalogs<K extends string> = Readonly<Record<string, Readonly<Record<K, Message>>>>;

const DEV = process.env.NODE_ENV !== 'production';

/** Fills `{name}` placeholders. An unknown name is left as written rather than blanked. */
function interpolate(template: string, vars: MessageVars | undefined): string
{
    if (vars === undefined)
    {
        return template;
    }
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    {
        const value = vars[name];
        return value === undefined ? whole : String(value);
    });
}

const RULES = new Map<string, Intl.PluralRules>();

function pluralRules(locale: string): Intl.PluralRules | null
{
    let rules = RULES.get(locale);
    if (rules === undefined)
    {
        try
        {
            rules = new Intl.PluralRules(locale);
        }
        catch
        {
            return null;
        }
        RULES.set(locale, rules);
    }
    return rules;
}

/**
 * Picks the form the reader's language uses for this count.
 *
 * `count === 1 ? one : other` is the shape every hand-rolled catalogue reaches for, and it is
 * only correct for the languages whoever wrote it speaks. Arabic selects a different form for 0,
 * 1, 2, 3-10 and 11-99; Russian selects one for 1, 21, 31 and another for 2-4. `Intl` knows all
 * of it, so this asks rather than guesses. A form the catalogue did not spell falls back to
 * `other`, which every catalogue must have.
 */
function selectForm(message: Exclude<Message, string>, locale: string, count: number | undefined): string
{
    if (count === undefined)
    {
        return message.other;
    }
    const rules = pluralRules(locale);
    const category = rules === null ? (count === 1 ? 'one' : 'other') : rules.select(count);
    return message[category] ?? message.other;
}

/**
 * Builds a translator over a set of catalogues.
 *
 * The FIRST catalogue is the reference: its keys are the key type, so every other language is
 * checked against it and a missing translation is a compile error. At runtime a key still absent
 * from the reader's language falls back to the reference language rather than rendering blank,
 * because a page in the wrong language is readable and a page of empty strings is not.
 *
 * @param catalogs - Language tag to catalogue. The first entry is the reference language.
 * @returns A translator that reads the current locale on every call.
 * @example
 * const t = createMessages({
 *     en: { hello: 'Hello {name}', items: { one: '{count} item', other: '{count} items' } },
 *     fa: { hello: 'سلام {name}', items: { other: '{count} مورد' } }
 * });
 * t('hello', { name: 'Ada' });
 * t('items', { count: 3 });
 */
export function createMessages<C extends Catalogs<string>>(
    catalogs: C
): Translator<keyof C[keyof C] & string>
{
    const tags = Object.keys(catalogs);
    const reference = tags[0];
    if (reference === undefined)
    {
        throw new Error('azeroth: createMessages needs at least one catalogue - the first is the '
            + 'reference language every other one is typed against.');
    }
    const missing = new Set<string>();

    return (key, vars) =>
    {
        const locale = useLocale()();
        // The reader's exact language, then its base language (a `fa-IR` reader served by a `fa`
        // catalogue), then the reference. Untracked: the catalogue lookup must not subscribe
        // anything beyond the locale itself.
        const catalog = untrack((): Readonly<Record<string, Message>> | undefined =>
            catalogs[locale] ?? catalogs[locale.split('-')[0] ?? locale] ?? catalogs[reference]);
        const message = catalog?.[key] ?? catalogs[reference]?.[key];
        if (message === undefined)
        {
            if (DEV && !missing.has(key))
            {
                missing.add(key);
                console.warn(`azeroth: no message for "${ key }" in any catalogue, including the `
                    + `reference language "${ reference }". The key was rendered as itself.`);
            }
            return key;
        }
        const count = typeof vars?.count === 'number' ? vars.count : undefined;
        const text = typeof message === 'string' ? message : selectForm(message, locale, count);
        return interpolate(text, vars);
    };
}
