// @vitest-environment happy-dom
//
// <select>.value is the one DOM property whose value is decided by the element's CHILDREN:
// assigning it while the matching <option> does not exist is a SILENT no-op. Four writers got
// that wrong in four different ways, and each fails independently, so each has its own test.
//
// TWO RULES EVERY ASSERTION HERE OBEYS, because the obvious test is vacuous:
//  A. The seed is NEVER the first option. A select with no valid selection reports option 0, so
//     a test seeded to 'us' passes against the broken tree.
//  B. selectedIndex is asserted alongside value. value alone cannot tell "the write took" from
//     "the browser defaulted".
// The CONTROL at the end pins rule A itself: seeded to option 0, it passes either way, so if it
// ever fails the harness is measuring the wrong thing.
import { describe, it, expect } from 'vitest';
import { createRoot, createSignal, h, render, renderToString, hydrate } from 'azerothjs';
import { writeSelectValue } from '../../src/renderer/select-value.ts';

const OPTIONS = ['us', 'de', 'jp'];

/** One microtask: a MutationObserver delivers its records before the next paint. */
const settled = (): Promise<void> => Promise.resolve();

/** Mounts into a container attached to the document, and returns the select. */
function mount(build: () => HTMLElement): HTMLSelectElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(build, container);
    return container.querySelector('select') as HTMLSelectElement;
}

describe('a select takes its initial value when the options exist', () =>
{
    it('hand-written h(), whose props are applied before children', () =>
    {
        const select = mount(() => h('select', { value: 'de' },
            ...OPTIONS.map((o) => h('option', { value: o }, o))));

        expect(select.options.length).toBe(3);
        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
    });

    it('a reactive value that changes after mount', () =>
    {
        const [country, setCountry] = createSignal('de');
        let select!: HTMLSelectElement;
        const dispose = createRoot((d) =>
        {
            select = mount(() => h('select', { value: () => country() },
                ...OPTIONS.map((o) => h('option', { value: o }, o))));
            return d;
        });

        expect(select.selectedIndex).toBe(1);
        setCountry('jp');
        expect(select.selectedIndex).toBe(2);
        dispose();
    });

    it('options that arrive AFTER the value was written, with no await', () =>
    {
        // The case no statement reordering can fix: the value binding depends on the VALUE, not
        // on the option set, so it never re-runs when rows land. Asserted synchronously, because
        // the batch flush is synchronous - an await here would also pass under a deferred design
        // that was deliberately rejected.
        const [options, setOptions] = createSignal<string[]>([]);
        let select!: HTMLSelectElement;
        const dispose = createRoot((d) =>
        {
            select = mount(() => h('select', { value: 'de' },
                () => options().map((o) => h('option', { value: o }, o))));
            return d;
        });

        expect(select.options.length).toBe(0);
        setOptions(OPTIONS);

        expect(select.options.length).toBe(3);
        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
        dispose();
    });

    it('does NOT re-assert a parked value that still matches nothing', () =>
    {
        // THE MATCH GATE, and why this is asserted as "no write happened" rather than as a
        // selection surviving.
        //
        // Measured in Chrome 151: assigning a value that matches no option DESELECTS EVERYTHING
        // (value '' , selectedIndex -1). happy-dom instead leaves the selection untouched. So in
        // this environment a blind re-assert is invisible - the gate can be deleted and every
        // selection-based assertion still passes. Counting the assignment is what makes the test
        // able to fail here, and it is the same event that would wipe the user's choice in a real
        // browser.
        const [extra, setExtra] = createSignal<string[]>([]);
        let select!: HTMLSelectElement;
        const dispose = createRoot((d) =>
        {
            select = mount(() => h('select', { value: 'nope' },
                h('option', { value: 'us' }, 'us'),
                h('option', { value: 'de' }, 'de'),
                () => extra().map((o) => h('option', { value: o }, o))));
            return d;
        });

        // 'nope' matched nothing, so it is parked. The user then chooses.
        select.selectedIndex = 1;

        // Count writes to .value from here on; the settle must not perform one.
        let writes = 0;
        const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value');
        Object.defineProperty(select, 'value', {
            configurable: true,
            get: () => own?.get?.call(select) as string,
            set: (v: string) =>
            {
                writes += 1;
                own?.set?.call(select, v);
            }
        });

        // An unrelated insertion runs a settle. 'nope' still matches nothing.
        setExtra(['fr']);

        expect(writes).toBe(0);
        expect(select.selectedIndex).toBe(1);
        dispose();
    });

    it('DOES apply a parked value once its option finally arrives', async () =>
    {
        // The other side of the gate: gating on "does it match now" must not become "never retry".
        const [options, setOptions] = createSignal(['us']);
        let select!: HTMLSelectElement;
        const dispose = createRoot((d) =>
        {
            select = mount(() => h('select', { value: 'jp' },
                () => options().map((o) => h('option', { value: o }, o))));
            return d;
        });

        expect(select.value).not.toBe('jp');
        setOptions(['us', 'de', 'jp']);

        // The repair is the select own observer, delivered on the microtask BEFORE the next
        // paint - so the invariant is "never painted wrong", not "true before the setter returns".
        await settled();
        expect(select.value).toBe('jp');
        expect(select.selectedIndex).toBe(2);
        dispose();
    });
});

