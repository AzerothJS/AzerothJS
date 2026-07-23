// @vitest-environment node
//
// The shape-detection rules, pinned against real fixture trees: leaf
// classification (frontend / backend native vs built / library / none), the fullstack
// root probe (conventional names, then a scan), and the ambiguity-fails-loud contract.

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { detectProject, classifyLeaf } from '../src/detect.ts';
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

describe('leaf classification', () =>
{
    it('a vite config + the umbrella package is a frontend', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ azerothjs: '^0.9.0' }));
        write(dir, 'vite.config.ts', 'export default {}');
        expect(detectProject(dir).kind).toBe('frontend');
    });

    it('a vite config without any azeroth frontend dependency is not an azeroth project', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ vite: '^7.0.0' }));
        write(dir, 'vite.config.ts', 'export default {}');
        expect(detectProject(dir).kind).toBe('none');
    });

    it('an @azerothjs/http dependency without vite is a NATIVE backend with its entry', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0' }));
        write(dir, 'src/main.ts', '');
        const project = detectProject(dir);
        expect(project).toMatchObject({ kind: 'backend', build: 'native', entry: 'src/main.ts', builtEntry: null });
    });

    it('a decorator ORM dependency makes the backend BUILT (tsc must emit first)', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0', typeorm: '^0.3.0' }));
        write(dir, 'src/main.ts', '');
        write(dir, 'tsconfig.json', '{ "compilerOptions": { "outDir": "dist" } }');
        const project = detectProject(dir);
        expect(project).toMatchObject({ kind: 'backend', build: 'built', builtEntry: 'dist/main.js' });
    });

    it('emitDecoratorMetadata in a commented JSONC tsconfig is detected too', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0' }));
        write(dir, 'src/main.ts', '');
        write(dir, 'tsconfig.json', '{\n  // decorators for the ORM\n  "compilerOptions": {\n    "emitDecoratorMetadata": true,\n    "outDir": "./out/"\n  }\n}');
        const project = detectProject(dir);
        expect(project).toMatchObject({ kind: 'backend', build: 'built', builtEntry: 'out/main.js' });
    });

    it('a backend with no recognizable entry fails loud, naming the probes', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/http': '^0.9.0' }));
        const project = detectProject(dir);
        expect(project.kind).toBe('none');
        expect(project.kind === 'none' ? project.reason : '').toContain('src/main.ts');
    });

    it('azeroth deps behind an exports field classify as a library', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ '@azerothjs/reactivity': '^0.9.0' }, { exports: { '.': './dist/index.js' } }));
        expect(detectProject(dir).kind).toBe('library');
    });

    it('a package with no azeroth signals is none', () =>
    {
        const dir = root();
        write(dir, 'package.json', packageJson({ express: '^4.0.0' }));
        expect(classifyLeaf(dir).kind).toBe('none');
    });
});

describe('the fullstack root probe', () =>
{
    function scaffoldFrontend(dir: string, rel: string): void
    {
        write(dir, `${ rel }/package.json`, packageJson({ azerothjs: '^0.9.0' }));
        write(dir, `${ rel }/vite.config.ts`, 'export default {}');
    }
    function scaffoldBackend(dir: string, rel: string): void
    {
        write(dir, `${ rel }/package.json`, packageJson({ '@azerothjs/http': '^0.9.0' }));
        write(dir, `${ rel }/src/main.ts`, '');
    }

    it('a root with conventional application/ + server/ children is fullstack', () =>
    {
        const dir = root();
        scaffoldFrontend(dir, 'application');
        scaffoldBackend(dir, 'server');
        const project = detectProject(dir);
        expect(project.kind).toBe('fullstack');
        if (project.kind === 'fullstack')
        {
            expect(project.app.dir).toBe(join(dir, 'application'));
            expect(project.server.dir).toBe(join(dir, 'server'));
        }
    });

    it('unconventional child names are found by the scan', () =>
    {
        const dir = root();
        scaffoldFrontend(dir, 'ui');
        scaffoldBackend(dir, 'svc');
        expect(detectProject(dir).kind).toBe('fullstack');
    });

    it('a frontend child beside a non-azeroth server (the NestJS case) is NOT fullstack', () =>
    {
        const dir = root();
        scaffoldFrontend(dir, 'website');
        write(dir, 'server/package.json', packageJson({ '@nestjs/core': '^10.0.0' }));
        const project = detectProject(dir);
        expect(project.kind).toBe('none');
        expect(project.kind === 'none' ? project.reason : '').toContain('--app');
    });

    it('two backend children is ambiguity, and ambiguity fails loud', () =>
    {
        const dir = root();
        scaffoldFrontend(dir, 'application');
        scaffoldBackend(dir, 'server');
        scaffoldBackend(dir, 'api');
        expect(detectProject(dir).kind).toBe('none');
    });

    it('--app/--server overrides resolve the ambiguity', () =>
    {
        const dir = root();
        scaffoldFrontend(dir, 'application');
        scaffoldBackend(dir, 'server');
        scaffoldBackend(dir, 'api');
        const project = detectProject(dir, { app: 'application', server: 'api' });
        expect(project.kind).toBe('fullstack');
        if (project.kind === 'fullstack')
        {
            expect(project.server.dir).toBe(join(dir, 'api'));
        }
    });

    it('an override pointing at the wrong shape is rejected with the classification', () =>
    {
        const dir = root();
        scaffoldFrontend(dir, 'application');
        scaffoldBackend(dir, 'server');
        const project = detectProject(dir, { app: 'server', server: 'application' });
        expect(project.kind).toBe('none');
        expect(project.kind === 'none' ? project.reason : '').toContain('--app');
    });

    it('one override without the other is a usage error', () =>
    {
        const dir = root();
        const project = detectProject(dir, { app: 'application', server: null });
        expect(project.kind).toBe('none');
        expect(project.kind === 'none' ? project.reason : '').toContain('together');
    });
});
