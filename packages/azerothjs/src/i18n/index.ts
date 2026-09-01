/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The reader's language: negotiation, direction, and the one value the page is rendered in.
 *
 * Negotiation is a pure function of two lists, so the server (from `Accept-Language`) and the
 * client (from `navigator.languages`) answer to the same rule. The chosen locale then lives
 * where the document already keeps it - on `<html lang>` - which is what lets a hydrating client
 * agree with the served markup without being told a second time.
 */

export { parseAcceptLanguage, resolveLocale, localeDirection } from './locale.ts';
export { useLocale, useDirection, setLocale } from './current-locale.ts';
export type { SetLocaleOptions } from './current-locale.ts';
export { createMessages } from './messages.ts';
export type { Catalog, Catalogs, Message, MessageVars, Translator } from './messages.ts';
export { useNumberFormat, useDateFormat, useRelativeTimeFormat, useListFormat } from './format.ts';