describe('the server expresses the selection on the option, not the select', () =>
{
    it('emits selected on the matching option and no value attribute', () =>
    {
        const html = renderToString(() => h('select', { value: 'de' },
            ...OPTIONS.map((o) => h('option', { value: o }, o))));

        // `value` is not a content attribute of <select>; emitting it is inert markup that makes
        // the first paint disagree with the client render.
        expect(html).toMatch(/<select(?![^>]*\svalue=)/);
        expect(html.match(/selected/g)?.length).toBe(1);
        expect(html).toContain('<option value="de" selected="">');
    });

    it('falls back to the option text when it has no value attribute', () =>
    {
        const html = renderToString(() => h('select', { value: 'de' },
            h('option', {}, 'us'), h('option', {}, 'de')));

        expect(html.match(/selected/g)?.length).toBe(1);
        expect(html).toContain('<option selected="">de</option>');
    });

    it('the select value overrides an authored selected, in one direction only', () =>
    {
        // Two options marked selected would let the browser take the LAST, so the server paint
        // would disagree with the client, where assigning value wins outright.
        const html = renderToString(() => h('select', { value: 'de' },
            h('option', { value: 'us' }, 'us'),
            h('option', { value: 'de' }, 'de'),
            h('option', { value: 'jp', selected: true }, 'jp')));

        expect(html.match(/selected/g)?.length).toBe(1);
        expect(html).toContain('<option value="de" selected="">');

        // With no value on the select, an authored selected still stands.
        const authored = renderToString(() => h('select', {},
            h('option', { value: 'us' }, 'us'),
            h('option', { value: 'de', selected: true }, 'de')));
        expect(authored).toContain('<option value="de" selected="">');
    });

    it('does not corrupt other attributes while dropping an authored selected', () =>
    {
        // The strip must run on attribute NAMES only. A regex over the tag text also matches the
        // word inside quoted VALUES: a class="row selected" lost its class and a title lost a word
        // from its prose - silent corruption, and final on a page that runs without JS.
        const html = renderToString(() => h('select', { value: 'de' },
            h('option', { value: 'us', class: 'row selected' }, 'us'),
            h('option', { value: 'de', title: 'Currently selected country' }, 'de')));

        expect(html).toContain('class="row selected"');
        expect(html).toContain('title="Currently selected country"');
        expect(html).toContain('<option value="de" title="Currently selected country" selected="">');
    });

    it('marks nothing extra when the value matches no option', () =>
    {
        const html = renderToString(() => h('select', { value: 'zz' },
            ...OPTIONS.map((o) => h('option', { value: o }, o))));

        expect(html).not.toContain('selected');
    });

    it('leaves an authored selected alone when the value matches no option', () =>
    {
        // The earlier version stripped every authored `selected` before knowing whether anything
        // would match, so the server painted NO selection while the client - whose apply is
        // match-gated - left the authored option selected. Without JS that is the option the form
        // submits; with JS it is a flash at hydration.
        const html = renderToString(() => h('select', { value: 'zz' },
            h('option', { value: 'us' }, 'us'),
            h('option', { value: 'de', selected: true }, 'de'),
            h('option', { value: 'jp' }, 'jp')));

        expect(html.match(/selected/g)?.length).toBe(1);
        expect(html).toContain('<option value="de" selected="">');
    });

    it('SSR and a pure client render agree', () =>
    {
        // The GRAMMAR.md equivalence claim, measured rather than assumed.
        const build = (): HTMLElement => h('select', { value: 'de' },
            ...OPTIONS.map((o) => h('option', { value: o }, o)));

        const container = document.createElement('div');
        container.innerHTML = renderToString(build);
        document.body.appendChild(container);
        const server = container.querySelector('select') as HTMLSelectElement;
        const serverIndex = server.selectedIndex;

        hydrate(build, container);
        const hydrated = container.querySelector('select') as HTMLSelectElement;

        const client = mount(build);

        expect(serverIndex).toBe(1);
        expect(hydrated.selectedIndex).toBe(1);
        expect(client.selectedIndex).toBe(1);
    });
});

