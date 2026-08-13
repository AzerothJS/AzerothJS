// @vitest-environment happy-dom
//
// ARIA boolean attributes do not follow the HTML boolean-attribute convention.
//
// For a real boolean attribute presence IS the value, so `disabled={false}` means remove it.
// ARIA is the opposite: the value is a string and three states are distinct -
// `aria-expanded="true"`, `aria-expanded="false"` (a COLLAPSED control, announced as such),
// and absent (not expandable at all). Writing false as "remove" silently downgraded the second
// to the third, and writing true as `aria-expanded=""` is not a valid ARIA value.
//
// Static DOM, reactive DOM and SSR are all covered because they are separate writers, and the
// HTML-boolean control is here so a fix cannot pass by breaking `disabled`/`required`.
import { describe, it, expect } from 'vitest';
import { createRoot, createSignal, h, renderToString } from 'azerothjs';

describe('ARIA booleans are written as "true"/"false"', () =>
{
    it('static DOM', () =>
    {
        const el = h('button', { 'aria-expanded': false, 'aria-hidden': true, 'aria-checked': false });
        expect(el.getAttribute('aria-expanded')).toBe('false');
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.getAttribute('aria-checked')).toBe('false');
    });

    it('reactive DOM, including the update after the first write', () =>
    {
        const [open, setOpen] = createSignal(false);
        let el!: HTMLElement;
        const dispose = createRoot((d) =>
        {
            el = h('button', { 'aria-expanded': () => open() });
            return d;
        });

        expect(el.getAttribute('aria-expanded')).toBe('false');
        setOpen(true);
        expect(el.getAttribute('aria-expanded')).toBe('true');
        setOpen(false);
        // The state that used to vanish entirely.
        expect(el.getAttribute('aria-expanded')).toBe('false');
        dispose();
    });

    it('SSR', () =>
    {
        const html = renderToString(() => h('button', { 'aria-expanded': false, 'aria-hidden': true }));
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-hidden="true"');
    });

    it('string ARIA values pass through untouched', () =>
    {
        // aria-checked is tristate; "mixed" must not be coerced.
        expect(h('div', { 'aria-checked': 'mixed' }).getAttribute('aria-checked')).toBe('mixed');
    });

    it('CONTROL: real HTML boolean attributes keep presence semantics', () =>
    {
        const el = h('input', { disabled: false, required: true });
        expect(el.getAttribute('disabled')).toBeNull();
        expect(el.getAttribute('required')).toBe('');

        const html = renderToString(() => h('input', { disabled: false, required: true }));
        expect(html).toContain('required=""');
        expect(html).not.toContain('disabled');
    });
});
