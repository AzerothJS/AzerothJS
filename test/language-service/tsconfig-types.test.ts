// Regression: the language service must honor `compilerOptions.types` the same
// way `tsc` does, even when the project has NO `src/vite-env.d.ts` triple-slash
// reference. A Vite app commonly sets `"types": ["vite/client"]` instead of the
// vite-env.d.ts file; that package augments `ImportMeta` with `.env` and
// declares the `*.png` / `?url` asset modules. Without resolving `types`, a
// `.azeroth` file would get phantom diagnostics that `tsc` never reports.

import { describe, it, expect } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import path from 'node:path';

const FIXTURE = path.join(process.cwd(), 'test', 'language-service', 'fixtures', 'vite-types');
const tsconfig = path.join(FIXTURE, 'tsconfig.json');

function diagnose(source: string): string[]
{
    const ls = new AzerothLanguageService(FIXTURE, tsconfig);
    const uri = pathToUri(path.join(FIXTURE, 'probe.azeroth'));
    ls.didOpen(uri, source);
    return ls.getDiagnostics(uri).map(d => d.message);
}

describe('language service honors compilerOptions.types (no vite-env.d.ts)', () =>
{
    it('resolves import.meta.env from `types: ["vite/client"]`', () =>
    {
        const messages = diagnose('const apiUrl = import.meta.env.VITE_API_URL;\nconst x = <p>{apiUrl}</p>;\n');
        expect(messages.join('\n')).not.toContain('does not exist on type \'ImportMeta\'');
        expect(messages).toEqual([]);
    });

    it('resolves a `*.png` asset import declared by vite/client', () =>
    {
        const messages = diagnose('import logo from \'./logo.png\';\nconst x = <img src={logo} />;\n');
        expect(messages.join('\n')).not.toContain('Cannot find module');
    });

    it('resolves a `?url` asset import declared by vite/client', () =>
    {
        const messages = diagnose('import u from \'./a.svg?url\';\nconst x = <img src={u} />;\n');
        expect(messages.join('\n')).not.toContain('Cannot find module');
    });

    it('still surfaces a genuine type error (sanity)', () =>
    {
        const messages = diagnose('const n: number = \'nope\';\nconst x = <p>{n}</p>;\n');
        expect(messages.join('\n')).toContain('not assignable');
    });
});
