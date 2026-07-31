// @vitest-environment happy-dom
//
// `event.currentTarget` on the DELEGATED path (what the compiler emits for `.azeroth` markup).
// h() keeps per-element listeners and has always been correct here; bindEvent routes through one
// document listener, where the browser sets currentTarget to the DOCUMENT, so every handler
// reading it - the only way an arrow function can reach its own element - saw the wrong node.
import { describe, expect, it } from 'vitest';
import { h } from 'azerothjs';
import { bindEvent } from 'azerothjs/internal';

describe('delegated events report the bound element as currentTarget', () =>
{
    it('a handler on the dispatch target sees that element', () =>
    {
        const el = h('div', {});
        document.body.append(el);

        let seen: EventTarget | null = null;
        bindEvent(el, 'click', (event) =>
        {
            seen = event.currentTarget;
        });
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(seen).toBe(el);
        el.remove();
    });

    it('an ancestor handler sees the ANCESTOR, not the event target and not the document', () =>
    {
        const child = h('span', {}, 'x');
        const parent = h('div', {}, child);
        document.body.append(parent);

        const seen: Array<{ current: EventTarget | null; target: EventTarget | null }> = [];
        bindEvent(parent, 'click', (event) =>
        {
            seen.push({ current: event.currentTarget, target: event.target });
        });
        child.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(seen).toHaveLength(1);
        // This is the DOM contract: target is where it happened, currentTarget is whose listener runs.
        expect(seen[0]?.current).toBe(parent);
        expect(seen[0]?.target).toBe(child);
        parent.remove();
    });

    it('restores currentTarget afterwards so later document listeners are unaffected', () =>
    {
        const el = h('div', {});
        document.body.append(el);

        let afterwards: EventTarget | null = 'unset' as unknown as EventTarget;
        document.addEventListener('click', (event) =>
        {
            afterwards = event.currentTarget;
        }, { once: true });
        bindEvent(el, 'click', () => undefined);
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // The document's own listener must still see the document.
        expect(afterwards).toBe(document);
        el.remove();
    });
});
