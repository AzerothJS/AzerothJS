import { fetcherReadMessage } from '../semantics.ts';
import { DEV_FETCHER_READS } from './dev.ts';
import { withTrackingFrame } from './untrack.ts';

type Fetcher = (...args: never[]) => unknown;
type Invocation = <T>(fetcher: Fetcher, label: string | undefined, invoke: () => T) => T;

/** A fetch keeps the current owner, but only its explicit source can subscribe the caller. */
export const invokeFetcher: Invocation = DEV_FETCHER_READS
    ? developmentInvocation()
    : (_fetcher, _label, invoke) => withTrackingFrame(null, invoke);

function developmentInvocation(): Invocation
{
    const warned = new WeakSet<Fetcher>();
    return (fetcher, label, invoke) =>
    {
        if (warned.has(fetcher))
        {
            return withTrackingFrame(null, invoke);
        }
        return withTrackingFrame(() =>
        {
            if (!warned.has(fetcher))
            {
                warned.add(fetcher);
                queueMicrotask(() => reportRead(fetcher, label));
            }
        }, invoke);
    };
}

function reportRead(fetcher: Fetcher, label: string | undefined): void
{
    if (label === undefined)
    {
        try
        {
            // A callable can replace its name with an accessor. Diagnostics need only a
            // string data property and should never execute that getter or coerce an object.
            const name: unknown = Object.getOwnPropertyDescriptor(fetcher, 'name')?.value;
            if (typeof name === 'string' && name.length > 0)
            {
                label = name;
            }
        }
        catch
        {
            // A proxy may also refuse descriptor inspection. The generic label still applies.
        }
    }
    try
    {
        console.warn(fetcherReadMessage(label ?? 'anonymous fetcher'));
    }
    catch (error)
    {
        try
        {
            console.error('[azeroth] Could not report a fetcher read.', error);
        }
        catch
        {
            // Both host logging methods failed. Advisory output must not fail the fetch.
        }
    }
}
