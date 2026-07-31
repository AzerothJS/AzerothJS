// @vitest-environment node
//
// `implement(routes, ...)` keys its result RELATIVE to the routes it was given (`list`, `read`),
// because that is the only key space a feature file can know. `mountApi(app, contract, ...)` keys
// against the whole contract (`issues.list`). Spreading the first into the second therefore
// compiles and fails at BOOT, and the two halves of one feature disagree about the key space.
//
// The structural fix is a design change; this pins the diagnosis. A mount that finds `list` where
// it wanted `issues.list` is looking at exactly this mistake, and the error now says so and names
// both ways out - rather than reporting a generic gap and leaving the reader to work out that
// implement() and mountApi count from different places.
import { describe, expect, it } from 'vitest';

import { App } from '../../src/index.ts';
import { defineContract, get, group, implement, mountApi } from '../../src/api/index.ts';
import { object, string } from '@azerothjs/schema';

const issueRoutes = group('/issues', {
    list: get('/', { output: object({ ok: string() }) }),
    read: get('/:id', { output: object({ ok: string() }) })
});

const contract = defineContract({ issues: issueRoutes });

describe('a group-relative handler map mounted against the whole contract', () =>
{
    it('names the mistake instead of reporting a bare gap', () =>
    {
        const app = new App({ dev: false });
        const handlers = implement(issueRoutes, {
            list: () => ({ ok: 'y' }),
            read: () => ({ ok: 'y' })
        });

        let thrown: unknown;
        try
        {
            // The exact shape a developer writes, and it type-checks.
            mountApi(app, contract, { handlers: { ...handlers } as never });
        }
        catch (error)
        {
            thrown = error;
        }

        const message = (thrown as Error | undefined)?.message ?? '';
        expect(message).toContain('issues.list');
        // The diagnosis: the relative key IS present, so this is a key-space mismatch.
        expect(message).toMatch(/implement/i);
        // Both ways out are named.
        expect(message).toMatch(/subtree|contract\.issues/i);
    });

    it('still reports a genuinely missing handler plainly', () =>
    {
        const app = new App({ dev: false });

        let thrown: unknown;
        try
        {
            mountApi(app, contract, { handlers: { 'issues.list': () => ({ ok: 'y' }) } as never });
        }
        catch (error)
        {
            thrown = error;
        }

        const message = (thrown as Error | undefined)?.message ?? '';
        expect(message).toContain('issues.read');
        // No key-space hint here - nothing suggests implement() was involved.
        expect(message).not.toMatch(/implement/i);
    });

    it('mounting the subtree works, which is the documented way out', () =>
    {
        const app = new App({ dev: false });
        const handlers = implement(issueRoutes, {
            list: () => ({ ok: 'y' }),
            read: () => ({ ok: 'y' })
        });

        expect(() => mountApi(app, contract.issues, { prefix: '/api', handlers: { ...handlers } })).not.toThrow();
        expect(app.routes().some((line) => line.includes('/api/issues/'))).toBe(true);
    });
});