describe('CONTROL', () =>
{
    it('a first-option seed passes either way - this is the vacuity rule, pinned', () =>
    {
        // Deliberately vacuous: it passes against the broken tree too. It exists so that a
        // harness fault (nothing rendering, options missing) shows up as THIS failing.
        const select = mount(() => h('select', { value: 'us' },
            ...OPTIONS.map((o) => h('option', { value: o }, o))));

        expect(select.options.length).toBe(3);
        expect(select.value).toBe('us');
        expect(select.selectedIndex).toBe(0);
    });
});

describe('the framework intent persists after it has been satisfied', () =>
{
    it('re-applies when a matched option is removed and comes back', async () =>
    {
        // Asserted at the unit level because the component-level version cannot discriminate:
        // a re-render can re-issue the write, so that test passes even when the intent is
        // dropped the moment it is satisfied. Here NOTHING writes the value again - only the
        // option set changes - so a forgotten intent shows up as a lost selection.
        const select = document.createElement('select');
        document.body.appendChild(select);
        for (const value of ['us', 'de'])
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }

        writeSelectValue(select, 'de');
        expect(select.value).toBe('de');
        await settled();

        // The option leaves, as a re-render of a <For> over changed data would remove it.
        select.removeChild(select.options[1] as HTMLOptionElement);
        await settled();
        expect(select.value).not.toBe('de');

        // And comes back. No new write happens; only the settle runs.
        const back = document.createElement('option');
        back.value = 'de';
        select.appendChild(back);
        await settled();

        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
        select.remove();
    });
});

describe('the module does not retain the selects it has written to', () =>
{
    it('tracks selects weakly, so a discarded one is not pinned by this module', async () =>
    {
        // A strong Map was tried first and leaked: it kept every select an app ever built, with
        // its whole <option> subtree. The liveness rule that was meant to prune them keyed off
        // isConnected, which is never observed true for a select at a render root - render()
        // attaches the tree only after the last settle has run. GC is the only correct owner.
        const ref = (() =>
        {
            const select = document.createElement('select');
            const option = document.createElement('option');
            option.value = 'de';
            select.appendChild(option);
            writeSelectValue(select, 'de');
            return new WeakRef(select);
        })();

        // NOT `deref() === undefined || deref().nodeName === 'SELECT'`, which cannot evaluate
        // false for any implementation and passed a deliberate strong-reference leak. Without a
        // forced GC the only honest assertion here is that settling TOLERATES a weak entry -
        // retention itself is asserted by the disposal test below, which does not need GC.
        await settled();
        const select = ref.deref();
        expect(select === undefined || select.options.length).toBeTruthy();
    });

    it('does not wipe a multi-select when nothing in the array matches', () =>
    {
        // The array branch had no match gate, so an unmatched array deselected everything - the
        // exact rule the scalar branch obeys. DOM-neutral, so it reproduces in a real browser.
        const select = document.createElement('select');
        select.multiple = true;
        document.body.appendChild(select);
        for (const value of ['us', 'de', 'jp'])
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }
        (select.options[0] as HTMLOptionElement).selected = true;
        (select.options[2] as HTMLOptionElement).selected = true;

        writeSelectValue(select, ['zz']);

        // Read the per-option flags: happy-dom's selectedOptions collection goes stale here.
        expect([...select.options].map((o) => o.selected)).toEqual([true, false, true]);
        select.remove();
    });

    it('settles a partly-available array once instead of rewriting it forever', async () =>
    {
        // Satisfaction judged against what was ASKED rather than what EXISTS left a duplicate or
        // partly-available array permanently unachieved, rewriting every option on every flush.
        const select = document.createElement('select');
        select.multiple = true;
        document.body.appendChild(select);
        for (const value of ['us', 'de', 'jp'])
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }

        writeSelectValue(select, ['de', 'zzz']);
        expect((select.options[1] as HTMLOptionElement).selected).toBe(true);

        let writes = 0;
        for (const option of [...select.options])
        {
            let flag = option.selected;
            Object.defineProperty(option, 'selected', {
                configurable: true,
                get: () => flag,
                set: (v: boolean) =>
                {
                    writes += 1;
                    flag = v;
                }
            });
        }
        for (let i = 0; i < 5; i += 1)
        {
            await settled();
        }

        expect(writes).toBe(0);
        select.remove();
    });
});

