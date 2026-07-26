// @vitest-environment node
//
// Full behavioral coverage for batch (batch.ts): write coalescing, in-batch value
// visibility, deferred effect flush, and nesting.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createMemo,
    createRoot,
    batch
} from 'azerothjs';

describe('batch', () =>
{
    it('coalesces multiple writes into a single downstream effect run', () =>
    {
        createRoot((dispose) =>
        {
            const [first, setFirst] = createSignal('Ada');
            const [last, setLast] = createSignal('Lovelace');
            const seen: string[] = [];
            createEffect(() =>
            {
                seen.push(`${ first() } ${ last() }`);
            });
            expect(seen).toEqual(['Ada Lovelace']);

            batch(() =>
            {
                setFirst('Grace');
                setLast('Hopper');
            });

            expect(seen).toEqual(['Ada Lovelace', 'Grace Hopper']);
            dispose();
        });
    });

    it('exposes the latest written value synchronously inside the batch', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            batch(() =>
            {
                setN(1);
                expect(n()).toBe(1);
                setN((prev) => prev + 10);
                expect(n()).toBe(11);
            });
            expect(n()).toBe(11);
            dispose();
        });
    });

    it('defers dependent effects until the batch completes', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            let runs = 0;
            createEffect(() =>
            {
                n();
                runs++;
            });
            expect(runs).toBe(1);
            batch(() =>
            {
                setN(1);
                setN(2);
                setN(3);
                expect(runs).toBe(1); // not yet flushed
            });
            expect(runs).toBe(2); // flushed once
            dispose();
        });
    });

    it('runs an effect once even when several of its dependencies change in a batch', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal(1);
            const [b, setB] = createSignal(1);
            const sum = createMemo(() => a() + b());
            let runs = 0;
            createEffect(() =>
            {
                sum();
                runs++;
            });
            expect(runs).toBe(1);
            batch(() =>
            {
                setA(10);
                setB(20);
            });
            expect(runs).toBe(2);
            expect(sum()).toBe(30);
            dispose();
        });
    });

    it('flattens nested batches into a single flush', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            let runs = 0;
            createEffect(() =>
            {
                n();
                runs++;
            });
            batch(() =>
            {
                setN(1);
                batch(() =>
                {
                    setN(2);
                });
                setN(3);
                expect(runs).toBe(1);
            });
            expect(runs).toBe(2);
            expect(n()).toBe(3);
            dispose();
        });
    });

    it('coalesces to a single run even when writes net back to the original value', () =>
    {
        // Writes are applied EAGERLY (batch defers effect runs, not the writes), so each
        // differing write advances the signal version; the coalesced effect therefore
        // runs once at flush even though the final value equals the starting value.
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(5);
            let runs = 0;
            createEffect(() =>
            {
                n();
                runs++;
            });
            batch(() =>
            {
                setN(9);
                setN(5);
            });
            expect(runs).toBe(2);
            expect(n()).toBe(5);
            dispose();
        });
    });

    it('does not run when no write actually changes the value', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(5);
            let runs = 0;
            createEffect(() =>
            {
                n();
                runs++;
            });
            batch(() =>
            {
                setN(5);
                setN(5);
            });
            expect(runs).toBe(1);
            dispose();
        });
    });

    it('one throwing effect does not strand the rest of the flush', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            let bRuns = 0;
            // Effect A throws once n goes positive, with no error handler around it.
            createEffect(() =>
            {
                if (n() > 0)
                {
                    throw new Error('effect A boom');
                }
            });
            // Effect B shares the same dependency and MUST still run when A throws.
            createEffect(() =>
            {
                n();
                bRuns++;
            });
            expect(bRuns).toBe(1); // both ran once on creation (n = 0, A did not throw)

            // The write flushes both. A throws; the error surfaces from the write, but only
            // AFTER B has run - a throwing effect no longer strands the rest of the flush.
            expect(() => setN(1)).toThrow('effect A boom');
            expect(bRuns).toBe(2);
            dispose();
        });
    });
});
