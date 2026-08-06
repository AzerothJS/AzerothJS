// @vitest-environment node
//
// The `client` lane over vite's console forwarding: recognition of the forwarded
// line shapes (exactly what vite 8's forwardConsole plugin emits), the house
// rendering, and the storm bucket. The transport itself is vite's - these specs
// pin OUR halves: detection, restyle, rate limit.
import { describe, it, expect } from 'vitest';
import { palette } from '@azerothjs/logger';
import { createLogBucket, detectClientLine, renderClientLine } from '../src/client-log.ts';

const plain = palette('none');

describe('detectClientLine', () =>
{
    it('recognizes forwarded console lines at every level', () =>
    {
        expect(detectClientLine('[console.error] boom')).toEqual({ level: 'error', message: 'boom', tail: '' });
        expect(detectClientLine('[console.warn] careful')).toEqual({ level: 'warn', message: 'careful', tail: '' });
        expect(detectClientLine('[console.log] plain note')).toEqual({ level: 'log', message: 'plain note', tail: '' });
    });

    it('recognizes unhandled errors/rejections with their source-mapped tail', () =>
    {
        const forwarded = [
            '[Unhandled error] TypeError: count is not a function',
            ' > onClick src/pages/home.azeroth:42:13',
            '    41 |     <button>',
            '    42 |         { count() }'
        ].join('\n');
        const line = detectClientLine(forwarded);
        expect(line?.level).toBe('error');
        expect(line?.message).toBe('TypeError: count is not a function');
        expect(line?.tail).toContain('onClick src/pages/home.azeroth:42:13');

        expect(detectClientLine('[Unhandled rejection] Error: nope')?.level).toBe('error');
    });

    it('leaves every other line alone', () =>
    {
        expect(detectClientLine('hmr update /src/x.azeroth')).toBeNull();
        expect(detectClientLine('[plugin:azerothjs] some warning')).toBeNull();
        expect(detectClientLine('GET /api → 200')).toBeNull();
    });
});

describe('renderClientLine', () =>
{
    it('renders the lane word, a level glyph, and dims the tail', () =>
    {
        const block = renderClientLine({ level: 'error', message: 'boom', tail: ' > at src/x.ts:1:1' }, plain, false);
        const lines = block.split('\n');
        expect(lines[0]).toContain('client');
        expect(lines[0]).toContain('x');
        expect(lines[0]).toContain('boom');
        expect(lines[1]).toBe(' > at src/x.ts:1:1');
    });

    it('marks warn and info levels distinctly', () =>
    {
        expect(renderClientLine({ level: 'warn', message: 'careful', tail: '' }, plain, false)).toContain('!');
        expect(renderClientLine({ level: 'log', message: 'note', tail: '' }, plain, false)).toContain('·');
    });
});

describe('createLogBucket', () =>
{
    it('allows a burst, refuses a storm, and reports the drop count on resume', () =>
    {
        let at = 0;
        const bucket = createLogBucket(3, 1, () => at);
        expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true]);
        expect(bucket.take()).toBe(false);
        expect(bucket.take()).toBe(false);

        at = 2000;
        expect(bucket.take()).toBe(true);
        expect(bucket.drain()).toBe(2);
        expect(bucket.drain()).toBe(0);
    });
});
