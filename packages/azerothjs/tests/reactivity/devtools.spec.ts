// @vitest-environment node
//
// The stable, versioned devtools hook protocol. Verifies that a hook observes the live reactive graph
// (create/run/write/dispose), that the graph snapshot reflects nodes + dependency edges + ownership, that
// peek/poke read and drive signal values, and - critically - that detaching the hook restores zero
// instrumentation (no leaked references, no further events).
import { describe, it, expect, afterEach } from 'vitest';
import {
    createSignal, createMemo, createEffect, createRoot,
    createResource, createStore, createDeferred, createForm
} from 'azerothjs';
import {
    setDevtoolsHook, snapshotReactiveGraph, peekNode, pokeNode,
    DEVTOOLS_PROTOCOL_VERSION, type DevtoolsHook, type DevtoolsNode
} from 'azerothjs/internal';

interface Event { type: 'created' | 'disposed' | 'run' | 'write'; id: number; kind?: string; cause?: number; }

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
        run(id, cause)
        {
            events.push({ type: 'run', id, cause });
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

describe('devtools protocol v2 - primitive attribution', () =>
{
    let uninstall: () => void = () =>
    {};
    afterEach(() => uninstall());

    it('a resource stamps its internals with primitive/group/groupName', () =>
    {
        const { hook, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        let dispose!: () => void;
        createRoot((d) =>
        {
            createResource(() => Promise.resolve(1), { name: 'user' });
            dispose = d;
        });

        const members = [...nodes.values()].filter((n) => n.primitive === 'resource');
        expect(members.length).toBeGreaterThanOrEqual(4); // data/loading/error/tick + fetch effect
        const groups = new Set(members.map((n) => n.group));
        expect(groups.size).toBe(1); // one instance, one group
        expect(members.every((n) => n.groupName === 'user')).toBe(true);
        expect(members.map((n) => n.name)).toContain('data');
        expect(members.map((n) => n.name)).toContain('loading');
        dispose();
    });

    it('a form groups its fields and derived state under its name', () =>
    {
        const { hook, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        let dispose!: () => void;
        createRoot((d) =>
        {
            createForm({ name: 'login', initial: { email: '', password: '' } });
            dispose = d;
        });

        const members = [...nodes.values()].filter((n) => n.primitive === 'form');
        expect(members.map((n) => n.name)).toEqual(expect.arrayContaining(['email', 'password', 'errors', 'values', 'isValid']));
        expect(members.every((n) => n.groupName === 'login')).toBe(true);
        dispose();
    });

    it('a store frame covers the factory; distinct instances get distinct groups', () =>
    {
        const { hook, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        const useA = createStore(() =>
        {
            const [x] = createSignal(1, { name: 'x' });
            return { x };
        }, { name: 'a' });
        const useB = createStore(() =>
        {
            const [y] = createSignal(2, { name: 'y' });
            return { y };
        }, { name: 'b' });
        useA();
        useB();

        const a = [...nodes.values()].find((n) => n.name === 'x')!;
        const b = [...nodes.values()].find((n) => n.name === 'y')!;
        expect(a.primitive).toBe('store');
        expect(a.groupName).toBe('a');
        expect(b.groupName).toBe('b');
        expect(a.group).not.toBe(b.group);
    });

    it('a deferred groups its internals; a bare signal/memo/effect stays untagged', () =>
    {
        const { hook, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        let dispose!: () => void;
        createRoot((d) =>
        {
            const [source] = createSignal(0, { name: 'source' });
            createDeferred(source, { name: 'lazy' });
            createMemo(() => source() + 1, { name: 'plain' });
            dispose = d;
        });

        const lazy = [...nodes.values()].find((n) => n.name === 'lazy')!;
        expect(lazy.primitive).toBe('deferred');
        const source = [...nodes.values()].find((n) => n.name === 'source')!;
        const plain = [...nodes.values()].find((n) => n.name === 'plain')!;
        expect(source.primitive).toBeUndefined();
        expect(plain.primitive).toBeUndefined();
        dispose();
    });

    it('run reports the DIRECT producer that triggered it (signal -> memo -> effect)', () =>
    {
        const { hook, events, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        let dispose!: () => void;
        createRoot((d) =>
        {
            const [n, setN] = createSignal(0, { name: 'n' });
            const twice = createMemo(() => n() * 2, { name: 'twice' });
            createEffect(() =>
            {
                twice();
            }, { name: 'watcher' });
            setN(1);
            dispose = d;
        });

        const byName = (name: string): number => [...nodes.values()].find((x) => x.name === name)!.id;
        const runs = events.filter((e) => e.type === 'run');
        // Initial runs carry no cause.
        expect(runs[0]?.cause).toBe(0);
        // After the write: the memo's re-run is caused by the signal, the effect's by the memo.
        const memoRun = runs.filter((r) => r.id === byName('twice')).at(-1);
        const effectRun = runs.filter((r) => r.id === byName('watcher')).at(-1);
        expect(memoRun?.cause).toBe(byName('n'));
        expect(effectRun?.cause).toBe(byName('twice'));
        dispose();
    });

    it('the snapshot carries primitive/group/groupName', () =>
    {
        const { hook } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        let dispose!: () => void;
        createRoot((d) =>
        {
            createResource(() => Promise.resolve(1), { name: 'user' });
            dispose = d;
        });

        const snap = snapshotReactiveGraph();
        const data = snap.nodes.find((n) => n.name === 'data' && n.primitive === 'resource');
        expect(data?.groupName).toBe('user');
        expect(typeof data?.group).toBe('number');
        dispose();
    });

    it('a throwing constructor cannot leak its frame past the enclosing root', () =>
    {
        const { hook, nodes } = recordingHook();
        uninstall = setDevtoolsHook(hook);

        expect(() => createRoot(() =>
        {
            createDeferred(() =>
            {
                throw new Error('bad source');
            }, { name: 'boom' });
        })).toThrow('bad source');

        // Nodes created AFTER the failed constructor are not stamped with its frame.
        let dispose!: () => void;
        createRoot((d) =>
        {
            createSignal(1, { name: 'after' });
            dispose = d;
        });
        const after = [...nodes.values()].find((n) => n.name === 'after')!;
        expect(after.primitive).toBeUndefined();
        dispose();
    });
});