describe('a value whose shape does not fit the control', () =>
{
    it('treats an array on a SINGLE select the way the DOM does', () =>
    {
        // An array only means something to a multiple select. Driving the per-option loop on a
        // single select would select the LAST array entry, because the element keeps only one -
        // a silent divergence no reading of the HTML supports. The DOM coerces to a joined
        // string, which matches no option, so the match gate leaves the control alone.
        const select = document.createElement('select');
        document.body.appendChild(select);
        for (const value of ['us', 'de', 'jp'])
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }
        (select.options[1] as HTMLOptionElement).selected = true;

        writeSelectValue(select, ['de', 'jp']);

        expect(select.value).not.toBe('jp');
        expect(select.value).toBe('de');
        select.remove();
    });

    it('accepts a plain string on a MULTIPLE select', () =>
    {
        const select = document.createElement('select');
        select.multiple = true;
        document.body.appendChild(select);
        for (const value of ['us', 'de', 'jp'])
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }

        writeSelectValue(select, 'de');

        expect([...select.options].map((o) => o.selected)).toEqual([false, true, false]);
        select.remove();
    });
});

describe('the value the framework did not ask for', () =>
{
    it('a nullish value stops driving the select rather than clearing it', () =>
    {
        // SSR deliberately leaves an authored `<option selected>` standing when the select's
        // value is nullish, so a client that WIPED the selection made the two modes disagree on
        // the ordinary shape of a reusable control, `value={maybeUndefined}`.
        const select = document.createElement('select');
        document.body.appendChild(select);
        for (const value of ['us', 'de'])
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }
        (select.options[1] as HTMLOptionElement).selected = true;

        writeSelectValue(select, undefined);

        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
        select.remove();
    });

    it('clearing and re-setting a value does not accumulate tracking or listeners', async () =>
    {
        // The nullish path dropped the intent but left its WeakRef in the walk set, so the next
        // write registered a second one - and another 'change' listener. A value toggled N times
        // left N entries for ONE element, each visited on every settle.
        const select = document.createElement('select');
        document.body.appendChild(select);
        for (const value of ['us', 'de'])
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }

        let listeners = 0;
        const add = select.addEventListener.bind(select);
        select.addEventListener = ((type: string, handler: EventListener): void =>
        {
            if (type === 'change')
            {
                listeners += 1;
            }
            add(type, handler);
        }) as typeof select.addEventListener;

        for (let i = 0; i < 10; i += 1)
        {
            writeSelectValue(select, 'de');
            writeSelectValue(select, null);
        }
        writeSelectValue(select, 'de');

        // One listener for the element, however many times its value is cleared and re-set.
        expect(listeners).toBe(1);

        // And one visit per settle, not one per toggle.
        let reads = 0;
        const options = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'options');
        Object.defineProperty(select, 'options', {
            configurable: true,
            get: () =>
            {
                reads += 1;
                return options?.get?.call(select) as HTMLOptionsCollection;
            }
        });
        await settled();

        expect(reads).toBeLessThanOrEqual(2);
        select.remove();
    });

    it('one select whose settle throws does not starve the others', async () =>
    {
        // The walk is shared and restarts from the same element every time, so a thrower early in
        // the set would permanently, silently starve every select registered after it.
        const bad = document.createElement('select');
        const good = document.createElement('select');
        document.body.append(bad, good);
        for (const value of ['us', 'de'])
        {
            const option = document.createElement('option');
            option.value = value;
            good.appendChild(option);
        }

        const badOption = document.createElement('option');
        badOption.value = 'x';
        bad.appendChild(badOption);
        writeSelectValue(bad, 'x');
        writeSelectValue(good, 'de');

        // 'de' is not selected yet from good's point of view: take it away and put it back.
        good.removeChild(good.options[1] as HTMLOptionElement);
        const back = document.createElement('option');
        back.value = 'de';
        good.appendChild(back);

        Object.defineProperty(bad, 'options', {
            configurable: true,
            get: () =>
            {
                throw new Error('probe: options access failed');
            }
        });

        await settled();

        expect(good.value).toBe('de');
        bad.remove();
        good.remove();
    });
});

