// @vitest-environment node
//
// The doctor catalog: each check is a distilled real incident, so the tests pin the
// diagnosis, not just the plumbing - the strip-only ORM trap fails, the TS2591 setup
// warns, fullstack version skew warns, and clean setups pass.

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { detectProject } from '../src/detect.ts';
import { runDoctor } from '../src/doctor.ts';
import { makeRoot, write, cleanup, packageJson } from './fixtures.ts';

const roots: string[] = [];
function root(): string
{
    const dir = makeRoot();
    roots.push(dir);
    return dir;
}
afterEach(() =>
{
    while (roots.length > 0)
    {
        cleanup(roots.pop() ?? '');
    }
});

function resultFor(results: ReturnType<typeof runDoctor>, name: string): ReturnType<typeof runDoctor>[number] | undefined
{
    return results.find((result) => result.name === name);
}

describe('the strip-only trap', () =>
{
    it('typeorm without emitDecoratorMetadata FAILS - metadata cannot exist under strip-only node', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0', typeorm: '^0.3.0' }));
        write(dir, 'src/main.ts', '');
        write(dir, 'tsconfig.json', '{ "compilerOptions": { "outDir": "dist" } }');
        const result = resultFor(runDoctor(detectProject(dir)), 'strip-only trap');
        expect(result?.status).toBe('fail');
        expect(result?.detail).toContain('emitDecoratorMetadata');
    });

    it('typeorm WITH emitDecoratorMetadata passes - the build step is configured', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0', typeorm: '^0.3.0' }));
        write(dir, 'src/main.ts', '');
        write(dir, 'tsconfig.json', '{ "compilerOptions": { "emitDecoratorMetadata": true, "outDir": "dist" } }');
        expect(resultFor(runDoctor(detectProject(dir)), 'strip-only trap')?.status).toBe('ok');
    });

    it('no decorator ORM at all is ok', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0' }));
        write(dir, 'src/main.ts', '');
        expect(resultFor(runDoctor(detectProject(dir)), 'strip-only trap')?.status).toBe('ok');
    });
});

describe('the TS2591 setup (@types/node)', () =>
{
    it('neither @types/node nor types:["node"] warns', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0' }));
        write(dir, 'src/main.ts', '');
        const result = resultFor(runDoctor(detectProject(dir)), '@types/node');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('TS2591');
    });

    it('a types:["node"] tsconfig passes', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0' }));
        write(dir, 'src/main.ts', '');
        write(dir, 'tsconfig.json', '{ "compilerOptions": { "types": ["node"] } }');
        expect(resultFor(runDoctor(detectProject(dir)), '@types/node')?.status).toBe('ok');
    });

    it('an @types/node devDependency passes', () =>
    {
        const dir = root();
        write(dir, 'package.json', JSON.stringify({
            name: 'fixture',
            dependencies: { '@azerothjs/http': '^0.9.0' },
            devDependencies: { '@types/node': '^24.0.0' }
        }));
        write(dir, 'src/main.ts', '');
        expect(resultFor(runDoctor(detectProject(dir)), '@types/node')?.status).toBe('ok');
    });
});

describe('fullstack version skew', () =>
{
    function scaffold(dir: string, appVersion: string, serverVersion: string): void
    {
        write(dir, 'application/package.json', packageJson({ azerothjs: appVersion }));
        write(dir, 'application/vite.config.ts', 'export default {}');
        write(dir, 'server/package.json', packageJson({ '@azerothjs/http': serverVersion }));
        write(dir, 'server/src/main.ts', '');
    }

    it('differing @azerothjs/* ranges across the halves warn', () =>
    {
        const dir = root();
        scaffold(dir, '^0.9.0-beta.4', '^0.9.0-beta.2');
        const result = resultFor(runDoctor(detectProject(dir)), 'version skew');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('lockstep');
    });

    it('one version family across both halves is ok', () =>
    {
        const dir = root();
        scaffold(dir, '^0.9.0-beta.4', '^0.9.0-beta.4');
        expect(resultFor(runDoctor(detectProject(dir)), 'version skew')?.status).toBe('ok');
    });
});

describe('spawn hazards', () =>
{
    function project(dir: string, script: string): void
    {
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^1.0.0' }));
        write(dir, 'src/main.ts', '');
        write(dir, 'scripts/build.mjs', script);
    }

    it('a file that only NAMES the hazard in a comment is not one', () =>
    {
        const dir = root();
        // The repo's own release script reads exactly like this: it explains shell: true
        // in prose and then spawns without a shell.
        project(dir, [
            '// Never pass shell: true with an args array - DEP0190 concatenates without quoting.',
            'execFileSync(\'git\', [\'status\'], { shell: false });'
        ].join('\n'));
        const result = resultFor(runDoctor(detectProject(dir)), 'spawn hazards');
        expect(result?.status).toBe('ok');
    });

    it('shell: true in a spawn call\'s own options warns', () =>
    {
        const dir = root();
        project(dir, 'spawnSync(\'npm\', [\'run\', \'build\'], {\n    cwd,\n    shell: true\n});');
        const result = resultFor(runDoctor(detectProject(dir)), 'spawn hazards');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('build.mjs');
    });

    it('the async spawners count too - the hazard is the call, not the name', () =>
    {
        const dir = root();
        project(dir, 'execFile(process.execPath, [script], { shell: true }, done);');
        expect(resultFor(runDoctor(detectProject(dir)), 'spawn hazards')?.status).toBe('warn');
    });
});

