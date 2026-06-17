// The devtools agent: the framework-facing core. Verifies the live model
// (pruned on dispose), the timeline buffer, the enriched graph, peek/poke,
// coalesced subscriptions, and the serializable request dispatch.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAgent, previewValue, detectLeakTrend, type Agent } from '@azerothjs/devtools';
import { createSignal, createEffect, createMemo, createRoot } from '@azerothjs/reactivity';

let agent: Agent | null = null;

afterEach(() =>
{
    agent?.uninstall();
    agent = null;
    vi.useRealTimers();
});

describe('createAgent', () =>
{
    it('builds a live model and prunes disposed nodes', () =>
    {
        agent = createAgent();

        const [count, setCount] = createSignal(0, { name: 'count' });
        const dispose = createEffect(() =>
        {
            count();
        }, { name: 'binding' });
        setCount(1);

        let model = agent.getModel();
        expect(model.counts.signal).toBe(1);
        expect(model.counts.effect).toBe(1);
        expect(model.lastWrite?.name).toBe('count');
        expect(model.nodes.find((n) => n.name === 'binding')!.runs).toBeGreaterThanOrEqual(1);

        dispose();
        model = agent.getModel();
        expect(model.counts.effect).toBe(0);
        expect(model.nodes.find((n) => n.name === 'binding')).toBeUndefined();
    });

    it('serves an enriched dependency graph (edges + activity)', () =>
    {
        agent = createAgent();

        const dispose = createRoot((d) =>
        {
            const [price] = createSignal(10, { name: 'price' });
            createMemo(() => price() * 2, { name: 'total' })();
            return d;
        });

        const graph = agent.getGraph();
        const price = graph.nodes.find((n) => n.name === 'price')!;
        const total = graph.nodes.find((n) => n.name === 'total')!;
        expect(total.kind).toBe('memo');
        expect(graph.edges.some((e) => e.from === price.id && e.to === total.id)).toBe(true);

        dispose();
    });

    it('records a timeline of events', () =>
    {
        agent = createAgent();

        const [, setN] = createSignal(0, { name: 'n' });
        setN(1);
        setN(2);

        const types = agent.getTimeline().map((e) => e.type);
        expect(types).toContain('created');
        expect(types.filter((t) => t === 'write')).toHaveLength(2);
    });

    it('records why an effect ran (cause correlation)', () =>
    {
        agent = createAgent();

        const [count, setCount] = createSignal(0, { name: 'count' });
        const dispose = createEffect(() =>
        {
            count();
        }, { name: 'binding' });
        setCount(1);

        const runs = agent.getTimeline().filter((e) => e.type === 'run' && e.name === 'binding');
        expect(runs[0].cause).toBe('(initial)');           // first execution
        expect(runs[runs.length - 1].cause).toBe('count'); // re-run caused by the write

        dispose();
    });

    it('reports liveness without false-positive leaks on a fresh app', () =>
    {
        agent = createAgent();

        // Many effects created and none disposed yet - this is what every app
        // looks like right after load. It must NOT be flagged as a leak.
        const leaked: (() => void)[] = [];
        for (let i = 0; i < 25; i++)
        {
            leaked.push(createEffect(() => undefined));
        }

        const health = agent.getHealth();
        const effects = health.kinds.find((k) => k.kind === 'effect')!;
        expect(effects.created).toBeGreaterThanOrEqual(25);
        expect(effects.disposed).toBe(0);
        expect(effects.live).toBeGreaterThanOrEqual(25);
        expect(health.leaks).toHaveLength(0); // snapshot is never a leak

        for (const d of leaked)
        {
            d();
        }
    });

    it('records numeric value history for sparklines', () =>
    {
        agent = createAgent();

        const [, setN] = createSignal(0, { name: 'n' });
        setN(10);
        setN(20);
        setN(15);

        expect(agent.getHistory(agent.getModel().nodes.find((x) => x.name === 'n')!.id))
            .toEqual([10, 20, 15]);

        // Non-numeric signals are not tracked.
        const [, setS] = createSignal('a', { name: 's' });
        setS('b');
        const sId = agent.getModel().nodes.find((x) => x.name === 's')!.id;
        expect(agent.getHistory(sId)).toEqual([]);
    });

    it('exports a complete, serializable session snapshot', () =>
    {
        agent = createAgent();
        const dispose = createRoot((d) =>
        {
            const [, setPrice] = createSignal(10, { name: 'price' });
            createMemo(() => 1, { name: 'tax' })();
            setPrice(20);
            return d;
        });

        const snap = agent.exportSession();
        expect(snap.version).toBe(1);
        expect(snap.model.counts.signal).toBeGreaterThanOrEqual(1);
        expect(snap.graph.nodes.length).toBeGreaterThan(0);
        const price = snap.model.nodes.find((n) => n.name === 'price')!;
        expect(snap.values[price.id]).toBe('20');
        expect(snap.histories[price.id]).toEqual([20]);

        // The whole thing must survive a JSON round-trip (the bug-report path).
        expect(() => JSON.parse(JSON.stringify(snap))).not.toThrow();

        dispose();
    });

    it('pauses and clears timeline capture', () =>
    {
        agent = createAgent();

        const [, setN] = createSignal(0, { name: 'n' });
        setN(1);
        expect(agent.getTimeline().length).toBeGreaterThan(0);

        // Pause: new events are not appended, but the model keeps updating.
        agent.setRecording(false);
        const frozen = agent.getTimeline().length;
        setN(2);
        setN(3);
        expect(agent.getTimeline().length).toBe(frozen);
        expect(agent.getModel().lastWrite?.name).toBe('n'); // model still live

        // Resume + clear.
        agent.setRecording(true);
        expect(agent.isRecording()).toBe(true);
        agent.clearTimeline();
        expect(agent.getTimeline()).toHaveLength(0);
    });

    it('peeks and pokes signal values', () =>
    {
        agent = createAgent();
        const dispose = createRoot((d) =>
        {
            createSignal(7, { name: 'v' });
            return d;
        });

        const id = agent.getModel().nodes.find((n) => n.name === 'v')!.id;
        expect(agent.peek(id)).toEqual({ ok: true, value: '7' });

        expect(agent.poke(id, 99)).toBe(true);
        expect(agent.peek(id)).toEqual({ ok: true, value: '99' });

        dispose();
    });

    it('notifies subscribers, coalesced', () =>
    {
        vi.useFakeTimers();
        agent = createAgent();

        let calls = 0;
        agent.subscribe(() => calls++);

        const [, setN] = createSignal(0);
        for (let i = 1; i <= 50; i++)
        {
            setN(i);
        }
        expect(calls).toBe(0); // coalesced, not yet flushed

        vi.advanceTimersByTime(150);
        expect(calls).toBe(1); // one notification for the whole burst
    });

    it('dispatches serializable requests via handle()', () =>
    {
        agent = createAgent();
        const dispose = createRoot((d) =>
        {
            createSignal(3, { name: 'x' });
            return d;
        });

        const model = agent.handle({ kind: 'model' }) as ReturnType<Agent['getModel']>;
        const id = model.nodes.find((n) => n.name === 'x')!.id;

        expect(agent.handle({ kind: 'peek', id })).toEqual({ ok: true, value: '3' });
        expect(agent.handle({ kind: 'poke', id, value: 8 })).toEqual({ ok: true });
        expect(agent.handle({ kind: 'peek', id })).toEqual({ ok: true, value: '8' });

        // Every response must be JSON-serializable (the transport boundary).
        expect(() => JSON.stringify(agent!.handle({ kind: 'graph' }))).not.toThrow();
        expect(() => JSON.stringify(agent!.handle({ kind: 'timeline' }))).not.toThrow();

        dispose();
    });
});