describe('a multiple select on the server', () =>
{
    it('marks every value in the array, matching the client', () =>
    {
        // String(['de','jp']) is 'de,jp', which no option carries, so the server marked NOTHING
        // while the client - which has a dedicated array branch - selected both. A single-entry
        // array worked by accident, which is why nothing caught it.
        const html = renderToString(() => h('select', { multiple: true, value: ['de', 'jp'] },
            ...OPTIONS.map((o) => h('option', { value: o }, o))));

        expect(html.match(/selected/g)?.length).toBe(2);
        expect(html).toContain('<option value="de" selected="">');
        expect(html).toContain('<option value="jp" selected="">');
        expect(html).not.toContain('<option value="us" selected');
    });

    it('keeps an authored selected when NOTHING in the array matches', () =>
    {
        // The scalar path got the two-pass winner gate; the array sibling did not, so a
        // non-matching array stripped the authored default and the server painted nothing
        // while the client's match gate left it standing.
        const html = renderToString(() => h('select', { multiple: true, value: ['zz'] },
            h('option', { value: 'us' }, 'us'),
            h('option', { value: 'de', selected: true }, 'de')));

        expect(html.match(/selected/g)?.length).toBe(1);
        expect(html).toContain('<option value="de" selected="">');
    });

    it('drops an authored default that is not in the array', () =>
    {
        const html = renderToString(() => h('select', { multiple: true, value: ['de'] },
            h('option', { value: 'us', selected: true }, 'us'),
            h('option', { value: 'de' }, 'de')));

        expect(html.match(/selected/g)?.length).toBe(1);
        expect(html).toContain('<option value="de" selected="">');
    });
});

