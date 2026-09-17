// @vitest-environment node
/**
 * The incremental checker on the classic TypeScript engine: the text a transform hands over is
 * preferred for a path until that path changes on disk, and an invalidate puts the path back on
 * its disk projection for every consumer that resolves it.
 *
 * The engine is picked once per process on the first check, so this file forces the classic one
 * for itself and asserts the native module is off before any checker runs.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createIncrementalChecker } from '../src/typecheck-ts.ts';
import { loadNativeTs } from '../src/native-ts.ts';
import { generateVirtualCode } from '../src/project.ts';
import { azeroth } from '../src/vite.ts';

const previousFlag = process.env.AZEROTH_NATIVE_TS;
process.env.AZEROTH_NATIVE_TS = '0';

// Inside the compiler package so a bare `azerothjs` import resolves through the workspace
// node_modules, which is what makes cross-file prop checking real.
const root = fileURLToPath(new URL('./.tmp-classic', import.meta.url));

// Cross-file prop checking needs an EXPORTED child reached by a NAMED import: a default import
// or a child that is not exported degrades to `any` and every case below, control included,
// reports nothing.
const CHILD_ONE_PROP = `export component Child(props: { label: string })
{
    <p>{ props.label }</p>
}
`;
const CHILD_TWO_PROPS = `export component Child(props: { label: string; tone: string })
{
    <p>{ props.label }</p>
}
`;
const CHILD_NUMBER_TONE = `export component Child(props: { label: string; tone: number })
{
    <p>{ props.label }</p>
}
`;
const CHILD_NUMBER_LABEL = `export component Child(props: { label: number })
{
    <p>{ props.label }</p>
}
`;
const VIEW_ONE_PROP = `import { Child } from './child.azeroth';

component View
{
    <Child label="hi" />
}
`;
const VIEW_TWO_PROPS = `import { Child } from './child.azeroth';

component View
{
    <Child label="hi" tone="warm" />
}
`;
const VIEW_WRONG_LABEL = `import { Child } from './child.azeroth';

component View
{
    <Child label={5} />
}
`;

// The shape an app-side `enforce: 'pre'` plugin produces: what the transform hands over is not
// what sits on disk, so the checker keeps a live copy of the path.
const rewritten = (source: string): string => `${ source }// rewritten by a pre plugin
`;

interface Fixture
{
    child: string;
    view: string;
}

const fixture = (name: string): Fixture =>
{
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return { child: join(dir, 'child.azeroth'), view: join(dir, 'view.azeroth') };
};

const seeded = new Map<string, Fixture>();
const seed = (name: string, view: string): void =>
{
    const paths = fixture(name);
    writeFileSync(paths.child, CHILD_ONE_PROP);
    writeFileSync(paths.view, view);
    seeded.set(name, paths);
};
const pathsOf = (name: string): Fixture => seeded.get(name)!;

beforeAll(() =>
{
    expect(loadNativeTs()).toBeNull();
    mkdirSync(root, { recursive: true });
    seed('adds-a-prop', VIEW_ONE_PROP);
    seed('changes-a-type', VIEW_ONE_PROP);
    seed('stamp', VIEW_ONE_PROP);
    seed('control', VIEW_WRONG_LABEL);
    seed('re-save', VIEW_ONE_PROP);
    seed('bom', VIEW_ONE_PROP);
});

afterAll(() =>
{
    rmSync(root, { recursive: true, force: true });
    if (previousFlag === undefined)
    {
        delete process.env.AZEROTH_NATIVE_TS;
    }
    else
    {
        process.env.AZEROTH_NATIVE_TS = previousFlag;
    }
});

describe('createIncrementalChecker - a changed file is checked from disk (classic engine)', () =>
{
    it('accepts a consumer that passes the prop a child gained on disk', () =>
    {
        const paths = pathsOf('adds-a-prop');
        // The live copy only exists while the handed text projects differently from the disk
        // text; without that difference the case would pass for the wrong reason.
        const handed = rewritten(CHILD_ONE_PROP);
        expect(generateVirtualCode(handed).code).not.toBe(generateVirtualCode(CHILD_ONE_PROP).code);

        const checker = createIncrementalChecker();
        expect(checker.check(paths.child, handed)).toHaveLength(0);

        writeFileSync(paths.child, CHILD_TWO_PROPS);
        writeFileSync(paths.view, VIEW_TWO_PROPS);
        checker.invalidate(paths.child);

        expect(checker.check(paths.view, VIEW_TWO_PROPS)).toHaveLength(0);
    });

    it('refuses a consumer that keeps the old type after the child prop type changed on disk', () =>
    {
        const paths = pathsOf('changes-a-type');
        const checker = createIncrementalChecker();
        expect(checker.check(paths.child, rewritten(CHILD_ONE_PROP))).toHaveLength(0);

        writeFileSync(paths.child, CHILD_NUMBER_LABEL);
        checker.invalidate(paths.child);

        const diagnostics = checker.check(paths.view, VIEW_ONE_PROP);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
        expect(diagnostics[0]!.message).toContain('number');
        expect(VIEW_ONE_PROP.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe('label');
    });

    it('keeps a consumer that is rewritten on every check reading its own newest text', () =>
    {
        const paths = pathsOf('stamp');
        const checker = createIncrementalChecker();
        expect(checker.check(paths.view, rewritten(VIEW_ONE_PROP))).toHaveLength(0);

        writeFileSync(paths.child, CHILD_TWO_PROPS);
        writeFileSync(paths.view, VIEW_TWO_PROPS);
        checker.invalidate(paths.child);
        checker.invalidate(paths.view);
        expect(checker.check(paths.view, rewritten(VIEW_TWO_PROPS))).toHaveLength(0);

        const later = VIEW_TWO_PROPS.replace('label="hi"', 'label="hello"');
        writeFileSync(paths.view, later);
        checker.invalidate(paths.view);
        expect(checker.check(paths.view, rewritten(later))).toHaveLength(0);
    });

    it('CONTROL: a genuine mismatch is refused, naming the signature on disk', () =>
    {
        const paths = pathsOf('control');
        const checker = createIncrementalChecker();

        const diagnostics = checker.check(paths.view, VIEW_WRONG_LABEL);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
        expect(diagnostics[0]!.message).toContain('string');
        expect(VIEW_WRONG_LABEL.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe('label');
    });

    it('names the newest signature when the child is saved twice with no consumer check between', () =>
    {
        const paths = pathsOf('re-save');
        const checker = createIncrementalChecker();
        expect(checker.check(paths.child, rewritten(CHILD_ONE_PROP))).toHaveLength(0);

        writeFileSync(paths.child, CHILD_TWO_PROPS);
        writeFileSync(paths.view, VIEW_TWO_PROPS);
        checker.invalidate(paths.child);

        writeFileSync(paths.child, CHILD_NUMBER_TONE);
        checker.invalidate(paths.child);

        const diagnostics = checker.check(paths.view, VIEW_TWO_PROPS);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
        expect(diagnostics[0]!.message).toContain('number');
        expect(VIEW_TWO_PROPS.slice(diagnostics[0]!.start, diagnostics[0]!.end)).toBe('tone');
    });
});

describe('azeroth() plugin - a byte-order mark never reaches the checker (classic engine)', () =>
{
    // The second layer over the invalidate drop: the mark is what made a transform of an otherwise
    // unchanged file leave a live copy behind at all. Either layer alone keeps this case green.
    it('lets a consumer see the prop a BOM-marked child gained on disk', async () =>
    {
        const paths = pathsOf('bom');
        const plugin = azeroth();
        const notices: ((path: string) => void)[] = [];
        (plugin.configResolved as (r: { root?: string; command?: string }) => void)(
            { root: join(root, 'bom'), command: 'serve' });
        await (plugin.configureServer as (s: {
            watcher: { on(event: string, fn: (path: string) => void): void };
        }) => Promise<void>)(
            {
                watcher:
                {
                    on: (event: string, fn: (path: string) => void): void =>
                    {
                        if (event === 'change')
                        {
                            notices.push(fn);
                        }
                    }
                }
            });
        (plugin.buildStart as () => void).call({});

        const transform = plugin.transform as unknown as (this: unknown, code: string, id: string) => Promise<unknown>;
        const ctx =
        {
            warn: (): void => undefined,
            error: (message: unknown): never =>
            {
                throw new Error(typeof message === 'object' && message !== null && 'message' in message
                    ? String(message.message)
                    : String(message));
            }
        };
        await expect(transform.call(ctx, `\uFEFF${ CHILD_ONE_PROP }`, paths.child)).resolves.toBeTruthy();

        writeFileSync(paths.child, CHILD_TWO_PROPS);
        writeFileSync(paths.view, VIEW_TWO_PROPS);
        for (const notice of notices)
        {
            notice(paths.child);
        }

        await expect(transform.call(ctx, VIEW_TWO_PROPS, paths.view)).resolves.toBeTruthy();
    });
});