describe('detectLeakTrend', () =>
{
    it('flags sustained growth, not plateaus or startup ramps', () =>
    {
        const full = (fn: (i: number) => number): number[] => Array.from({ length: 30 }, (_, i) => fn(i));

        // Steady climb across the whole window: a leak.
        expect(detectLeakTrend(full((i) => 10 + i * 2))).toBe(true);

        // Flat plateau: healthy.
        expect(detectLeakTrend(full(() => 50))).toBe(false);

        // Startup ramp that then plateaus (recent half flat): healthy.
        expect(detectLeakTrend(full((i) => Math.min(i, 12) + 40))).toBe(false);

        // Not enough samples yet: never flag.
        expect(detectLeakTrend([1, 5, 10, 20, 40])).toBe(false);

        // Tiny wobble within the window: not material growth.
        expect(detectLeakTrend(full((i) => 50 + (i % 2)))).toBe(false);
    });
});

describe('previewValue', () =>
{
    it('renders values as short transport-safe strings', () =>
    {
        expect(previewValue(42)).toBe('42');
        expect(previewValue('hi')).toBe('"hi"');
        expect(previewValue(true)).toBe('true');
        expect(previewValue(null)).toBe('null');
        expect(previewValue([1, 2, 3])).toBe('Array(3)');
        expect(previewValue({ a: 1 })).toBe('{"a":1}');
        expect(previewValue(() => 0)).toBe('fn()');
        expect(previewValue('x'.repeat(300)).endsWith('...')).toBe(true);
    });
});
