// @vitest-environment node
/**
 * The incremental checker on the native TypeScript engine: a checked file is served from the
 * text the transform handed over, under one key per import spelling, and an invalidate puts
 * both keys back on the disk.
 *
 * The engine is picked once per process and any native failure downgrades the whole process to
 * the classic engine, so these cases live in their own file, prime their file set the way the
 * dev server does, and assert the native backend still answers on either side of them.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createIncrementalChecker } from '../src/typecheck-ts.ts';
import { createNativeIncrementalBackend } from '../src/native-check.ts';
import { loadNativeTs } from '../src/native-ts.ts';
import { generateVirtualCode } from '../src/project.ts';

// Inside the compiler package so a bare `azerothjs` import resolves through the workspace
// node_modules, which is what makes cross-file prop checking real.
const root = fileURLToPath(new URL('./.tmp-native', import.meta.url));

// Cross-file prop checking needs an EXPORTED child reached by a NAMED import: a default import
// or a child that is not exported degrades to `any` and every case below reports nothing.
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
const CHILD_NUMBER_LABEL = `export component Child(props: { label: number })
{
    <p>{ props.label }</p>
}
`;
const viewOf = (specifier: string, markup: string): string => `import { Child } from '${ specifier }';

component View
{
    ${ markup }
}
`;

const readAzeroth = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

interface Pair
{
    child: string;
    view: string;
}

const pairIn = (name: string, view: string): Pair =>
{
    const home = join(root, name);
    mkdirSync(home, { recursive: true });
    const paths = { child: join(home, 'child.azeroth'), view: join(home, 'view.azeroth') };
    writeFileSync(paths.child, CHILD_ONE_PROP);
    writeFileSync(paths.view, view);
    return paths;
};

// The classic engine answers whenever the native one cannot, which would leave every case here
// saying nothing about the backend it names. Asserted before and after the cases, since a native
// failure is sticky for the process.
const expectNativeAnswers = (name: string): void =>
{
    const probe = pairIn(name, viewOf('./child.azeroth', '<Child label="hi" />'));
    const backend = createNativeIncrementalBackend(readAzeroth);
    expect(backend).not.toBeNull();
    expect(backend?.check(`${ probe.child }.ts`, generateVirtualCode(CHILD_ONE_PROP).code)).not.toBeNull();
};

describe.skipIf(loadNativeTs() === null)('createIncrementalChecker - a changed file is checked from disk (native engine, skipped without the native TypeScript module)', () =>
{
    beforeAll(() =>
    {
        mkdirSync(root, { recursive: true });
        expectNativeAnswers('backend-before');
    });

    afterAll(() =>
    {
        expectNativeAnswers('backend-after');
        rmSync(root, { recursive: true, force: true });
    });

    it('accepts a consumer that passes the prop a child gained on disk, imported by .azeroth path', () =>
    {
        const source = viewOf('./child.azeroth', '<Child label="hi" tone="warm" />');
        const paths = pairIn('dot-adds', source);
        const checker = createIncrementalChecker();
        checker.prime([paths.child, paths.view]);
        expect(checker.check(paths.child, CHILD_ONE_PROP)).toHaveLength(0);

        writeFileSync(paths.child, CHILD_TWO_PROPS);
        checker.invalidate(paths.child);
        expect(checker.check(paths.view, source)).toHaveLength(0);
    });

    it('refuses the old value after the child prop type changed on disk, imported by .azeroth path', () =>
    {
        const source = viewOf('./child.azeroth', '<Child label="hi" />');
        const paths = pairIn('dot-type', source);
        const checker = createIncrementalChecker();
        checker.prime([paths.child, paths.view]);
        expect(checker.check(paths.child, CHILD_ONE_PROP)).toHaveLength(0);

        writeFileSync(paths.child, CHILD_NUMBER_LABEL);
        checker.invalidate(paths.child);
        const diagnostics = checker.check(paths.view, source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
        expect(diagnostics[0]!.message).toContain('number');
    });

    it('accepts a consumer that passes the prop a child gained on disk, imported without an extension', () =>
    {
        const source = viewOf('./child', '<Child label="hi" tone="warm" />');
        const paths = pairIn('bare-adds', source);
        const checker = createIncrementalChecker();
        checker.prime([paths.child, paths.view]);
        expect(checker.check(paths.child, CHILD_ONE_PROP)).toHaveLength(0);

        writeFileSync(paths.child, CHILD_TWO_PROPS);
        checker.invalidate(paths.child);
        expect(checker.check(paths.view, source)).toHaveLength(0);

        // A later check of the child does not feed this spelling; the consumer keeps reading the disk.
        expect(checker.check(paths.child, CHILD_TWO_PROPS)).toHaveLength(0);
        expect(checker.check(paths.view, source)).toHaveLength(0);
    });

    it('leaves a sibling module alone when a file whose stem ends in .azeroth changes', () =>
    {
        const source = viewOf('./child.azeroth', '<Child label="hi" tone="warm" />');
        const paths = pairIn('doubled-stem', source);
        const sibling = join(root, 'doubled-stem', 'child.azeroth.azeroth');
        writeFileSync(sibling, CHILD_ONE_PROP);
        const checker = createIncrementalChecker();
        checker.prime([paths.child, paths.view, sibling]);
        // The child's live copy carries a prop its disk text does not, and only the sibling changes.
        expect(checker.check(paths.child, CHILD_TWO_PROPS)).toHaveLength(0);
        expect(checker.check(paths.view, source)).toHaveLength(0);

        writeFileSync(sibling, CHILD_NUMBER_LABEL);
        checker.invalidate(sibling);
        expect(checker.check(paths.view, source)).toHaveLength(0);
    });

    it('refuses the old value after the child prop type changed on disk, imported without an extension', () =>
    {
        const source = viewOf('./child', '<Child label="hi" />');
        const paths = pairIn('bare-type', source);
        const checker = createIncrementalChecker();
        checker.prime([paths.child, paths.view]);
        expect(checker.check(paths.child, CHILD_ONE_PROP)).toHaveLength(0);

        writeFileSync(paths.child, CHILD_NUMBER_LABEL);
        checker.invalidate(paths.child);
        const diagnostics = checker.check(paths.view, source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.code).toBe('azeroth/prop-type');
        expect(diagnostics[0]!.message).toContain('number');
    });
});
