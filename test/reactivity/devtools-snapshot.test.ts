// Phase 1 of the devtools build: the on-demand snapshot surface that powers
// the dependency graph, ownership tree, and live state editing. Verifies
// owner attribution, dependency edges, value peek/poke, dispose pruning,
// and that it stays inert with no hook installed.

import { describe, it, expect, afterEach } from 'vitest';
import {
    createSignal,
    createEffect,
    createMemo,
    createRoot,
    setDevtoolsHook,
    snapshotReactiveGraph,
    peekNode,
    pokeNode,
    type SnapshotNode
} from '@azerothjs/reactivity';

let uninstall: (() => void) | null = null;
const noop = (): void => undefined;
const noopHook = { created: noop, disposed: noop, run: noop, write: noop };

afterEach(() =>
{
    uninstall?.();
    uninstall = null;
});

function nodeByName(name: string): SnapshotNode | undefined
{
    return snapshotReactiveGraph().nodes.find((n) => n.name === name);
}

describe('snapshotReactiveGraph', () =>
{
    it('attributes nodes to their enclosing root (ownership tree)', () =>
    {
        uninstall = setDevtoolsHook(noopHook);

        createRoot((d) =>
        {
            createSignal(0, { name: 'count' });
            createEffect(() =>
            {
                // reads nothing notable
            }, { name: 'binding' });
            return d;
        });

        const snap = snapshotReactiveGraph();
        const root = snap.nodes.find((n) => n.kind === 'root');
        const sig = snap.nodes.find((n) => n.name === 'count');
        const eff = snap.nodes.find((n) => n.name === 'binding');

        expect(root).toBeTruthy();
        const rootId = root!.id;
        expect(sig!.owner).toBe(rootId);
        expect(eff!.owner).toBe(rootId);
    });

    it('records dependency edges from producer to consumer', () =>
    {
        uninstall = setDevtoolsHook(noopHook);

        const dispose = createRoot((d) =>
        {
            const [count] = createSignal(1, { name: 'count' });
            createEffect(() =>
            {
                count();
            }, { name: 'reader' });
            return d;
        });

        const snap = snapshotReactiveGraph();
        const sig = snap.nodes.find((n) => n.name === 'count')!;
        const eff = snap.nodes.find((n) => n.name === 'reader')!;
        expect(snap.edges.some((e) => e.from === sig.id && e.to === eff.id)).toBe(true);

        dispose();
    });

    it('peeks and pokes a signal value', () =>
    {
        uninstall = setDevtoolsHook(noopHook);

        const dispose = createRoot((d) =>
        {
            const [, setN] = createSignal(5, { name: 'n' });
            void setN;
            return d;
        });

        const id = nodeByName('n')!.id;
        expect(peekNode(id)).toEqual({ ok: true, value: 5 });

        expect(pokeNode(id, 42)).toBe(true);
        expect(peekNode(id)).toEqual({ ok: true, value: 42 });

        // An effect node has no value: peek/poke decline.
        const dispose2 = createRoot((d) =>
        {
            createEffect(() => undefined, { name: 'fx' });
            return d;
        });
        const fxId = nodeByName('fx')!.id;
        expect(peekNode(fxId).ok).toBe(false);
        expect(pokeNode(fxId, 1)).toBe(false);

        dispose();
        dispose2();
    });

    it('a memo appears as a node and an edge target of its sources', () =>
    {
        uninstall = setDevtoolsHook(noopHook);

        const dispose = createRoot((d) =>
        {
            const [price] = createSignal(10, { name: 'price' });
            const total = createMemo(() => price() * 2, { name: 'total' });
            total();
            return d;
        });

        const snap = snapshotReactiveGraph();
        const price = snap.nodes.find((n) => n.name === 'price')!;
        const total = snap.nodes.find((n) => n.name === 'total')!;
        expect(total.kind).toBe('memo');
        // total reads price.
        expect(snap.edges.some((e) => e.from === price.id && e.to === total.id)).toBe(true);
        // memo value is readable.
        expect(peekNode(total.id)).toEqual({ ok: true, value: 20 });

        dispose();
    });

    it('prunes effects and roots from the snapshot on dispose', () =>
    {
        uninstall = setDevtoolsHook(noopHook);

        const dispose = createRoot((d) =>
        {
            createEffect(() => undefined, { name: 'temp' });
            return d;
        });

        expect(nodeByName('temp')).toBeTruthy();
        expect(snapshotReactiveGraph().nodes.some((n) => n.kind === 'root')).toBe(true);

        dispose();

        expect(nodeByName('temp')).toBeUndefined();
        expect(snapshotReactiveGraph().nodes.some((n) => n.kind === 'root')).toBe(false);
    });

    it('is inert with no hook installed', () =>
    {
        // No setDevtoolsHook call: nothing registers.
        const dispose = createRoot((d) =>
        {
            createSignal(0, { name: 'ghost' });
            return d;
        });

        expect(snapshotReactiveGraph().nodes).toHaveLength(0);
        expect(peekNode(1).ok).toBe(false);

        dispose();
    });
});
