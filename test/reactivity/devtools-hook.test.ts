// The devtools event surface: who reports what, and - just as load-bearing
// - what stays silent: nodes created before the hook, equality-gated
// writes, validation-skipped effect runs.

import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createMemo,
    setDevtoolsHook,
    type DevtoolsNode
} from '@azerothjs/reactivity';

interface Recorded
{
    events: string[];
    byId: Map<number, DevtoolsNode>;
    uninstall: () => void;
}

function record(): Recorded
{
    const events: string[] = [];
    const byId = new Map<number, DevtoolsNode>();
    const uninstall = setDevtoolsHook({
        created(node)
        {
            byId.set(node.id, node);
            events.push(`created:${ node.kind }:${ node.name ?? '' }`);
        },
        disposed(id)
        {
            events.push(`disposed:${ byId.get(id)?.kind ?? '?' }`);
        },
        run(id)
        {
            events.push(`run:${ byId.get(id)?.kind ?? '?' }`);
        },
        write(id)
        {
            events.push(`write:${ byId.get(id)?.name ?? '' }`);
        }
    });
    return { events, byId, uninstall };
}

describe('devtools hook', () =>
{
    it('reports signal creation and value-changing writes, with names', () =>
    {
        const rec = record();

        const [, setCount] = createSignal(0, { name: 'count' });
        expect(rec.events).toEqual(['created:signal:count']);

        setCount(1);
        expect(rec.events).toEqual(['created:signal:count', 'write:count']);

        // Equality-gated write: no event, nothing changed.
        setCount(1);
        expect(rec.events).toHaveLength(2);

        rec.uninstall();
    });

    it('reports effect lifecycle and only REAL runs (validation skips stay silent)', () =>
    {
        const rec = record();

        const [count, setCount] = createSignal(0);
        const floored = createMemo(() => Math.floor(count()));

        const dispose = createEffect(() =>
        {
            floored();
        }, { name: 'binding' });

        // created signal/memo, memo's eager first run, effect created + run.
        expect(rec.events).toContain('created:effect:binding');
        const runsBefore = rec.events.filter(e => e === 'run:effect').length;
        expect(runsBefore).toBe(1);

        // The memo recomputes but comes out equal: the effect must NOT
        // report a run.
        setCount(0.5);
        expect(rec.events.filter(e => e === 'run:effect')).toHaveLength(1);
        expect(rec.events.filter(e => e === 'run:memo').length).toBeGreaterThanOrEqual(1);

        // A real change runs it.
        setCount(2);
        expect(rec.events.filter(e => e === 'run:effect')).toHaveLength(2);

        dispose();
        expect(rec.events.filter(e => e === 'disposed:effect')).toHaveLength(1);

        rec.uninstall();
    });

    it('nodes created before the hook stay invisible', () =>
    {
        const [count, setCount] = createSignal(0);
        const dispose = createEffect(() =>
        {
            count();
        });

        const rec = record();
        setCount(1);
        dispose();

        expect(rec.events).toHaveLength(0);
        rec.uninstall();
    });

    it('uninstalling restores the previous hook', () =>
    {
        const outer = record();
        const inner = record();

        inner.uninstall();
        createSignal(0, { name: 'after-inner' });

        expect(outer.events).toEqual(['created:signal:after-inner']);
        expect(inner.events).toHaveLength(0);

        outer.uninstall();
    });
});
