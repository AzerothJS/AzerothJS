// Opt-in performance instrumentation. Disabled by default so the hot path stays
// allocation-free: when `enabled` is false every measurement is a single boolean
// read and nothing is recorded. Callers (the service facade) flip the flag via
// `setEnabled`, then read accumulated timings with `snapshot`.

/** Per-request timings, in milliseconds. */
export interface Metrics
{
    /** Time spent in generateVirtualCode for the request. */
    virtualCodeMs: number;

    /** Wall-clock time for the whole request entry. */
    totalMs: number;

    /**
     * The most recent duration recorded under each label, including one per
     * instrumented provider (`completion`, `hover`, `definition`, ...). Lets a
     * harness read which feature a regression lives in, not just the total.
     */
    requests: Record<string, number>;
}

let enabled = false;
const timings: Record<string, number> = {};

/** Toggles instrumentation. Off by default; when off, `record` is a no-op. */
export function setEnabled(value: boolean): void
{
    enabled = value;
}

/** Whether instrumentation is currently recording. */
export function isEnabled(): boolean
{
    return enabled;
}

/** Records a measured duration under `label`, overwriting the previous value. */
export function record(label: string, ms: number): void
{
    timings[label] = ms;
}

/**
 * Times `fn` under `label` when instrumentation is on, and returns its result.
 * When off this is a straight passthrough - no `performance.now()` call, no
 * record - so the hot path stays allocation-free.
 */
export function measure<T>(label: string, fn: () => T): T
{
    if (!enabled)
    {
        return fn();
    }
    const start = performance.now();
    try
    {
        return fn();
    }
    finally
    {
        record(label, performance.now() - start);
    }
}

/** The most recent timings as a Metrics object. Absent labels read as 0. */
export function snapshot(): Metrics
{
    return {
        virtualCodeMs: timings.virtualCode ?? 0,
        totalMs: timings.total ?? 0,
        requests: { ...timings }
    };
}