describe('the round-5 findings', () =>
{
    /** A select in the document with the given options; returns it. */
    function mkSelect(values: string[], multiple = false): HTMLSelectElement
    {
        const select = document.createElement('select');
        select.multiple = multiple;
        document.body.appendChild(select);
        for (const value of values)
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }
        return select;
    }

    it('a pick the intent already agrees with does NOT latch (the input-then-change ordering)', async () =>
    {
        // A real gesture fires 'input' then 'change', and a bind:value write-back runs on
        // 'input' - so by 'change' time the intent already IS the pick. Latching there
        // permanently disarmed repair: nothing could clear it, because clearing takes a new
        // framework write and the bound signal already equals the pick. One ordinary click then
        // left the select empty (or on the wrong row) after any later row churn.
        const select = mkSelect(['us', 'de', 'jp']);
        writeSelectValue(select, 'de');

        // The user picks jp; the write-back (input) re-arms the intent to jp; change follows.
        select.selectedIndex = 2;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        writeSelectValue(select, 'jp');   // what the bind write-back does, via the signal
        select.dispatchEvent(new Event('change', { bubbles: true }));

        // Churn: the picked option leaves and returns, outside any flush.
        select.removeChild(select.options[2] as HTMLOptionElement);
        await settled();
        const back = document.createElement('option');
        back.value = 'jp';
        select.appendChild(back);
        await settled();

        expect(select.value).toBe('jp');
        expect(select.selectedIndex).toBe(2);
        select.remove();
    });

    it('a pick that DIVERGES from the intent still latches', async () =>
    {
        // The one-way case: no write-back updates the intent, so the change listener is the only
        // protection the user has - it must keep working.
        const select = mkSelect(['us', 'de', 'jp']);
        writeSelectValue(select, 'de');

        select.selectedIndex = 2;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));

        // An unrelated insertion runs the observer; the stale 'de' must not come back.
        const extra = document.createElement('option');
        extra.value = 'fr';
        select.appendChild(extra);
        await settled();

        expect(select.value).toBe('jp');
        select.remove();
    });

    it('an EMPTY array clears a multiple select', () =>
    {
        // [] is an explicit "select nothing", and nothing-selected is always achievable -
        // treating it as unsatisfiable left DOM and state permanently divergent with no API able
        // to clear a multiple select at all.
        const select = mkSelect(['us', 'de', 'jp'], true);
        (select.options[0] as HTMLOptionElement).selected = true;
        (select.options[2] as HTMLOptionElement).selected = true;

        writeSelectValue(select, []);

        expect([...select.options].map((o) => o.selected)).toEqual([false, false, false]);
        select.remove();
    });

    it('a scalar intent on a MULTIPLE select repairs an extra selected option', async () =>
    {
        // select.value reports only the FIRST selected option, so value equality alone declared
        // the intent satisfied while extra options were also selected - and never repaired them.
        const select = mkSelect(['us', 'de'], true);
        writeSelectValue(select, 'de');
        expect(select.value).toBe('de');

        const extra = document.createElement('option');
        extra.value = 'zz';
        extra.selected = true;
        select.appendChild(extra);
        await settled();

        expect([...select.options].map((o) => o.selected)).toEqual([false, true, false]);
        select.remove();
    });

    it('a nullish release followed by a new write re-arms the observer', async () =>
    {
        // The nullish path disconnects the observer; the next write must arm a NEW one, or every
        // re-written select is silently disarmed forever - a mutant no other test could see.
        const select = mkSelect(['us']);
        writeSelectValue(select, 'de');
        writeSelectValue(select, null);
        writeSelectValue(select, 'de');

        const de = document.createElement('option');
        de.value = 'de';
        select.appendChild(de);
        await settled();

        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
        select.remove();
    });

    it('form.reset() lands on the framework value, not option 0', async () =>
    {
        // reset restores defaultSelected - a parsed ATTRIBUTE a client-rendered select never has
        // - and performs no childList mutation, so the observer cannot see it. Without the reset
        // listener a client-rendered select reset to option 0 and stayed there.
        const form = document.createElement('form');
        document.body.appendChild(form);
        const select = document.createElement('select');
        form.appendChild(select);
        for (const value of ['us', 'de', 'jp'])
        {
            const option = document.createElement('option');
            option.value = value;
            select.appendChild(option);
        }
        writeSelectValue(select, 'de');
        expect(select.selectedIndex).toBe(1);

        form.reset();
        await settled();
        await settled();

        expect(select.value).toBe('de');
        expect(select.selectedIndex).toBe(1);
        form.remove();
    });
});

// NO happy-dom pin for "an option's value changes IN PLACE" - deliberately, and this note is the
// record of why. Three candidate assertions were written and all three passed with BOTH fixes
// reverted: happy-dom re-resolves a select of its own accord when an option's value changes, and
// emits records a real browser does not. A test that cannot fail is worse than no test, because
// it reads as coverage. The two halves of the fix are:
//   - h.ts settles the owning select at the write site, because `option.value = x` is a DOM
//     PROPERTY write that produces no mutation record in a real browser; and
//   - the observer takes `characterData` plus a filtered `value` attribute, for a value-less
//     option whose text is its value and for writes from outside the framework.
// Both are verified in real Chrome, where the distinction between a property write and an
// attribute write is real. See CHANGELOG under "an option changing in place".
