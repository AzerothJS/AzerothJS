/**
 * MODULE: renderer/adopt-style
 *
 * The one way framework code puts a stylesheet into the live document.
 *
 * It uses a constructable stylesheet rather than an injected `<style>` element because CSSOM is
 * not governed by Content-Security-Policy, while an inline `<style>` is refused outright by any
 * policy without `style-src 'unsafe-inline'` (or a matching hash/nonce). A refused element is
 * the dangerous shape: it stays in the DOM carrying the correct rule text and simply never
 * paints, so neither `querySelector` nor reading `textContent` reveals that the styles are
 * inert - only a computed style does. Constructable sheets remove that failure mode instead of
 * negotiating with it.
 */

/**
 * Sheets this module adopted, by id, so each is added exactly once and a reset can remove
 * exactly its own. The value is the sheet object where one was constructed, and null on the
 * `<style>` fallback path.
 *
 * @internal
 */
const adopted = new Map<string, CSSStyleSheet | null>();

/** Whether this engine supports constructable stylesheets. @internal */
function canConstruct(): boolean
{
    return typeof CSSStyleSheet === 'function'
        && typeof CSSStyleSheet.prototype.replaceSync === 'function'
        && Array.isArray(document.adoptedStyleSheets);
}

/**
 * Adds `cssText` to the document once per `id`.
 *
 * `attribute` names the marker put on the fallback `<style>` element for engines without
 * constructable stylesheets; it is also what makes an adopted sheet identifiable in tests.
 *
 * @internal
 */
export function adoptStyleSheet(id: string, cssText: string, attribute: string, attributeValue = ''): void
{
    if (typeof document === 'undefined' || adopted.has(id))
    {
        return;
    }

    if (canConstruct())
    {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        adopted.set(id, sheet);
        // A plain assignment, not `.push()`: `adoptedStyleSheets` is a frozen array in several
        // engines, so mutating it in place throws.
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        return;
    }

    adopted.set(id, null);
    const element = document.createElement('style');
    element.setAttribute(attribute, attributeValue);
    element.textContent = cssText;
    document.head.appendChild(element);
}

/**
 * Drops every sheet this module adopted, and forgets their ids so the same CSS adopts again.
 *
 * It removes exactly its OWN sheets rather than assigning an empty array: `adoptedStyleSheets`
 * is shared with the application, and wiping it would silently throw away sheets the app
 * adopted itself.
 *
 * @internal
 */
export function resetAdoptedStyleSheets(): void
{
    if (typeof document !== 'undefined' && Array.isArray(document.adoptedStyleSheets))
    {
        const mine = new Set([...adopted.values()].filter((sheet) => sheet !== null));
        if (mine.size > 0)
        {
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => !mine.has(sheet));
        }
        for (const element of Array.from(document.head.querySelectorAll('style[data-azeroth-css]')))
        {
            element.remove();
        }
    }
    adopted.clear();
}
