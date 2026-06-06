// Regression: the language service must type-check `.azeroth` against the
// CONSUMING project's tsconfig, including ambient/global declaration files that
// the project itself pulls in. The canonical case is a Vite app whose
// `src/vite-env.d.ts` carries `/// <reference types="vite/client" />`, which
// augments `ImportMeta` with `.env` and declares the `*.css` / `?url` modules.
// Those declarations live in a `.d.ts` the LS used to ignore (it only loaded
// `.azeroth` files), so `import.meta.env.X` wrongly reported
// "Property 'env' does not exist on type 'ImportMeta'".

import { describe, it, expect } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import path from 'node:path';

const FIXTURE = path.join(process.cwd(), 'test', 'language-service', 'fixtures', 'vite-env');
const tsconfig = path.join(FIXTURE, 'tsconfig.json');

function diagnose(source: string): string[]
{
    const ls = new AzerothLanguageService(FIXTURE, tsconfig);
    const uri = pathToUri(path.join(FIXTURE, 'src', 'probe.azeroth'));
    ls.didOpen(uri, source);
    return ls.getDiagnostics(uri).map(d => d.message);
}

describe('language service honors the consuming project tsconfig (ambient .d.ts)', () =>
{
    it('resolves import.meta.env via a vite-env.d.ts triple-slash reference', () =>
    {
        const messages = diagnose('const apiUrl = import.meta.env.VITE_API_URL;\nconst x = <p>{apiUrl}</p>;\n');
        expect(messages.join('\n')).not.toContain('does not exist on type \'ImportMeta\'');
        expect(messages).toEqual([]);
    });

    it('resolves a `?url` asset import declared by vite/client', () =>
    {
        const messages = diagnose('import logo from \'./logo.png?url\';\nconst x = <img src={logo} />;\n');
        // The only thing that could legitimately fail here is the ambient module
        // declaration being absent; with it loaded there are no diagnostics.
        expect(messages.join('\n')).not.toContain('Cannot find module');
    });

    it('still surfaces a genuine type error (sanity)', () =>
    {
        const messages = diagnose('const n: number = \'nope\';\nconst x = <p>{n}</p>;\n');
        expect(messages.join('\n')).toContain('not assignable');
    });
});