describe('general behavior', () =>
{
    it('the node version check passes on the running node (>= 22.18 native-TS floor)', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0' }));
        write(dir, 'src/main.ts', '');
        expect(resultFor(runDoctor(detectProject(dir)), 'node version')?.status).toBe('ok');
    });

    it('diagnosing a non-project reports it and never throws', () =>
    {
        const dir = root();
        const results = runDoctor(detectProject(dir));
        expect(results.some((result) => result.status === 'fail')).toBe(false);
    });
});

describe('the one-process dev session', () =>
{
    interface DevTree
    {
        capability: boolean;
        appVite: string | null;
        serverVite: string | null;
        installedVite: string | null;
        entry: string;
    }

    // A real tree: the halves, the root manifest, and the @azerothjs/kit whose own directory
    // is where node resolves the vite the dev session loads.
    function devTree(dir: string, tree: DevTree): void
    {
        write(dir, 'package.json', JSON.stringify(tree.capability
            ? { name: 'fixture', azeroth: { dev: 'server' } }
            : { name: 'fixture' }));
        write(dir, 'application/package.json', JSON.stringify({
            name: 'app',
            dependencies: { azerothjs: '^2.1.0' },
            devDependencies: tree.appVite === null ? {} : { vite: tree.appVite }
        }));
        write(dir, 'application/vite.config.ts', 'export default {}');
        write(dir, 'server/package.json', JSON.stringify({
            name: 'server',
            dependencies: { '@azerothjs/http': '^2.1.0' },
            devDependencies: tree.serverVite === null ? {} : { vite: tree.serverVite }
        }));
        write(dir, 'server/src/main.ts', tree.entry);
        write(dir, 'node_modules/@azerothjs/kit/package.json', JSON.stringify({ name: '@azerothjs/kit', version: '2.1.0' }));
        if (tree.installedVite !== null)
        {
            write(dir, 'node_modules/vite/package.json', JSON.stringify({ name: 'vite', version: tree.installedVite }));
        }
    }

    const WIRED = 'const { devPages } = await import(\'@azerothjs/kit/dev\');';
    const UNWIRED = 'import { serve } from \'@azerothjs/http/node\';';

    it('a declared capability the server entry never wires up WARNS - nothing would serve the pages', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: '^8.1.5', serverVite: '^8.1.5', installedVite: '8.1.5', entry: UNWIRED });
        const result = resultFor(runDoctor(detectProject(dir)), 'dev capability');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('@azerothjs/kit/dev');
    });

    it('an entry that imports the dev session - dynamically counts - is ok', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: '^8.1.5', serverVite: '^8.1.5', installedVite: '8.1.5', entry: WIRED });
        expect(resultFor(runDoctor(detectProject(dir)), 'dev capability')?.status).toBe('ok');
    });

    it('a root that never declares the capability is a skip, not a verdict', () =>
    {
        const dir = root();
        devTree(dir, { capability: false, appVite: '^8.1.5', serverVite: '^8.1.5', installedVite: '8.1.5', entry: UNWIRED });
        expect(resultFor(runDoctor(detectProject(dir)), 'dev capability')?.status).toBe('skip');
    });

    it('reports the copy the session loads by PATH and version, through the kit rather than a lexical walk', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: null, serverVite: null, installedVite: '8.1.5', entry: WIRED });
        const result = resultFor(runDoctor(detectProject(dir)), 'dev vite');
        expect(result?.detail).toContain('v8.1.5');
        expect(result?.detail).toContain(join('node_modules', 'vite'));
        // A root-hoisted copy neither half declares: reported, and warned about, by name.
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('app none, server none');
    });

    it('vite ranges that differ between the halves warn - one install hoists one copy', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: '^8.1.5', serverVite: '^8.0.0', installedVite: '8.1.5', entry: WIRED });
        const result = resultFor(runDoctor(detectProject(dir)), 'dev vite');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('different vite ranges');
    });

    it('the halves agreeing on a vite 8 the kit resolves is ok', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: '^8.1.5', serverVite: '^8.1.5', installedVite: '8.1.5', entry: WIRED });
        const result = resultFor(runDoctor(detectProject(dir)), 'dev vite');
        expect(result?.status).toBe('ok');
        expect(result?.detail).toContain('v8.1.5');
    });

    it('a loaded major the session refuses at startup warns here first', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: '^7.0.0', serverVite: '^7.0.0', installedVite: '7.9.0', entry: WIRED });
        const result = resultFor(runDoctor(detectProject(dir)), 'dev vite');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('vite 8');
    });

    it('no vite above the kit at all is a skip that says so', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: null, serverVite: null, installedVite: null, entry: WIRED });
        const result = resultFor(runDoctor(detectProject(dir)), 'dev vite');
        expect(result?.status).toBe('skip');
        expect(result?.detail).toContain('vite does not resolve');
    });

    it('a vite inside the app half does not change the copy the kit resolves', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: '^7.0.0', serverVite: '^7.0.0', installedVite: '8.1.5', entry: WIRED });
        // A lexical walk from the application half answers this copy; the session loads the
        // one node resolves from the kit, which is the root-hoisted 8.1.5.
        write(dir, 'application/node_modules/vite/package.json', JSON.stringify({ name: 'vite', version: '7.0.0' }));
        const result = resultFor(runDoctor(detectProject(dir)), 'dev vite');
        expect(result?.detail).toContain('v8.1.5');
        expect(result?.detail).not.toContain(join('application', 'node_modules'));
    });

    it('run from a half rather than the root, both checks say root only', () =>
    {
        const dir = root();
        devTree(dir, { capability: true, appVite: '^8.1.5', serverVite: '^8.1.5', installedVite: '8.1.5', entry: WIRED });
        const results = runDoctor(detectProject(join(dir, 'server')));
        expect(resultFor(results, 'dev capability')?.detail).toContain('root only');
        expect(resultFor(results, 'dev vite')?.detail).toContain('root only');
    });
});
