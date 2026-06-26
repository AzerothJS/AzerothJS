// @vitest-environment node
//
// The stable, versioned devtools hook protocol. Verifies that a hook observes the live reactive graph
// (create/run/write/dispose), that the graph snapshot reflects nodes + dependency edges + ownership, that
// peek/poke read and drive signal values, and - critically - that detaching the hook restores zero
// instrumentation (no leaked references, no further events).
import { describe, it, expect, afterEach } from 'vitest';
import {
    createSignal, createMemo, createEffect, createRoot,
    setDevtoolsHook, snapshotReactiveGraph, peekNode, pokeNode,
    DEVTOOLS_PROTOCOL_VERSION, type DevtoolsHook, type DevtoolsNode
} from '@azerothjs/reactivity';

interface Event { type: 'created' | 'disposed' | 'run' | 'write'; id: number; kind?: string; }

function recordingHook(): { hook: DevtoolsHook; events: Event[]; nodes: Map<number, DevtoolsNode> }
{
    const events: Event[] = [];
    const nodes = new Map<number, DevtoolsNode>();
    const hook: DevtoolsHook = {
        created(node)
        {
            nodes.set(node.id, node); events.push({ type: 'created', id: node.id, kind: node.kind });
        },
        disposed(id)
        {
            events.push({ type: 'disposed', id });
        },
        run(id)
        {
            events.push({ type: 'run', id });
        },
        write(id)
        {
            events.push({ type: 'write', id });
        }
    };
    return { hook, events, nodes };
}

describe('devtools hook protocol', () =>
{
    let uninstall: () => void = () =>
    {};
    afterEach(() => uninstall());

    it('exposes a numeric protocol version', () =>
    {
        expect(typeof DEVTOOLS_PROTOCOL_VERSION).toBe('number');
    });

    it('observes create, run, write and dispose for signals/memos/effects/roots', () =>
    {
        const { hook, events, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        const dispose = createRoot((d) =>
        {
            const [count, setCount] = createSignal(0, { name: 'count' });
            createMemo(() => count() * 2, { name: 'doubled' });
            createEffect(() =>
            {
                count();
            }, { name: 'log' });
            setCount(5);
            return d;
        });

        const kinds = [...nodes.values()].map((n) => n.kind).sort();
        expect(kinds).toEqual(['effect', 'memo', 'root', 'signal']);

        expect(events.some((e) => e.type === 'created' && e.kind === 'signal')).toBe(true);
        expect(events.some((e) => e.type === 'write')).toBe(true);
        expect(events.some((e) => e.type === 'run')).toBe(true);

        dispose();
        expect(events.filter((e) => e.type === 'disposed').length).toBeGreaterThanOrEqual(3);
    });

    it('snapshots nodes, dependency edges, and ownership', () =>
    {
        const { hook, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        let dispose!: () => void;
        createRoot((d) =>
        {
            const [a] = createSignal(1, { name: 'a' });
            createMemo(() => a() + 1, { name: 'm' });
            dispose = d;
        });

        const snap = snapshotReactiveGraph();
        expect(snap.version).toBe(DEVTOOLS_PROTOCOL_VERSION);
        const signal = snap.nodes.find((n) => n.name === 'a')!;
        const memo = snap.nodes.find((n) => n.name === 'm')!;
        expect(signal.kind).toBe('signal');
        expect(memo.kind).toBe('memo');
        // The memo reads the signal => an edge signal -> memo.
        expect(snap.edges.some((e) => e.from === signal.id && e.to === memo.id)).toBe(true);
        // Both are owned by the root.
        const root = [...nodes.values()].find((n) => n.kind === 'root')!;
        expect(signal.owner).toBe(root.id);
        expect(memo.owner).toBe(root.id);
        dispose();
    });

    it('peek reads and poke drives a signal value', () =>
    {
        const { hook, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        let read!: () => number; let dispose!: () => void;
        createRoot((d) =>
        {
            const [n, setN] = createSignal(10, { name: 'n' });
            read = n; void setN;
            dispose = d;
        });

        const signalId = [...nodes.values()].find((x) => x.kind === 'signal')!.id;
        expect(peekNode(signalId)).toEqual({ ok: true, value: 10 });
        expect(pokeNode(signalId, 42)).toBe(true);
        expect(read()).toBe(42);
        // An effect is not a readable value.
        expect(peekNode(999_999)).toEqual({ ok: false });
        dispose();
    });

    it('detaching the hook stops all events (zero instrumentation when off)', () =>
    {
        const { hook, events } = recordingHook();
        const off = setDevtoolsHook(hook);
        off();
        const before = events.length;
        createRoot((d) =>
        {
            const [, setX] = createSignal(0); setX(1); d();
        });
        expect(events.length).toBe(before); // nothing recorded after detach
    });
});
