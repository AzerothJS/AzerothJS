// @vitest-environment node
//
// The default-scope refusal during a BUILD: a prerender pass answers no request, so the advice
// about installing a request root is not advice a build log should carry. Its own file because
// the diagnostic latches once per process, and this needs a module instance whose latch no
// other arm has burned.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installRequestContext, setBuildContext } from 'azerothjs/internal';

afterEach(() =>
{
    setBuildContext(false);
    vi.restoreAllMocks();
});

describe('installing at the default scope while a build is running', () =>
{
    it('says nothing during the build, and still speaks once for the host that comes after it', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        setBuildContext(true);
        installRequestContext(new Request('http://shop.test/doc'));
        expect(warn).not.toHaveBeenCalled();

        // The build path does not burn the latch, so a genuine misconfiguration afterwards is
        // still diagnosed rather than swallowed.
        setBuildContext(false);
        installRequestContext(new Request('http://shop.test/live'));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/runInRequestRoot/);
    });
});
