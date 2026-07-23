// @vitest-environment node
//
// The doctor catalog: each check is a distilled real incident, so the tests pin the
// diagnosis, not just the plumbing - the strip-only ORM trap fails, the TS2591 setup
// warns, fullstack version skew warns, and clean setups pass.

import { describe, it, expect, afterEach } from 'vitest';
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

describe('general behavior', () =>
{
    it('the node version check passes on the running node (>= 24 in this repo)', () =>
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
