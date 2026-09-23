// @vitest-environment node
//
// captureRequestContext on the legacy AsyncLocalStorage (Node 22, or --no-async-context-frame),
// which the default frame mode hides, so the arm runs in a child forced into that mode.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = new URL('../src/request-root.ts', import.meta.url).href;

/** Node 22 runs this mode by default and has no flag for it. */
const LEGACY = process.allowedNodeEnvironmentFlags.has('--no-async-context-frame') ? ['--no-async-context-frame'] : [];

const PROGRAM = `
import { AsyncLocalStorage } from 'node:async_hooks';
import { captureRequestContext } from ${ JSON.stringify(ROOT) };

const store = new AsyncLocalStorage();
const raw = AsyncLocalStorage.snapshot();
raw(() => store.enterWith('raw'));
const legacy = raw(() => store.getStore()) === 'raw';

const boot = new AsyncLocalStorage();
const frame = boot.run('pool', () => captureRequestContext());
frame(() => store.enterWith('render-1'));
const second = frame(() => store.getStore()) ?? 'none';
const sync = frame(() => boot.getStore());
const later = await frame(async () =>
{
    await Promise.resolve();
    return boot.getStore();
});
console.log(JSON.stringify({ legacy, second, sync, later }));
`;

describe('captureRequestContext on the legacy AsyncLocalStorage', () =>
{
    it('a store one call enters with enterWith does not reach the next, and the captured store stays visible', async () =>
    {
        const { stdout } = await run(process.execPath, [...LEGACY, '--input-type=module', '-e', PROGRAM], { timeout: 30000 });

        // The mode check: a raw snapshot does keep the store here, so the arm can go red.
        expect(JSON.parse(stdout.trim())).toEqual({ legacy: true, second: 'none', sync: 'pool', later: 'pool' });
    }, 60000);
});
