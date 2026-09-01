// @vitest-environment happy-dom
//
// The form/mutation link. A mutation is what a form submits to, not a second form system, so
// this is one widened `onSubmit` rather than a parallel option.
//
// The arm that matters is the refusal: wiring the two by hand as `onSubmit: (v) => m.run(v)` is
// SILENTLY WRONG, because `run` answers `{ ok: false }` instead of rejecting - measured before
// this existed, `submitError()` stayed null while the mutation held the error, so a form bound
// to it reported a success the server never gave.
import { describe, expect, it, vi } from 'vitest';
import { cached, createForm, createMutation, createResource, createRoot } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Values { name: string; email: string }

/** A refusal shaped like the api client's 422: a per-field map beside the message. */
class Refused extends Error
{
    public readonly fields: Record<string, string>;

    constructor(fields: Record<string, string>)
    {
        super('validation failed');
        this.fields = fields;
    }
}

describe('a form submitting to a mutation', () =>
{
    it('runs it with the values, and the optimistic guess reaches the screen', async () =>
    {
        resetDataCache();
        let saved: string | null = null;
        const getProfile = cached('link-profile', async () =>
        {
            await wait(10);
            return { name: saved ?? 'old' };
        });
        const save = createMutation(async (values: Values) =>
        {
            await wait(40);
            saved = values.name;
        }, {
            optimistic: (values, patch) =>
            {
                patch(getProfile, () => ({ name: values.name }));
            }
        });

        await createRoot(async (dispose) =>
        {
            const profile = createResource(getProfile);
            const form = createForm<Values>({ initial: { name: '', email: '' }, onSubmit: save });
            await wait(40);
            expect(profile.data()?.name).toBe('old');

            form.setValue('name', 'Ada');
            form.handleSubmit(new Event('submit'));
            await flush();

            expect(form.submitting()).toBe(true);
            // The guess went through the form into the shared cache.
            expect(profile.data()?.name).toBe('Ada');

            await wait(120);
            expect(form.submitting()).toBe(false);
            expect(form.submitError()).toBeNull();
            expect(saved).toBe('Ada');
            dispose();
        });
    });

    it('a REFUSED write lands in submitError - the hand-wiring reports a false success', async () =>
    {
        resetDataCache();
        const save = createMutation(async (_values: Values) =>
        {
            await wait(20);
            throw new Error('server refused');
        });

        await createRoot(async (dispose) =>
        {
            const form = createForm<Values>({ initial: { name: '', email: '' }, onSubmit: save });
            form.setValue('name', 'Ada');
            form.handleSubmit(new Event('submit'));
            await wait(80);

            expect(form.submitting()).toBe(false);
            expect(String(form.submitError())).toContain('server refused');
            // Both halves agree; before the link they disagreed about the same submit.
            expect(String(save.error())).toContain('server refused');
            dispose();
        });
    });

    it("lands a refusal's field map on the fields, nested paths included", async () =>
    {
        resetDataCache();
        const save = createMutation(async (_values: Values) =>
        {
            await wait(10);
            throw new Refused({ email: 'already taken', 'name.first': 'too short', '': 'ignored' });
        });

        await createRoot(async (dispose) =>
        {
            const form = createForm<Values>({ initial: { name: '', email: '' }, onSubmit: save });
            form.setValue('name', 'Ada');
            form.setValue('email', 'ada@example.com');
            form.handleSubmit(new Event('submit'));
            await wait(60);

            expect(form.errors().email).toBe('already taken');
            // The first path segment is the field, matching the api client's own rule.
            expect(form.errors().name).toBe('too short');
            // And the refusal itself is still reported, so a banner has something to show.
            expect(String(form.submitError())).toContain('validation failed');
            dispose();
        });
    });

    it('CONTROL: a plain function onSubmit is unchanged - it rejects, and no field map is read', async () =>
    {
        resetDataCache();
        await createRoot(async (dispose) =>
        {
            const form = createForm<Values>({
                initial: { name: '', email: '' },
                onSubmit: async () =>
                {
                    await wait(10);
                    throw new Refused({ email: 'already taken' });
                }
            });
            form.setValue('name', 'Ada');
            form.handleSubmit(new Event('submit'));
            await wait(60);

            expect(String(form.submitError())).toContain('validation failed');
            // Existing behaviour preserved: a thrown refusal does NOT auto-apply its fields,
            // because applying them would silently change what every existing form does.
            expect(form.errors().email).toBeNull();
            dispose();
        });
    });

    it('validation still gates it: an invalid form never runs the mutation', async () =>
    {
        resetDataCache();
        const write = vi.fn(async () => undefined);
        const save = createMutation(write);

        await createRoot(async (dispose) =>
        {
            const form = createForm<Values>({
                initial: { name: '', email: '' },
                validate: { name: (value) => (value === '' ? 'Required' : null) },
                onSubmit: save
            });
            form.handleSubmit(new Event('submit'));
            await wait(40);

            expect(write).not.toHaveBeenCalled();
            expect(form.errors().name).toBe('Required');
            expect(form.submitting()).toBe(false);

            // The control: it does run once the form is valid.
            form.setValue('name', 'Ada');
            form.handleSubmit(new Event('submit'));
            await wait(40);
            expect(write).toHaveBeenCalledTimes(1);
            dispose();
        });
    });

    it('the ASYNC-validator submit path reaches the mutation too', async () =>
    {
        resetDataCache();
        const save = createMutation(async (_values: Values) =>
        {
            await wait(10);
            throw new Refused({ email: 'already taken' });
        });

        await createRoot(async (dispose) =>
        {
            // An async validator moves submission onto the second of the two submit paths;
            // a link wired into only one of them passes every test above and fails here.
            const form = createForm<Values>({
                initial: { name: '', email: '' },
                validateAsync: { name: async () => null },
                asyncDebounceMs: 1,
                onSubmit: save
            });
            form.setValue('name', 'Ada');
            await wait(30);
            form.handleSubmit(new Event('submit'));
            await wait(120);

            expect(String(form.submitError())).toContain('validation failed');
            expect(form.errors().email).toBe('already taken');
            dispose();
        });
    });
});
