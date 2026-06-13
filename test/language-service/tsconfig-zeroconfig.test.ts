// Zero-config Vite: `import.meta.env` and asset imports (*.png, ?url, ?raw,
// *.svg) must resolve inside `.azeroth` with NO `src/vite-env.d.ts` AND NO
// `"types": ["vite/client"]` tsconfig entry - the language service discovers
// `vite/client` itself when Vite is installed. This is what lets a consuming app
// delete BOTH workarounds.

import { describe, it, expect } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import path from 'node:path';

const FIXTURE = path.join(process.cwd(), 'test', 'language-service', 'fixtures', 'vite-zeroconfig');
const tsconfig = path.join(FIXTURE, 'tsconfig.json');

function diagnose(source: string): string[]
{
    const ls = new AzerothLanguageService(FIXTURE, tsconfig);
    const uri = pathToUri(path.join(FIXTURE, 'probe.azeroth'));
    ls.didOpen(uri, source);
    return ls.getDiagnostics(uri).map(d => d.message);
}

describe('zero-config Vite ambient types in .azeroth (no vite-env.d.ts, no types entry)', () =>
{
    it('resolves import.meta.env.X', () =>
    {
        const messages = diagnose('const url = import.meta.env.VITE_API_URL;\nconst x = <p>{url}</p>;\n');
        expect(messages.join('\n')).not.toContain('does not exist on type \'ImportMeta\'');
        expect(messages).toEqual([]);
    });

    it('resolves a *.png asset import', () =>
    {
        const messages = diagnose('import logo from \'./logo.png\';\nconst x = <img src={logo} />;\n');
        expect(messages.join('\n')).not.toContain('Cannot find module');
    });

    it('resolves a ?url asset import', () =>
    {
        const messages = diagnose('import sheet from \'./styles.css?url\';\nconst x = <link href={sheet} />;\n');
        expect(messages.join('\n')).not.toContain('Cannot find module');
    });

    it('still reports a genuine type error', () =>
    {
        const messages = diagnose('const n: number = \'no\';\nconst x = <p>{n}</p>;\n');
        expect(messages.join('\n')).toContain('not assignable');
    });
});
