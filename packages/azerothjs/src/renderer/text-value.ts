/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A textarea's default is its text: a value-owned one keeps it in step on writes that change what
 * it shows and on writes made during a reset, so typing mutates nothing; a reset syncs it first.
 */

/**
 * The textareas whose text a `value` prop owns, each mapped to the last text it was given. The
 * entry is added when applyProps binds the props, or when a clone's setProp value first runs.
 *
 * @internal
 */
export const boundText: WeakMap<Element, string> = new WeakMap();

/** Each form's last reset event. */
const resets: WeakMap<Element, Event> = new WeakMap();

/**
 * Whether a reset of the textarea's form is still being dispatched, though it may never run
 * (canceled, or a synthetic event).
 *
 * @internal
 */
export function resetPending(el: HTMLTextAreaElement): boolean
{
    const form = el.form;
    const event = form === null ? undefined : resets.get(form);
    return event !== undefined && event.eventPhase !== 0;
}

/**
 * Sets an element's text. One Text node is patched in place, which a typing undo group survives;
 * any other content is replaced by the text, unless there is none and the text is empty.
 *
 * @internal
 */
export function setText(el: Element, text: string): void
{
    const first = el.firstChild;
    if (first !== null && first.nodeType === 3 && first.nextSibling === null)
    {
        if ((first as Text).data !== text)
        {
            (first as Text).data = text;
        }
    }
    else if (first !== null || text !== '')
    {
        el.textContent = text;
    }
}

/**
 * The controls of a form, or null for any other target. Read from the prototype, because a
 * control named `elements` shadows the form's own property; the getter refuses a non-form.
 *
 * @internal
 */
export function controlsOf(target: EventTarget | null): HTMLFormControlsCollection | null
{
    try
    {
        return Reflect.get(HTMLFormElement.prototype, 'elements', target);
    }
    catch
    {
        return null;
    }
}

/**
 * Records a form's reset while it is dispatched and brings each bound textarea among its controls
 * to its bound text, which the reset restores if it runs.
 *
 * @internal
 */
export function restoreBoundText(event: Event, elements: HTMLFormControlsCollection): void
{
    const form = event.target as HTMLFormElement;
    // A reset of this form still being dispatched outlives one nested inside it.
    if ((resets.get(form)?.eventPhase ?? 0) === 0)
    {
        resets.set(form, event);
    }
    for (let i = 0; i < elements.length; i += 1)
    {
        const element = elements[i];
        if (element === undefined)
        {
            continue;
        }
        const text = boundText.get(element);
        if (text !== undefined)
        {
            setText(element, text);
        }
    }
}
